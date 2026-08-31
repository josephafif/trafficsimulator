/**
 * Korsningsmodell: svängrörelser, konfliktpunkter och företrädesordning.
 *
 * Varje tillåten rörelse genom en korsning blir en "connection" från ett
 * inkommande körfält till ett utgående. Två rörelser som korsar varandra
 * geometriskt får en konfliktrelation, och företrädesreglerna avgör vem av dem
 * som måste lämna företräde. Svenska regler som modelleras:
 *
 *  - Huvudled före anslutande gata (klassificeringen ger huvudleden)
 *  - Högerregeln mellan likvärdiga gator
 *  - Väjningsplikt vid utfart från cirkulationsplats-tillfart
 *  - Vänstersväng lämnar företräde åt mötande (även vid grönt — permissiv vänstersväng)
 *  - Stopplikt och väjningsplikt från OSM-taggar
 */

import { angleDiff } from '../core/geo.ts';
import { NodeControl, Turn, turnFromAngle, TURN_ANY } from '../osm/tags.ts';
import { laneOffset, posOnLink, type RoadNetwork } from '../osm/network.ts';

export const YieldKind = {
  /** Har företräde — kör utan att söka lucka. */
  Major: 0,
  /** Väjningsplikt — söker lucka men behöver inte stanna. */
  Give: 1,
  /** Stopplikt — måste stanna helt innan luckan söks. */
  Stop: 2,
} as const;
export type YieldKind = (typeof YieldKind)[keyof typeof YieldKind];

export interface Movements {
  connCount: number;
  connNode: Int32Array;
  connFromLink: Int32Array;
  connToLink: Int32Array;
  connFromLane: Uint8Array;
  connToLane: Uint8Array;
  connTurn: Uint16Array;
  connLength: Float32Array;
  connYield: Uint8Array;
  /**
   * Vänstersväng från ett eget vänstersvängfält i en signalkorsning. Den körs
   * skyddat — egen fas istället för att söka lucka i den mötande strömmen.
   */
  connProtected: Uint8Array;
  /** Signalgrupp, sätts av signals.ts. -1 = osignalerad. */
  connSignalGroup: Int16Array;

  /** Globalt körfältsindex: laneBase[link] + lane. */
  laneBase: Int32Array;
  laneCount: number;
  /** CSR: rörelser som utgår från ett givet körfält. */
  laneConnStart: Int32Array;
  laneConn: Int32Array;
  /** CSR: rörelser som mynnar ut i ett givet körfält. */
  laneInStart: Int32Array;
  laneIn: Int32Array;

  /** CSR: rörelser som den här rörelsen måste lämna företräde åt. */
  yieldToStart: Int32Array;
  yieldTo: Int32Array;
  /** CSR: alla korsande rörelser, oavsett vem som väjer (används av signalfaser). */
  conflictStart: Int32Array;
  conflict: Int32Array;

  /** CSR: rörelser vid en given nod. */
  nodeConnStart: Int32Array;
  nodeConn: Int32Array;

  /** Bezier-samplad bana genom korsningen. */
  connGeomStart: Int32Array;
  connGeomX: Float32Array;
  connGeomY: Float32Array;
  connGeomCum: Float32Array;

  /** Avstånd som klipps bort i varje länkände för att ge korsningen en yta. */
  linkStartOff: Float32Array;
  linkDriveLen: Float32Array;

  /**
   * Den gata som är huvudled genom noden, som namn-id (eller negativt way-id för
   * namnlösa gator). -1 betyder att ingen gata sticker ut och att högerregeln
   * gäller mellan alla tillfarter.
   */
  nodeMajorStreet: Int32Array;
}

const CONN_SAMPLES = 6;

export function buildMovements(net: RoadNetwork): Movements {
  const { linkCount, nodeCount } = net;

  // --- Körfältsindexering --------------------------------------------------------
  const laneBase = new Int32Array(linkCount + 1);
  for (let i = 0; i < linkCount; i++) laneBase[i + 1] = laneBase[i] + net.linkLanes[i];
  const laneCount = laneBase[linkCount];

  // --- Korsningsytor: klipp länkändarna ------------------------------------------
  const linkStartOff = new Float32Array(linkCount);
  const linkDriveLen = new Float32Array(linkCount);
  computeSetbacks(net, linkStartOff, linkDriveLen);

  // --- Svängförbud indexerade på (wayId, nod) ------------------------------------
  const noTurn = new Set<string>();
  const onlyTurn = new Map<string, number>();
  for (const r of net.restrictions) {
    const key = r.fromWay + '@' + r.viaNode;
    if (r.prohibitive) noTurn.add(key + '>' + r.toWay);
    else onlyTurn.set(key, r.toWay);
  }

  // --- Bygg rörelser per nod ------------------------------------------------------
  const cFromLink: number[] = [];
  const cToLink: number[] = [];
  const cFromLane: number[] = [];
  const cToLane: number[] = [];
  const cTurn: number[] = [];
  const cNode: number[] = [];
  const cProtected: number[] = [];

  const nodeConnStart = new Int32Array(nodeCount + 1);

  for (let n = 0; n < nodeCount; n++) {
    nodeConnStart[n] = cFromLink.length;
    const inS = net.nodeInStart[n];
    const inE = net.nodeInStart[n + 1];
    const outS = net.nodeOutStart[n];
    const outE = net.nodeOutStart[n + 1];
    if (inE === inS || outE === outS) continue;

    const outLinks: number[] = [];
    for (let k = outS; k < outE; k++) outLinks.push(net.nodeOut[k]);

    for (let k = inS; k < inE; k++) {
      const il = net.nodeIn[k];
      const rev = net.linkReverse[il];
      const restrictKey = net.linkWayId[il] + '@' + net.nodeOsmId[n];
      const onlyTo = onlyTurn.get(restrictKey);

      // Tillåtna målänkar med sin svängtyp, sorterade höger -> rakt -> vänster.
      const moves: { link: number; turn: number; delta: number }[] = [];
      for (const ol of outLinks) {
        if (ol === rev) continue; // U-sväng tillbaka samma gata
        if (noTurn.has(restrictKey + '>' + net.linkWayId[ol])) continue;
        if (onlyTo !== undefined && net.linkWayId[ol] !== onlyTo) continue;
        const delta = angleDiff(net.linkHeadIn[il], net.linkHeadOut[ol]);
        moves.push({ link: ol, turn: turnFromAngle(delta), delta });
      }

      if (moves.length === 0) {
        // Återvändsgränd: tillåt U-sväng så fordon inte fastnar för alltid.
        if (rev >= 0 && net.linkTo[rev] !== n) {
          moves.push({ link: rev, turn: Turn.Reverse, delta: Math.PI });
        } else continue;
      }

      // delta > 0 = vänster. Sortering stigande ger höger först = körfält 0 först.
      moves.sort((a, b) => a.delta - b.delta);

      const signalised = net.nodeControl[n] === NodeControl.Signal;
      assignLanes(
        net, il, moves, cFromLink, cToLink, cFromLane, cToLane, cTurn, cNode, cProtected, n, signalised,
      );
    }
  }
  nodeConnStart[nodeCount] = cFromLink.length;

  const connCount = cFromLink.length;
  const mv: Movements = {
    connCount,
    connNode: Int32Array.from(cNode),
    connFromLink: Int32Array.from(cFromLink),
    connToLink: Int32Array.from(cToLink),
    connFromLane: Uint8Array.from(cFromLane),
    connToLane: Uint8Array.from(cToLane),
    connTurn: Uint16Array.from(cTurn),
    connLength: new Float32Array(connCount),
    connYield: new Uint8Array(connCount),
    connProtected: Uint8Array.from(cProtected),
    connSignalGroup: new Int16Array(connCount).fill(-1),
    laneBase,
    laneCount,
    laneConnStart: new Int32Array(laneCount + 1),
    laneConn: new Int32Array(connCount),
    laneInStart: new Int32Array(laneCount + 1),
    laneIn: new Int32Array(connCount),
    yieldToStart: new Int32Array(connCount + 1),
    yieldTo: new Int32Array(0),
    conflictStart: new Int32Array(connCount + 1),
    conflict: new Int32Array(0),
    nodeConnStart,
    nodeConn: new Int32Array(connCount),
    connGeomStart: new Int32Array(connCount + 1),
    connGeomX: new Float32Array(connCount * CONN_SAMPLES),
    connGeomY: new Float32Array(connCount * CONN_SAMPLES),
    connGeomCum: new Float32Array(connCount * CONN_SAMPLES),
    linkStartOff,
    linkDriveLen,
    nodeMajorStreet: findMajorStreets(net),
  };

  for (let c = 0; c < connCount; c++) mv.nodeConn[c] = c;

  buildLaneIndex(mv);
  buildConnGeometry(net, mv);
  buildConflicts(net, mv);
  return mv;
}

/**
 * Pekar ut huvudleden genom varje osignalerad korsning.
 *
 * Högerregeln gäller bara mellan likvärdiga gator. I ett svenskt stadsnät är
 * nästan varje korsning i praktiken skyltad med en genomgående huvudled, och
 * OSM taggar det sällan. Utan det här steget får varenda korsning i innerstaden
 * fyra tillfarter som väjer för varandra i ring, och kapaciteten faller till en
 * bråkdel av vad gatan faktiskt klarar.
 *
 * Huvudleden pekas ut efter körfält, skyltad hastighet och om gatan har namn —
 * samma sak som en trafikingenjör väger in.
 */
function findMajorStreets(net: RoadNetwork): Int32Array {
  const out = new Int32Array(net.nodeCount).fill(-1);
  const score = new Map<number, number>();

  for (let n = 0; n < net.nodeCount; n++) {
    if (net.nodeControl[n] === NodeControl.Signal) continue;
    if (net.nodeControl[n] === NodeControl.Roundabout) continue;
    score.clear();

    for (let k = net.nodeInStart[n]; k < net.nodeInStart[n + 1]; k++) {
      const l = net.nodeIn[k];
      const street = streetKey(net, l);
      const s =
        net.linkPriority[l] * 1000 +
        net.linkLanes[l] * 120 +
        net.linkSpeed[l] * 3.6 +
        (net.linkNameId[l] > 0 ? 25 : 0);
      score.set(street, Math.max(score.get(street) ?? 0, s));
    }
    if (score.size < 2) continue;

    let best = -1;
    let bestScore = -1;
    let runnerUp = -1;
    for (const [street, s] of score) {
      if (s > bestScore) {
        runnerUp = bestScore;
        bestScore = s;
        best = street;
      } else if (s > runnerUp) runnerUp = s;
    }
    // Skiljer de sig knappt åt är gatorna likvärdiga och högerregeln gäller.
    if (bestScore - runnerUp < 30) continue;
    out[n] = best;
  }
  return out;
}

/** Identitet för den gata en länk tillhör: namnet, annars way-id. */
function streetKey(net: RoadNetwork, link: number): number {
  const name = net.linkNameId[link];
  return name > 0 ? name : -Math.abs(net.linkWayId[link] % 1e9) - 1;
}

/**
 * Korsningen får en yta genom att varje anslutande länk klipps av på ett avstånd
 * som motsvarar de korsande vägarnas halva bredd. Utan det ligger alla länkändar
 * i exakt samma punkt och konfliktzonerna blir degenererade.
 */
function computeSetbacks(net: RoadNetwork, startOff: Float32Array, driveLen: Float32Array): void {
  const radius = new Float32Array(net.nodeCount);
  for (let i = 0; i < net.linkCount; i++) {
    const halfWidth = (net.linkLanes[i] * net.linkLaneWidth[i]) / 2;
    const rev = net.linkReverse[i];
    const w = rev >= 0 ? halfWidth * 2 : halfWidth;
    const a = net.linkFrom[i];
    const b = net.linkTo[i];
    if (w > radius[a]) radius[a] = w;
    if (w > radius[b]) radius[b] = w;
  }

  for (let i = 0; i < net.linkCount; i++) {
    const len = net.linkLength[i];
    const deg = (n: number) =>
      net.nodeInStart[n + 1] - net.nodeInStart[n] + net.nodeOutStart[n + 1] - net.nodeOutStart[n];

    // Ändpunkter i nätets kant ska inte klippas — där släpps trafik in och ut.
    const a = net.linkFrom[i];
    const b = net.linkTo[i];
    let s = deg(a) > 2 ? radius[a] : 0;
    let e = deg(b) > 2 ? radius[b] : 0;

    // Klipp aldrig bort mer än 70 % av länken; korta länkar mellan täta korsningar
    // måste behålla åtminstone en fordonslängd att köra på.
    const maxCut = len * 0.7;
    if (s + e > maxCut) {
      const scale = maxCut / (s + e);
      s *= scale;
      e *= scale;
    }
    startOff[i] = s;
    driveLen[i] = Math.max(len - s - e, 1);
  }
}

/**
 * Fördelar inkommande körfält på svängrörelser. Utan `turn:lanes` används samma
 * monotona fördelning som verkliga körfältspilar följer: högersvängar närmast
 * höger kant, vänstersvängar närmast mitten, raka rörelser däremellan.
 */
function assignLanes(
  net: RoadNetwork,
  il: number,
  moves: { link: number; turn: number; delta: number }[],
  cFromLink: number[],
  cToLink: number[],
  cFromLane: number[],
  cToLane: number[],
  cTurn: number[],
  cNode: number[],
  cProtected: number[],
  node: number,
  signalised: boolean,
): void {
  const L = net.linkLanes[il];
  const M = moves.length;
  const tagged = net.linkTurnLanes[il];

  const emit = (fromLane: number, m: { link: number; turn: number }, protectedLeft = false): void => {
    const L2 = net.linkLanes[m.link];
    let toLane: number;
    if (m.turn === Turn.Left || m.turn === Turn.SlightLeft) {
      // Vänstersväng: mittersta fältet in i mittersta fältet ut.
      toLane = Math.min(L2 - 1, Math.max(0, L2 - 1 - (L - 1 - fromLane)));
    } else if (m.turn === Turn.Right || m.turn === Turn.SlightRight) {
      toLane = Math.min(L2 - 1, fromLane);
    } else {
      toLane = Math.min(L2 - 1, fromLane);
    }
    cFromLink.push(il);
    cToLink.push(m.link);
    cFromLane.push(fromLane);
    cToLane.push(toLane);
    cTurn.push(m.turn);
    cNode.push(node);
    cProtected.push(protectedLeft ? 1 : 0);
  };

  if (tagged) {
    let anyMatch = false;
    for (let lane = 0; lane < L; lane++) {
      const mask = tagged[lane];
      for (const m of moves) {
        if ((mask & m.turn) !== 0 || (mask & TURN_ANY) === TURN_ANY) {
          emit(lane, m);
          anyMatch = true;
        }
      }
    }
    // Skyltade pilar som inte matchar någon faktisk gren (vanligt när OSM och
    // geometrin är ur fas) — falla tillbaka på den geometriska fördelningen.
    if (anyMatch) {
      ensureAllMovesServed(moves, cToLink, cFromLink, il, emit, L);
      ensureAllLanesServed(moves, cFromLane, cFromLink, il, emit, L);
      return;
    }
  }

  // En signalreglerad tillfart med flera körfält har i praktiken alltid ett eget
  // vänstersvängfält. Utan det blockerar en enda väntande vänstersvängare hela
  // tillfarten under hela grönperioden, och korsningens kapacitet halveras.
  if (signalised && L >= 2) {
    const lefts = moves.filter((m) => m.turn === Turn.Left || m.turn === Turn.Reverse);
    const rest = moves.filter((m) => m.turn !== Turn.Left && m.turn !== Turn.Reverse);
    if (lefts.length > 0 && rest.length > 0) {
      for (const m of lefts) emit(L - 1, m, true);
      const R = rest.length;
      for (let m = 0; m < R; m++) {
        const lo = Math.floor((m * (L - 1)) / R);
        const hi = Math.max(lo, Math.ceil(((m + 1) * (L - 1)) / R) - 1);
        for (let lane = lo; lane <= hi && lane < L - 1; lane++) emit(lane, rest[m]);
      }
      return;
    }
  }

  for (let m = 0; m < M; m++) {
    const lo = Math.floor((m * L) / M);
    const hi = Math.max(lo, Math.ceil(((m + 1) * L) / M) - 1);
    for (let lane = lo; lane <= hi && lane < L; lane++) emit(lane, moves[m]);
  }
}

/** Varje gren måste nås från minst ett körfält, annars uppstår oåtkomliga länkar. */
function ensureAllMovesServed(
  moves: { link: number; turn: number }[],
  cToLink: number[],
  cFromLink: number[],
  il: number,
  emit: (lane: number, m: { link: number; turn: number }) => void,
  L: number,
): void {
  for (let m = 0; m < moves.length; m++) {
    let served = false;
    for (let i = cToLink.length - 1; i >= 0 && cFromLink[i] === il; i--) {
      if (cToLink[i] === moves[m].link) {
        served = true;
        break;
      }
    }
    if (!served) {
      const lane = Math.min(L - 1, Math.floor((m * L) / moves.length));
      emit(lane, moves[m]);
    }
  }
}

/**
 * Ett körfält utan enda svängrörelse blir en återvändsgränd som fordon kör in i
 * och aldrig lämnar. `turn:lanes` i OSM matchar inte alltid geometrin, så efter
 * den taggstyrda fördelningen fylls tomma körfält på med närmaste gren.
 */
function ensureAllLanesServed(
  moves: { link: number; turn: number }[],
  cFromLane: number[],
  cFromLink: number[],
  il: number,
  emit: (lane: number, m: { link: number; turn: number }) => void,
  L: number,
): void {
  const served = new Array(L).fill(false);
  for (let i = cFromLink.length - 1; i >= 0 && cFromLink[i] === il; i--) {
    served[cFromLane[i]] = true;
  }
  for (let lane = 0; lane < L; lane++) {
    if (served[lane]) continue;
    // Körfält 0 ligger längst till höger, och moves är sorterad höger -> vänster.
    const m = moves[Math.min(moves.length - 1, Math.floor((lane * moves.length) / L))];
    emit(lane, m);
  }
}

function buildLaneIndex(mv: Movements): void {
  const outKey = (c: number): number => mv.laneBase[mv.connFromLink[c]] + mv.connFromLane[c];
  const inKey = (c: number): number => mv.laneBase[mv.connToLink[c]] + mv.connToLane[c];
  fillCsr(mv.connCount, mv.laneCount, outKey, mv.laneConnStart, mv.laneConn);
  fillCsr(mv.connCount, mv.laneCount, inKey, mv.laneInStart, mv.laneIn);
}

function fillCsr(
  count: number,
  buckets: number,
  keyOf: (i: number) => number,
  starts: Int32Array,
  items: Int32Array,
): void {
  const counts = new Int32Array(buckets + 1);
  for (let i = 0; i < count; i++) counts[keyOf(i) + 1]++;
  for (let b = 0; b < buckets; b++) counts[b + 1] += counts[b];
  starts.set(counts);
  const cursor = counts.slice();
  for (let i = 0; i < count; i++) items[cursor[keyOf(i)]++] = i;
}

/**
 * Banan genom korsningen är en kvadratisk Bezier vars kontrollpunkt ligger där
 * de två tangenterna skär varandra. Det ger en kurva som följer körfältspilarna
 * istället för att skära genom korsningens mitt.
 */
function buildConnGeometry(net: RoadNetwork, mv: Movements): void {
  const pa = { x: 0, y: 0, heading: 0 };
  const pb = { x: 0, y: 0, heading: 0 };

  for (let c = 0; c < mv.connCount; c++) {
    const fl = mv.connFromLink[c];
    const tl = mv.connToLink[c];
    posOnLink(net, fl, mv.linkStartOff[fl] + mv.linkDriveLen[fl], laneOffset(net, fl, mv.connFromLane[c]), pa);
    posOnLink(net, tl, mv.linkStartOff[tl], laneOffset(net, tl, mv.connToLane[c]), pb);

    const ctl = tangentIntersection(pa.x, pa.y, pa.heading, pb.x, pb.y, pb.heading);

    const base = c * CONN_SAMPLES;
    mv.connGeomStart[c] = base;
    let cum = 0;
    let px = pa.x;
    let py = pa.y;
    for (let s = 0; s < CONN_SAMPLES; s++) {
      const t = s / (CONN_SAMPLES - 1);
      const u = 1 - t;
      const x = u * u * pa.x + 2 * u * t * ctl.x + t * t * pb.x;
      const y = u * u * pa.y + 2 * u * t * ctl.y + t * t * pb.y;
      if (s > 0) cum += Math.hypot(x - px, y - py);
      mv.connGeomX[base + s] = x;
      mv.connGeomY[base + s] = y;
      mv.connGeomCum[base + s] = cum;
      px = x;
      py = y;
    }
    mv.connLength[c] = Math.max(cum, 0.5);
  }
  mv.connGeomStart[mv.connCount] = mv.connCount * CONN_SAMPLES;
}

function tangentIntersection(
  ax: number, ay: number, ah: number,
  bx: number, by: number, bh: number,
): { x: number; y: number } {
  const d1x = Math.cos(ah);
  const d1y = Math.sin(ah);
  const d2x = Math.cos(bh);
  const d2y = Math.sin(bh);
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-6) return { x: (ax + bx) / 2, y: (ay + by) / 2 };
  const t = ((bx - ax) * d2y - (by - ay) * d2x) / den;
  // Bakåtliggande skärning betyder att tangenterna divergerar; ta mittpunkten.
  if (t < 0 || t > 200) return { x: (ax + bx) / 2, y: (ay + by) / 2 };
  return { x: ax + d1x * t, y: ay + d1y * t };
}

/** Skär två sträckor varandra? Används för att hitta konfliktpunkter i korsningen. */
function segmentsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const r1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const r2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const r3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const r4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return r1 * r2 < 0 && r3 * r4 < 0;
}

function buildConflicts(net: RoadNetwork, mv: Movements): void {
  const yieldPairs: number[][] = Array.from({ length: mv.connCount }, () => []);
  const conflictPairs: number[][] = Array.from({ length: mv.connCount }, () => []);

  for (let n = 0; n < net.nodeCount; n++) {
    const s = mv.nodeConnStart[n];
    const e = mv.nodeConnStart[n + 1];
    if (e - s < 2) continue;

    for (let i = s; i < e; i++) {
      for (let j = i + 1; j < e; j++) {
        if (!connectionsConflict(mv, i, j)) continue;
        conflictPairs[i].push(j);
        conflictPairs[j].push(i);

        const order = resolvePriority(net, mv, n, i, j);
        if (order === 1) yieldPairs[i].push(j);
        else if (order === -1) yieldPairs[j].push(i);
        else {
          // Ömsesidig väjningsplikt skulle låsa korsningen; lägre index vinner.
          yieldPairs[j].push(i);
        }
      }
    }
  }

  packCsr(yieldPairs, mv.yieldToStart, (arr) => { mv.yieldTo = arr; });
  packCsr(conflictPairs, mv.conflictStart, (arr) => { mv.conflict = arr; });

  // Väjningsklass per rörelse: har den någon att väja för blir den Give/Stop.
  for (let c = 0; c < mv.connCount; c++) {
    const node = mv.connNode[c];
    const hasYields = mv.yieldToStart[c + 1] > mv.yieldToStart[c];
    if (!hasYields) {
      mv.connYield[c] = YieldKind.Major;
      continue;
    }
    const stop =
      net.nodeControl[node] === NodeControl.Stop ||
      net.linkApproachControl[mv.connFromLink[c]] === NodeControl.Stop;
    mv.connYield[c] = stop ? YieldKind.Stop : YieldKind.Give;
  }
}

function packCsr(pairs: number[][], starts: Int32Array, assign: (a: Int32Array) => void): void {
  let total = 0;
  for (let i = 0; i < pairs.length; i++) {
    starts[i] = total;
    total += pairs[i].length;
  }
  starts[pairs.length] = total;
  const flat = new Int32Array(total);
  let k = 0;
  for (const p of pairs) for (const v of p) flat[k++] = v;
  assign(flat);
}

function connectionsConflict(mv: Movements, a: number, b: number): boolean {
  // Samma inkommande körfält: fordonen kommer i följd, inte samtidigt.
  if (mv.connFromLink[a] === mv.connFromLink[b] && mv.connFromLane[a] === mv.connFromLane[b]) {
    return false;
  }
  // Samma utgående körfält: sammanflätning, alltid konflikt.
  if (mv.connToLink[a] === mv.connToLink[b] && mv.connToLane[a] === mv.connToLane[b]) return true;
  // Parallella rörelser från samma tillfart till samma gren korsar inte varandra.
  if (mv.connFromLink[a] === mv.connFromLink[b] && mv.connToLink[a] === mv.connToLink[b]) return false;

  const ga = mv.connGeomStart[a];
  const gb = mv.connGeomStart[b];
  for (let i = 0; i < CONN_SAMPLES - 1; i++) {
    for (let j = 0; j < CONN_SAMPLES - 1; j++) {
      if (
        segmentsCross(
          mv.connGeomX[ga + i], mv.connGeomY[ga + i], mv.connGeomX[ga + i + 1], mv.connGeomY[ga + i + 1],
          mv.connGeomX[gb + j], mv.connGeomY[gb + j], mv.connGeomX[gb + j + 1], mv.connGeomY[gb + j + 1],
        )
      ) return true;
    }
  }
  return false;
}

/**
 * Returnerar 1 om a väjer för b, -1 om b väjer för a, 0 om reglerna inte skiljer dem åt.
 */
function resolvePriority(net: RoadNetwork, mv: Movements, node: number, a: number, b: number): number {
  const fa = mv.connFromLink[a];
  const fb = mv.connFromLink[b];

  // 1. Cirkulationsplats: den som cirkulerar har alltid företräde.
  const aCirc = net.linkRoundabout[fa] === 1;
  const bCirc = net.linkRoundabout[fb] === 1;
  if (aCirc !== bCirc) return aCirc ? -1 : 1;

  // 2. Skyltad stopp-/väjningsplikt vid tillfarten går före klassificeringen.
  const aSign = hasYieldSign(net, fa);
  const bSign = hasYieldSign(net, fb);
  if (aSign !== bSign) return aSign ? 1 : -1;

  const ctl = net.nodeControl[node];
  if (ctl === NodeControl.Signal) {
    // Signalreglerat: faserna skiljer strömmarna åt. En vänstersväng med eget
    // körfält körs skyddat i egen fas och behöver ingen väjning; utan eget
    // körfält är den permissiv och lämnar företräde åt mötande i samma fas.
    if (mv.connProtected[a] === 1 || mv.connProtected[b] === 1) return 0;
    return leftTurnRule(mv, a, b);
  }

  // 3. Huvudled före anslutande gata.
  const pa = net.linkPriority[fa];
  const pb = net.linkPriority[fb];
  if (pa !== pb) return pa < pb ? 1 : -1;

  // 4. Huvudled före anslutande gata, även när de har samma vägklass.
  const major = mv.nodeMajorStreet[node];
  if (major !== -1) {
    const aMajor = streetKey(net, fa) === major;
    const bMajor = streetKey(net, fb) === major;
    if (aMajor !== bMajor) return aMajor ? -1 : 1;
  }

  // 5. Sväng lämnar företräde åt genomgående på samma väg.
  const lt = leftTurnRule(mv, a, b);
  if (lt !== 0) return lt;

  // 6. Högerregeln.
  const relA = angleDiff(net.linkHeadIn[fa], net.linkHeadIn[fb] + Math.PI);
  if (Math.abs(relA) > 0.35) return relA < 0 ? 1 : -1;

  return 0;
}

function hasYieldSign(net: RoadNetwork, link: number): boolean {
  const s = net.linkApproachControl[link];
  return s === NodeControl.Stop || s === NodeControl.GiveWay;
}

/** Svängande fordon lämnar företräde åt mötande och genomgående ström. */
function leftTurnRule(mv: Movements, a: number, b: number): number {
  const ta = mv.connTurn[a];
  const tb = mv.connTurn[b];
  const aTurns = ta === Turn.Left || ta === Turn.Reverse;
  const bTurns = tb === Turn.Left || tb === Turn.Reverse;
  if (aTurns && !bTurns) return 1;
  if (bTurns && !aTurns) return -1;
  return 0;
}

/** Punkt längs en korsningsbana. */
export function posOnConn(
  mv: Movements,
  conn: number,
  along: number,
  out: { x: number; y: number; heading: number },
): void {
  const base = mv.connGeomStart[conn];
  const last = base + CONN_SAMPLES - 1;
  const d = Math.min(Math.max(along, 0), mv.connGeomCum[last]);
  let i = base;
  while (i < last - 1 && mv.connGeomCum[i + 1] < d) i++;
  const segLen = mv.connGeomCum[i + 1] - mv.connGeomCum[i];
  const t = segLen > 1e-6 ? (d - mv.connGeomCum[i]) / segLen : 0;
  const x0 = mv.connGeomX[i];
  const y0 = mv.connGeomY[i];
  const x1 = mv.connGeomX[i + 1];
  const y1 = mv.connGeomY[i + 1];
  out.x = x0 + (x1 - x0) * t;
  out.y = y0 + (y1 - y0) * t;
  out.heading = Math.atan2(y1 - y0, x1 - x0);
}
