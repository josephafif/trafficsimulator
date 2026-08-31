/**
 * Trafiksignaler.
 *
 * OSM taggar `highway=traffic_signals` per tillfart, inte per korsning — en
 * fyrvägskorsning dyker upp som tre–fyra separata noder. De klustras här till en
 * gemensam signalanläggning, annars skulle varje tillfart få ett eget oberoende
 * ljus och korsningen låsa sig.
 *
 * Signalsekvensen följer svensk standard: grön → gul → röd → röd+gul → grön.
 * Mellantiderna dimensioneras efter tillfartshastighet och korsningsbredd.
 */

import { angleDiff } from '../core/geo.ts';
import { NodeControl, Turn } from '../osm/tags.ts';
import { junctionDegree, type RoadNetwork } from '../osm/network.ts';
import type { Movements } from './intersections.ts';

export const GroupState = {
  Red: 0,
  /** Röd+gul — svensk förberedelsesignal, ca 1 s före grönt. */
  RedAmber: 1,
  Green: 2,
  Amber: 3,
} as const;
export type GroupState = (typeof GroupState)[keyof typeof GroupState];

export const SignalMode = {
  /** Fast tidsstyrning: samma cykel oavsett trafik. */
  Fixed: 0,
  /** Trafikstyrd: grönt förlängs så länge fordon detekteras, tomma faser hoppas över. */
  Actuated: 1,
} as const;
export type SignalMode = (typeof SignalMode)[keyof typeof SignalMode];

export interface Phase {
  /** Signalgrupper som har grönt samtidigt. */
  groups: number[];
  green: number;
  /** Gultid — dimensioneras efter tillfartshastighet. */
  amber: number;
  /** Rödtid innan nästa fas släpps fram (utrymningstid). */
  allRed: number;
  /** Trafikstyrning: gränser för hur mycket grönt får krympa/växa. */
  minGreen: number;
  maxGreen: number;
}

export interface Controller {
  id: number;
  /** Noder som ingår i anläggningen. */
  nodes: number[];
  x: number;
  y: number;
  name: string;
  phases: Phase[];
  /** Förskjutning mot nätets gemensamma klocka — grunden för grön våg. */
  offset: number;
  mode: SignalMode;
  /** Sekunder utan fordon som avslutar en trafikstyrd grönperiod. */
  gapOut: number;
}

export interface SignalSystem {
  controllers: Controller[];
  groupCount: number;
  /** Vilken anläggning en signalgrupp tillhör. */
  groupCtrl: Int32Array;
  /** Tillfartslänken gruppen styr (för detektorer och UI). */
  groupLink: Int32Array;
  /** Aktuell signalbild per grupp. */
  groupState: Uint8Array;
  /** Sekunder gruppen har varit röd — driver mätvärdet "väntetid vid rödljus". */
  groupRedTime: Float32Array;

  /** Löpande läge per anläggning. */
  ctrlPhase: Int32Array;
  /** Sekunder in i aktuellt delsteg. */
  ctrlTimer: Float32Array;
  /** 0 = grönt, 1 = gult, 2 = rött mellan faser, 3 = röd+gul. */
  ctrlStep: Uint8Array;
  /** Fordon som väntat vid varje grupp sedan senaste grönt (trafikstyrning). */
  groupDemand: Float32Array;
  /** Sekunder sedan senaste fordonet passerade detektorn. */
  groupGap: Float32Array;
}

const RED_AMBER = 1.0;
const CLUSTER_RADIUS = 45;
/** Hur långt före korsningen en signaltagg får sitta för att räknas till den. */
const SIGNAL_SEARCH = 90;

/**
 * Flyttar signalregleringen från de OSM-noder där taggen råkar sitta till den
 * korsning den faktiskt styr. Utan det här steget blir varje tillfart en egen
 * "anläggning" med en enda fas, och själva korsningen står oreglerad.
 *
 * Returnerar antalet signaler som inte kunde knytas till någon korsning — de är
 * i praktiken signalreglerade övergångsställen mitt på en gata.
 */
export function resolveSignalJunctions(net: RoadNetwork): number {
  const sources: number[] = [];
  for (let n = 0; n < net.nodeCount; n++) {
    if (net.nodeControl[n] === NodeControl.Signal) sources.push(n);
  }
  for (let l = 0; l < net.linkCount; l++) {
    if (net.linkApproachControl[l] === NodeControl.Signal) sources.push(net.linkTo[l]);
  }

  const resolved = new Set<number>();
  let orphans = 0;
  for (const start of sources) {
    const j = nearestJunction(net, start);
    if (j >= 0) resolved.add(j);
    else orphans++;
  }

  for (let n = 0; n < net.nodeCount; n++) {
    if (net.nodeControl[n] === NodeControl.Signal) net.nodeControl[n] = NodeControl.None;
  }
  for (const n of resolved) net.nodeControl[n] = NodeControl.Signal;
  return orphans;
}

/** Bredd-först längs länkarna tills en nod med minst tre grenar hittas. */
function nearestJunction(net: RoadNetwork, start: number): number {
  if (junctionDegree(net, start) >= 3) return start;
  const distance = new Map<number, number>([[start, 0]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const n = queue[head];
    const d = distance.get(n)!;
    if (d > SIGNAL_SEARCH) continue;
    const visit = (next: number, len: number): void => {
      if (distance.has(next)) return;
      const nd = d + len;
      if (nd > SIGNAL_SEARCH) return;
      distance.set(next, nd);
      queue.push(next);
    };
    for (let k = net.nodeOutStart[n]; k < net.nodeOutStart[n + 1]; k++) {
      const l = net.nodeOut[k];
      visit(net.linkTo[l], net.linkLength[l]);
    }
    for (let k = net.nodeInStart[n]; k < net.nodeInStart[n + 1]; k++) {
      const l = net.nodeIn[k];
      visit(net.linkFrom[l], net.linkLength[l]);
    }
  }

  let best = -1;
  let bestD = Infinity;
  for (const [n, d] of distance) {
    if (d < bestD && junctionDegree(net, n) >= 3) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

/** Signaler inom det här avståndet, sammanbundna av en länk, styrs som en anläggning. */
function clusterSignalNodes(net: RoadNetwork): number[][] {
  const isSignal = (n: number): boolean => net.nodeControl[n] === NodeControl.Signal;
  const parent = new Int32Array(net.nodeCount);
  for (let i = 0; i < net.nodeCount; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let l = 0; l < net.linkCount; l++) {
    const a = net.linkFrom[l];
    const b = net.linkTo[l];
    if (!isSignal(a) || !isSignal(b)) continue;
    if (net.linkLength[l] <= CLUSTER_RADIUS) union(a, b);
  }

  const groups = new Map<number, number[]>();
  for (let n = 0; n < net.nodeCount; n++) {
    if (!isSignal(n)) continue;
    const r = find(n);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(n);
  }
  return [...groups.values()];
}

/** Två tillfarter är mötande om de pekar mot varandra — då är vänstersvängen permissiv. */
function isOncoming(net: RoadNetwork, a: number, b: number): boolean {
  return Math.abs(angleDiff(net.linkHeadIn[a], net.linkHeadIn[b])) > 2.6;
}

const isTurning = (t: number): boolean => t === Turn.Left || t === Turn.Reverse;

export function buildSignals(net: RoadNetwork, mv: Movements): SignalSystem {
  const clusters = clusterSignalNodes(net);
  const controllers: Controller[] = [];
  const groupCtrlList: number[] = [];
  const groupLinkList: number[] = [];

  for (const nodes of clusters) {
    const ctrlId = controllers.length;

    // --- Samla alla rörelser som anläggningen styr ------------------------------
    const conns: number[] = [];
    for (const n of nodes) {
      for (let c = mv.nodeConnStart[n]; c < mv.nodeConnStart[n + 1]; c++) conns.push(c);
    }
    if (conns.length === 0) continue;

    // Interna rörelser mellan två noder i samma anläggning ska inte ha eget ljus —
    // de ligger inne i korsningen och styrs av tillfartens signal.
    const inCluster = new Set(nodes);

    // --- Signalgrupper: en per tillfart, plus egen grupp för skyddad vänstersväng ---
    const groupOf = new Map<string, number>();
    const localGroups: number[] = [];
    const connGroup = new Map<number, number>();

    for (const c of conns) {
      const fl = mv.connFromLink[c];
      if (inCluster.has(net.linkFrom[fl])) continue; // intern länk, ingen egen signal
      const protectedLeft = mv.connProtected[c] === 1;
      const key = fl + (protectedLeft ? ':L' : '');
      let g = groupOf.get(key);
      if (g === undefined) {
        g = groupCtrlList.length;
        groupOf.set(key, g);
        groupCtrlList.push(ctrlId);
        groupLinkList.push(fl);
        localGroups.push(g);
      }
      connGroup.set(c, g);
      mv.connSignalGroup[c] = g;
    }
    if (localGroups.length === 0) continue;

    // --- Konfliktgraf mellan grupper --------------------------------------------
    const gi = new Map<number, number>();
    localGroups.forEach((g, i) => gi.set(g, i));
    const N = localGroups.length;
    const adj: boolean[][] = Array.from({ length: N }, () => new Array(N).fill(false));

    for (const a of conns) {
      const ga = connGroup.get(a);
      if (ga === undefined) continue;
      for (let k = mv.conflictStart[a]; k < mv.conflictStart[a + 1]; k++) {
        const b = mv.conflict[k];
        const gb = connGroup.get(b);
        if (gb === undefined || gb === ga) continue;

        // Permissiv vänstersväng mot mötande får dela fas — den söker lucka
        // istället. En skyddad vänstersväng ska däremot ha egen fas, annars
        // kommer den aldrig fram genom en tät mötande ström.
        const fa = mv.connFromLink[a];
        const fb = mv.connFromLink[b];
        const anyProtected = mv.connProtected[a] === 1 || mv.connProtected[b] === 1;
        if (!anyProtected && isOncoming(net, fa, fb) &&
            (isTurning(mv.connTurn[a]) || isTurning(mv.connTurn[b]))) {
          continue;
        }
        const ia = gi.get(ga)!;
        const ib = gi.get(gb)!;
        adj[ia][ib] = true;
        adj[ib][ia] = true;
      }
    }

    const colors = greedyColor(adj, N);
    const phaseCount = Math.max(1, Math.max(...colors) + 1);
    let phaseGroups: number[][] = Array.from({ length: phaseCount }, () => []);
    colors.forEach((col, i) => phaseGroups[col].push(localGroups[i]));
    phaseGroups = mergePhases(phaseGroups, adj, gi);

    // --- Tider --------------------------------------------------------------------
    let cx = 0;
    let cy = 0;
    for (const n of nodes) {
      cx += net.nodeX[n];
      cy += net.nodeY[n];
    }
    cx /= nodes.length;
    cy /= nodes.length;

    const width = intersectionWidth(net, nodes);
    const phases = phaseGroups.map((groups) => {
      const speed = Math.max(...groups.map((g) => net.linkSpeed[groupLinkList[g]]));
      const lanes = groups.reduce((s, g) => s + net.linkLanes[groupLinkList[g]], 0);
      return {
        groups,
        // Grön fördelas efter tillfarternas kapacitet; justeras sedan mot cykeltiden.
        green: lanes,
        amber: speed * 3.6 <= 50 ? 3 : speed * 3.6 <= 70 ? 4 : 5,
        // Utrymningstid: hinna över korsningen i ca 10 m/s.
        allRed: Math.min(4, Math.max(1, width / 10)),
        // En grönperiod måste räcka för att en stillastående kö ska hinna komma
        // igång och passera. Under åtta sekunder hinner knappt fyra bilar över
        // stopplinjen, och tillfarten töms aldrig. En ensam vänstersvängsfas
        // klarar sig på något mindre.
        minGreen: groups.length === 1 ? 7 : 9,
        maxGreen: 55,
      } satisfies Phase;
    });

    // Normalisera grönfördelningen till en rimlig cykeltid för svensk tätort.
    const lost = phases.reduce((s, p) => s + p.amber + p.allRed + RED_AMBER, 0);
    // Cykeltiden växer med antalet faser men hålls inom det spann svenska
    // tätortsanläggningar arbetar i. Trafikstyrningen kortar den sedan av sig
    // själv när det är glest.
    const targetCycle = Math.min(110, Math.max(45, 25 + 22 * phases.length));
    const greenTotal = Math.max(phaseCount * 8, targetCycle - lost);
    const weightSum = phases.reduce((s, p) => s + p.green, 0);
    for (const p of phases) {
      p.green = Math.max(p.minGreen, (p.green / weightSum) * greenTotal);
    }

    controllers.push({
      id: ctrlId,
      nodes,
      x: cx,
      y: cy,
      name: signalName(net, mv, conns),
      phases,
      offset: 0,
      // Trafikstyrning är normalläget i svenska tätorter: anläggningarna har
      // detektorer i tillfarterna, grönt förlängs så länge fordon fortsätter
      // komma, och en fas utan väntande fordon hoppas över. En fast cykel som
      // rullar vidare oavsett trafik ger en korsning som växlar i onödan när det
      // är glest — och som inte förlänger när det behövs.
      mode: SignalMode.Actuated,
      // Luckan som avslutar grönt. Svenska anläggningar ligger typiskt kring tre
      // sekunder: kortare ger hackig avveckling, längre slösar grönt.
      gapOut: 3,
    });
  }

  const groupCount = groupCtrlList.length;
  const sys: SignalSystem = {
    controllers,
    groupCount,
    groupCtrl: Int32Array.from(groupCtrlList),
    groupLink: Int32Array.from(groupLinkList),
    groupState: new Uint8Array(groupCount),
    groupRedTime: new Float32Array(groupCount),
    ctrlPhase: new Int32Array(controllers.length),
    ctrlTimer: new Float32Array(controllers.length),
    ctrlStep: new Uint8Array(controllers.length),
    groupDemand: new Float32Array(groupCount),
    groupGap: new Float32Array(groupCount),
  };
  resetSignals(sys);
  return sys;
}

function intersectionWidth(net: RoadNetwork, nodes: number[]): number {
  let w = 8;
  for (const n of nodes) {
    for (let k = net.nodeInStart[n]; k < net.nodeInStart[n + 1]; k++) {
      const l = net.nodeIn[k];
      w = Math.max(w, net.linkLanes[l] * net.linkLaneWidth[l] * 2);
    }
  }
  return w;
}

function signalName(net: RoadNetwork, mv: Movements, conns: number[]): string {
  const names = new Set<string>();
  for (const c of conns) {
    const n = net.names[net.linkNameId[mv.connFromLink[c]]];
    if (n) names.add(n);
  }
  const list = [...names].slice(0, 2);
  return list.length ? list.join(' / ') : 'Signalkorsning';
}

/**
 * Slår ihop faser som inte står i konflikt med varandra.
 *
 * Färgningen är konservativ och delar gärna upp i fler faser än nödvändigt — en
 * skyddad vänstersväng hamnar lätt i en egen fas trots att den utan vidare kan gå
 * samtidigt som den egna tillfartens raka ström. Verkliga anläggningar har sällan
 * fler än tre eller fyra faser, och varje extra fas kostar mellantid: fem faser
 * innebär att en fjärdedel av cykeln går åt till gult och rött utan att någon kör.
 * Det är också det som får korsningen att kännas som om den växlar hela tiden.
 */
function mergePhases(
  phases: number[][],
  adj: boolean[][],
  index: Map<number, number>,
): number[][] {
  const conflicts = (a: number[], b: number[]): boolean => {
    for (const g of a) {
      for (const h of b) {
        const ia = index.get(g);
        const ib = index.get(h);
        if (ia !== undefined && ib !== undefined && adj[ia][ib]) return true;
      }
    }
    return false;
  };

  let merged = true;
  while (merged && phases.length > 1) {
    merged = false;
    outer: for (let i = 0; i < phases.length; i++) {
      for (let j = i + 1; j < phases.length; j++) {
        if (conflicts(phases[i], phases[j])) continue;
        phases[i] = [...phases[i], ...phases[j]];
        phases.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return phases;
}

/** Welsh–Powell: grader först ger färre faser än naiv girig färgning. */
function greedyColor(adj: boolean[][], n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => adj[b].filter(Boolean).length - adj[a].filter(Boolean).length,
  );
  const colors = new Array(n).fill(-1);
  for (const v of order) {
    const used = new Set<number>();
    for (let u = 0; u < n; u++) if (adj[v][u] && colors[u] >= 0) used.add(colors[u]);
    let c = 0;
    while (used.has(c)) c++;
    colors[v] = c;
  }
  return colors;
}

/** Startar om en enda anläggning — dess grannar ska inte hoppa när planen ändras. */
export function resetController(sys: SignalSystem, id: number): void {
  const c = sys.controllers[id];
  if (!c) return;
  sys.ctrlPhase[id] = 0;
  sys.ctrlStep[id] = 0;
  sys.ctrlTimer[id] = c.offset % Math.max(1, cycleLength(c));
  for (const p of c.phases) {
    for (const g of p.groups) {
      sys.groupDemand[g] = 0;
      sys.groupGap[g] = 0;
    }
  }
}

export function resetSignals(sys: SignalSystem): void {
  sys.groupState.fill(GroupState.Red);
  sys.groupRedTime.fill(0);
  sys.ctrlPhase.fill(0);
  sys.ctrlStep.fill(0);
  sys.groupDemand.fill(0);
  sys.groupGap.fill(0);
  for (let i = 0; i < sys.controllers.length; i++) {
    // Offset förskjuter starten i cykeln — grunden för samordning/grön våg.
    const c = sys.controllers[i];
    sys.ctrlTimer[i] = c.offset % Math.max(1, cycleLength(c));
  }
  applyStates(sys);
}

export function cycleLength(c: Controller): number {
  let t = 0;
  for (const p of c.phases) t += p.green + p.amber + p.allRed + RED_AMBER;
  return t;
}

/**
 * Kör signalerna ett tidssteg. `dt` i sekunder.
 * Trafikstyrning använder `groupDemand`/`groupGap` som simuleringen fyller på
 * när fordon passerar detektorn vid stopplinjen.
 */
export function stepSignals(sys: SignalSystem, dt: number): void {
  for (let i = 0; i < sys.controllers.length; i++) {
    const c = sys.controllers[i];
    if (c.phases.length === 0) continue;
    sys.ctrlTimer[i] += dt;

    const phase = c.phases[sys.ctrlPhase[i]];
    const step = sys.ctrlStep[i];
    let dur: number;
    if (step === 0) dur = effectiveGreen(sys, c, phase, i);
    else if (step === 1) dur = phase.amber;
    else if (step === 2) dur = phase.allRed;
    else dur = RED_AMBER;

    if (sys.ctrlTimer[i] >= dur) {
      sys.ctrlTimer[i] -= dur;
      if (step === 3) {
        sys.ctrlStep[i] = 0;
      } else if (step === 2) {
        sys.ctrlPhase[i] = nextPhase(sys, c, sys.ctrlPhase[i]);
        sys.ctrlStep[i] = 3;
        for (const g of c.phases[sys.ctrlPhase[i]].groups) sys.groupDemand[g] = 0;
      } else {
        sys.ctrlStep[i] = (step + 1) as 1 | 2;
      }
    }
  }
  applyStates(sys);

  for (let g = 0; g < sys.groupCount; g++) {
    if (sys.groupState[g] === GroupState.Red || sys.groupState[g] === GroupState.RedAmber) {
      sys.groupRedTime[g] += dt;
    } else sys.groupRedTime[g] = 0;
    sys.groupGap[g] += dt;
  }
}

function effectiveGreen(sys: SignalSystem, c: Controller, phase: Phase, ci: number): number {
  if (c.mode === SignalMode.Fixed) return phase.green;
  // Trafikstyrd: håll grönt så länge luckorna är korta, inom min/max.
  const t = sys.ctrlTimer[ci];
  if (t < phase.minGreen) return phase.minGreen;
  if (t >= phase.maxGreen) return phase.maxGreen;
  let minGap = Infinity;
  for (const g of phase.groups) minGap = Math.min(minGap, sys.groupGap[g]);
  return minGap >= c.gapOut ? t : phase.maxGreen;
}

/** Trafikstyrning hoppar över faser utan väntande fordon. */
function nextPhase(sys: SignalSystem, c: Controller, current: number): number {
  const n = c.phases.length;
  if (c.mode === SignalMode.Fixed || n < 3) return (current + 1) % n;
  for (let k = 1; k <= n; k++) {
    const p = (current + k) % n;
    if (k === n) return p;
    for (const g of c.phases[p].groups) {
      if (sys.groupDemand[g] > 0) return p;
    }
  }
  return (current + 1) % n;
}

function applyStates(sys: SignalSystem): void {
  sys.groupState.fill(GroupState.Red);
  for (let i = 0; i < sys.controllers.length; i++) {
    const c = sys.controllers[i];
    if (c.phases.length === 0) continue;
    const phase = c.phases[sys.ctrlPhase[i]];
    const step = sys.ctrlStep[i];
    const state =
      step === 0 ? GroupState.Green : step === 1 ? GroupState.Amber
      : step === 3 ? GroupState.RedAmber : GroupState.Red;
    if (state !== GroupState.Red) for (const g of phase.groups) sys.groupState[g] = state;
  }
}

/**
 * Sätter offsets för en grön våg längs en kedja av anläggningar.
 * `speed` i m/s är den progressionshastighet vågen ska hålla.
 */
export function setGreenWave(sys: SignalSystem, ctrlIds: number[], speed: number): void {
  if (ctrlIds.length < 2) return;
  const cycle = cycleLength(sys.controllers[ctrlIds[0]]);
  // Samordning kräver gemensam cykeltid — den längsta styr.
  let common = 0;
  for (const id of ctrlIds) common = Math.max(common, cycleLength(sys.controllers[id]));
  for (const id of ctrlIds) scaleCycle(sys.controllers[id], common);

  let acc = 0;
  const first = sys.controllers[ctrlIds[0]];
  first.offset = 0;
  for (let i = 1; i < ctrlIds.length; i++) {
    const a = sys.controllers[ctrlIds[i - 1]];
    const b = sys.controllers[ctrlIds[i]];
    acc += Math.hypot(b.x - a.x, b.y - a.y) / speed;
    b.offset = acc % common;
  }
  void cycle;
  resetSignals(sys);
}

/** Skalar grönfördelningen så att anläggningen får den önskade cykeltiden. */
export function scaleCycle(c: Controller, cycle: number): void {
  const lost = c.phases.reduce((s, p) => s + p.amber + p.allRed + RED_AMBER, 0);
  const greenTotal = Math.max(c.phases.length * 5, cycle - lost);
  const cur = c.phases.reduce((s, p) => s + p.green, 0);
  if (cur <= 0) return;
  for (const p of c.phases) p.green = Math.max(p.minGreen, (p.green / cur) * greenTotal);
}

/**
 * Websters metod: fördelar grönt efter uppmätt mättnadsgrad och räknar fram den
 * cykeltid som minimerar fördröjningen. Kräver att simuleringen har mätt flöden.
 * `flowByGroup` i fordon/timme.
 */
export function optimiseWebster(
  sys: SignalSystem,
  net: RoadNetwork,
  flowByGroup: Float32Array,
): void {
  for (const c of sys.controllers) {
    if (c.phases.length < 2) continue;
    // y = flöde / mättnadsflöde för den kritiska gruppen i varje fas.
    const y = c.phases.map((p) => {
      let worst = 0;
      for (const g of p.groups) {
        const link = sys.groupLink[g];
        const sat = net.linkCapacity[link] * net.linkLanes[link];
        worst = Math.max(worst, flowByGroup[g] / Math.max(sat, 1));
      }
      return Math.min(worst, 0.92);
    });
    const Y = y.reduce((a, b) => a + b, 0);
    if (Y >= 0.92) {
      // Överbelastad korsning: kör längsta rimliga cykel och fördela efter tryck.
      distributeGreen(c, y, 120);
      continue;
    }
    const lost = c.phases.reduce((s, p) => s + p.amber + p.allRed + RED_AMBER, 0);
    const optimal = (1.5 * lost + 5) / (1 - Y);
    distributeGreen(c, y, Math.min(120, Math.max(40, optimal)));
  }
  resetSignals(sys);
}

function distributeGreen(c: Controller, y: number[], cycle: number): void {
  const lost = c.phases.reduce((s, p) => s + p.amber + p.allRed + RED_AMBER, 0);
  const greenTotal = Math.max(c.phases.length * 6, cycle - lost);
  const Y = y.reduce((a, b) => a + b, 0) || 1;
  c.phases.forEach((p, i) => {
    p.green = Math.max(p.minGreen, (y[i] / Y) * greenTotal);
  });
}
