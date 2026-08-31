/**
 * Bygger ett körbart vägnät från råa OSM-element.
 *
 * OSM-ways är kartografiska objekt, inte trafikobjekt: en och samma "way" kan
 * passera tio korsningar, och en enda gata kan vara uppdelad i tjugo ways bara för
 * att namnet ändras. Här normaliseras det till en riktad länkgraf där varje länk
 * går mellan två korsningar och har ett bestämt antal körfält i en riktning.
 */

import { Projection, emptyBounds, growBounds, type Bounds } from '../core/geo.ts';
import {
  CLASS_DEFAULTS,
  NodeControl,
  RoadClass,
  isDrivable,
  isLink,
  laneCountsOf,
  nodeControlOf,
  onewayOf,
  parseMaxspeed,
  parseTurnLanes,
  roadClassOf,
  type Tags,
} from './tags.ts';

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Tags;
}
export interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Tags;
}
export interface OsmRelation {
  type: 'relation';
  id: number;
  members: { type: string; ref: number; role: string }[];
  tags?: Tags;
}
export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface CityData {
  version: number;
  key: string;
  name: string;
  bbox: [number, number, number, number];
  fetchedAt: string;
  roads: OsmElement[];
  land: OsmElement[];
  /** Byggnader med fotavtryck och våningar — underlaget för resalstringen. */
  buildings?: import('../demand/landuse.ts').Building[];
  /** Parkeringar med kapacitet — det bästa måttet på var bilresor slutar. */
  parking?: import('../demand/landuse.ts').Parking[];
}

/** Förbud som kommer från `type=restriction`-relationer: "no_left_turn" etc. */
export interface TurnRestriction {
  fromWay: number;
  viaNode: number;
  toWay: number;
  /** true = förbud (no_*), false = påbud (only_*) */
  prohibitive: boolean;
}

export interface RoadNetwork {
  name: string;
  bbox: [number, number, number, number];
  proj: Projection;
  bounds: Bounds;

  nodeCount: number;
  nodeX: Float64Array;
  nodeY: Float64Array;
  nodeControl: Uint8Array;
  nodeOsmId: Float64Array;
  /** CSR: inkommande länkar per nod. */
  nodeInStart: Int32Array;
  nodeIn: Int32Array;
  /** CSR: utgående länkar per nod. */
  nodeOutStart: Int32Array;
  nodeOut: Int32Array;

  linkCount: number;
  linkFrom: Int32Array;
  linkTo: Int32Array;
  linkLength: Float32Array;
  linkLanes: Uint8Array;
  /** Fri hastighet i m/s. */
  linkSpeed: Float32Array;
  linkClass: Uint8Array;
  linkPriority: Uint8Array;
  /** Mättnadsflöde fordon/h/körfält. */
  linkCapacity: Float32Array;
  linkLaneWidth: Float32Array;
  linkWayId: Float64Array;
  linkNameId: Int32Array;
  linkRoundabout: Uint8Array;
  /**
   * Skyltad väjnings-/stopplikt vid länkens slut. OSM placerar `highway=give_way`
   * på en nod en bit före korsningen, inte i korsningen — den noden är oftast ingen
   * korsningsnod, så skylten måste flyttas över till tillfarten den gäller.
   */
  linkApproachControl: Uint8Array;
  /** Riktning (rad) ut från startnoden respektive in i slutnoden. */
  linkHeadOut: Float32Array;
  linkHeadIn: Float32Array;
  /** Motsatt riktning på samma gata, eller -1. */
  linkReverse: Int32Array;
  /** CSR in i geomX/geomY/geomCum. */
  linkGeomStart: Int32Array;
  geomX: Float32Array;
  geomY: Float32Array;
  /** Kumulativ längd längs länken, i meter. */
  geomCum: Float32Array;
  /** Svängbitmask per körfält där `turn:lanes` fanns, annars null. */
  linkTurnLanes: (Uint16Array | null)[];

  names: string[];
  restrictions: TurnRestriction[];
}

interface BuildLink {
  from: number;
  to: number;
  px: number[];
  py: number[];
  lanes: number;
  speed: number;
  cls: RoadClass;
  wayId: number;
  nameId: number;
  roundabout: boolean;
  turnLanes: Uint16Array | null;
  reverse: number;
  approachControl: NodeControl;
}

export function buildNetwork(data: CityData): RoadNetwork {
  const proj = Projection.fromBbox(data.bbox);

  // --- 1. Indexera noder och ways -------------------------------------------------
  const nodeLat = new Map<number, number>();
  const nodeLon = new Map<number, number>();
  const nodeTags = new Map<number, Tags>();
  const ways: OsmWay[] = [];
  const restrictions: TurnRestriction[] = [];

  for (const el of data.roads) {
    if (el.type === 'node') {
      nodeLat.set(el.id, el.lat);
      nodeLon.set(el.id, el.lon);
      if (el.tags) nodeTags.set(el.id, el.tags);
    } else if (el.type === 'way') {
      if (el.tags && isDrivable(el.tags)) ways.push(el);
    } else if (el.type === 'relation') {
      const r = parseRestriction(el);
      if (r) restrictions.push(r);
    }
  }

  // --- 2. Hitta korsningsnoder ----------------------------------------------------
  // En nod är en korsning om den delas av flera ways, är en ändpunkt, eller bär
  // en styrningstagg (signal/stopp) som vi måste kunna placera geometriskt.
  const useCount = new Map<number, number>();
  for (const w of ways) {
    for (let i = 0; i < w.nodes.length; i++) {
      const n = w.nodes[i];
      if (!nodeLat.has(n)) continue;
      useCount.set(n, (useCount.get(n) ?? 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1));
    }
  }

  const nodeIndex = new Map<number, number>();
  const nodeXs: number[] = [];
  const nodeYs: number[] = [];
  const nodeCtl: number[] = [];
  const nodeOsm: number[] = [];

  function internNode(osmId: number): number {
    let idx = nodeIndex.get(osmId);
    if (idx !== undefined) return idx;
    idx = nodeXs.length;
    nodeIndex.set(osmId, idx);
    nodeXs.push(proj.x(nodeLon.get(osmId)!));
    nodeYs.push(proj.y(nodeLat.get(osmId)!));
    nodeCtl.push(nodeControlOf(nodeTags.get(osmId)));
    nodeOsm.push(osmId);
    return idx;
  }

  // Bara strukturella korsningar delar en way. Signal- och vajningsnoder ligger
  // typiskt 10-30 m fore sjalva korsningen och ar inga korsningar i sig - de
  // fangas upp som tillfartsegenskaper langre ner istallet.
  const isJunction = (osmId: number): boolean => {
    if ((useCount.get(osmId) ?? 0) >= 2) return true;
    return nodeControlOf(nodeTags.get(osmId)) === NodeControl.Roundabout;
  };

  // --- 3. Dela ways vid korsningar och skapa riktade länkar -----------------------
  const names: string[] = [''];
  const nameIndex = new Map<string, number>();
  const links: BuildLink[] = [];

  for (const w of ways) {
    const tags = w.tags!;
    const cls = roadClassOf(tags) as RoadClass;
    const oneway = onewayOf(tags);
    const lanes = laneCountsOf(tags, cls, oneway);

    const roundabout = tags.junction === 'roundabout' || tags.junction === 'circular';
    const nameId = internName(tags.name ?? tags.ref ?? '', names, nameIndex);

    const speedFwd = resolveSpeed(tags, cls, 'forward');
    const speedBwd = resolveSpeed(tags, cls, 'backward');
    const turnFwd = parseTurnLanes(tags['turn:lanes:forward'] ?? (oneway === 1 ? tags['turn:lanes'] : undefined), lanes.forward);
    const turnBwd = parseTurnLanes(tags['turn:lanes:backward'] ?? (oneway === -1 ? tags['turn:lanes'] : undefined), lanes.backward);

    // Segmentera: samla punkter tills nästa korsningsnod.
    const valid = w.nodes.filter((n) => nodeLat.has(n));
    if (valid.length < 2) continue;

    let segStart = 0;
    for (let i = 1; i < valid.length; i++) {
      const atEnd = i === valid.length - 1;
      if (!atEnd && !isJunction(valid[i])) continue;

      const a = internNode(valid[segStart]);
      const b = internNode(valid[i]);
      if (a === b) {
        segStart = i;
        continue;
      }

      const px: number[] = [];
      const py: number[] = [];
      for (let k = segStart; k <= i; k++) {
        px.push(proj.x(nodeLon.get(valid[k])!));
        py.push(proj.y(nodeLat.get(valid[k])!));
      }

      // En skylt eller signal mellan korsningarna galler den korsning den star
      // narmast, alltsa den riktning som har den framfor sig. Signaler vinner
      // over vajningsplikt nar bada forekommer pa samma tillfart.
      let fwdSign: NodeControl = NodeControl.None;
      let bwdSign: NodeControl = NodeControl.None;
      for (let k = segStart + 1; k < i; k++) {
        const sign = nodeControlOf(nodeTags.get(valid[k]));
        if (sign === NodeControl.None || sign === NodeControl.Roundabout) continue;
        const rank = (s: NodeControl): number => (s === NodeControl.Signal ? 2 : 1);
        if (i - k <= k - segStart) {
          if (rank(sign) >= rank(fwdSign)) fwdSign = sign;
        } else if (rank(sign) >= rank(bwdSign)) bwdSign = sign;
      }

      let fwdIdx = -1;
      let bwdIdx = -1;
      if (lanes.forward > 0) {
        fwdIdx = links.length;
        links.push({
          from: a, to: b, px, py, lanes: lanes.forward, speed: speedFwd, cls,
          wayId: w.id, nameId, roundabout, turnLanes: turnFwd, reverse: -1,
          approachControl: fwdSign,
        });
      }
      if (lanes.backward > 0) {
        bwdIdx = links.length;
        links.push({
          from: b, to: a, px: px.slice().reverse(), py: py.slice().reverse(),
          lanes: lanes.backward, speed: speedBwd, cls,
          wayId: w.id, nameId, roundabout, turnLanes: turnBwd, reverse: -1,
          approachControl: bwdSign,
        });
      }
      if (fwdIdx >= 0 && bwdIdx >= 0) {
        links[fwdIdx].reverse = bwdIdx;
        links[bwdIdx].reverse = fwdIdx;
      }

      segStart = i;
    }
  }

  // --- 3b. Slå ihop korsningar som egentligen är en ------------------------------
  const joined = joinJunctions(links, nodeXs, nodeYs, nodeCtl, nodeOsm);

  // --- 4. Packa till typade arrayer ----------------------------------------------
  const nodeCount = joined.x.length;
  const linkCount = joined.links.length;
  const finalLinks = joined.links;

  let geomTotal = 0;
  for (const l of finalLinks) geomTotal += l.px.length;

  const net: RoadNetwork = {
    name: data.name,
    bbox: data.bbox,
    proj,
    bounds: emptyBounds(),
    nodeCount,
    nodeX: Float64Array.from(joined.x),
    nodeY: Float64Array.from(joined.y),
    nodeControl: Uint8Array.from(joined.ctl),
    nodeOsmId: Float64Array.from(joined.osm),
    nodeInStart: new Int32Array(nodeCount + 1),
    nodeIn: new Int32Array(linkCount),
    nodeOutStart: new Int32Array(nodeCount + 1),
    nodeOut: new Int32Array(linkCount),
    linkCount,
    linkFrom: new Int32Array(linkCount),
    linkTo: new Int32Array(linkCount),
    linkLength: new Float32Array(linkCount),
    linkLanes: new Uint8Array(linkCount),
    linkSpeed: new Float32Array(linkCount),
    linkClass: new Uint8Array(linkCount),
    linkPriority: new Uint8Array(linkCount),
    linkCapacity: new Float32Array(linkCount),
    linkLaneWidth: new Float32Array(linkCount),
    linkWayId: new Float64Array(linkCount),
    linkNameId: new Int32Array(linkCount),
    linkRoundabout: new Uint8Array(linkCount),
    linkApproachControl: new Uint8Array(linkCount),
    linkHeadOut: new Float32Array(linkCount),
    linkHeadIn: new Float32Array(linkCount),
    linkReverse: new Int32Array(linkCount),
    linkGeomStart: new Int32Array(linkCount + 1),
    geomX: new Float32Array(geomTotal),
    geomY: new Float32Array(geomTotal),
    geomCum: new Float32Array(geomTotal),
    linkTurnLanes: new Array(linkCount),
    names,
    restrictions,
  };

  let g = 0;
  for (let i = 0; i < linkCount; i++) {
    const l = finalLinks[i];
    net.linkGeomStart[i] = g;
    let cum = 0;
    for (let k = 0; k < l.px.length; k++) {
      if (k > 0) cum += Math.hypot(l.px[k] - l.px[k - 1], l.py[k] - l.py[k - 1]);
      net.geomX[g] = l.px[k];
      net.geomY[g] = l.py[k];
      net.geomCum[g] = cum;
      growBounds(net.bounds, l.px[k], l.py[k]);
      g++;
    }
    const n = l.px.length;
    const def = CLASS_DEFAULTS[l.cls];

    net.linkFrom[i] = l.from;
    net.linkTo[i] = l.to;
    // En länk kortare än ett fordon går inte att simulera mikroskopiskt; golva den.
    net.linkLength[i] = Math.max(cum, 1);
    net.linkLanes[i] = Math.min(8, Math.max(1, l.lanes));
    net.linkSpeed[i] = l.speed / 3.6;
    net.linkClass[i] = l.cls;
    net.linkPriority[i] = def.priority;
    net.linkCapacity[i] = def.capacity;
    net.linkLaneWidth[i] = def.laneWidth;
    net.linkWayId[i] = l.wayId;
    net.linkNameId[i] = l.nameId;
    net.linkRoundabout[i] = l.roundabout ? 1 : 0;
    net.linkApproachControl[i] = l.approachControl;
    net.linkReverse[i] = l.reverse;
    net.linkTurnLanes[i] = l.turnLanes;
    net.linkHeadOut[i] = Math.atan2(l.py[1] - l.py[0], l.px[1] - l.px[0]);
    net.linkHeadIn[i] = Math.atan2(l.py[n - 1] - l.py[n - 2], l.px[n - 1] - l.px[n - 2]);
  }
  net.linkGeomStart[linkCount] = g;

  buildAdjacency(net);
  markRoundaboutNodes(net);
  return net;
}

/**
 * Slår ihop korsningsnoder som i verkligheten är en enda korsning.
 *
 * OSM delar en dubbelriktad led vid mittremsan, så en fyrvägskorsning mellan två
 * fyrfältsgator blir fyra noder med 4–8 m långa länkar emellan. De länkarna rymmer
 * ett fordon var och låser varandra ömsesidigt så fort trafiken blir tät — och de
 * motsvarar ingenting som en trafikant upplever som en sträcka. Här förs noderna
 * ihop till en, och de interna länkarna försvinner.
 *
 * Cirkulationsplatser lämnas orörda: deras ring är en riktig körbana.
 */
const JOIN_DISTANCE = 25;
const MAX_CLUSTER_SPAN = 90;

/** Vilken styrning som vinner när flera noder slås ihop. */
const CONTROL_RANK: Record<number, number> = {
  [NodeControl.None]: 0,
  [NodeControl.GiveWay]: 1,
  [NodeControl.Stop]: 2,
  [NodeControl.Priority]: 3,
  [NodeControl.Roundabout]: 4,
  [NodeControl.Signal]: 5,
};

function joinJunctions(
  links: BuildLink[],
  nodeXs: number[],
  nodeYs: number[],
  nodeCtl: number[],
  nodeOsm: number[],
): { links: BuildLink[]; x: number[]; y: number[]; ctl: number[]; osm: number[] } {
  const n = nodeXs.length;

  const neighbours: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  const lengths = new Float64Array(links.length);
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    let len = 0;
    for (let k = 1; k < l.px.length; k++) {
      len += Math.hypot(l.px[k] - l.px[k - 1], l.py[k] - l.py[k - 1]);
    }
    lengths[i] = len;
    neighbours[l.from].add(l.to);
    neighbours[l.to].add(l.from);
  }

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
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

  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    if (l.roundabout) continue;
    if (lengths[i] > JOIN_DISTANCE) continue;
    // Bara riktiga korsningar slås ihop — annars klipps vanliga korta gatustumpar bort.
    if (neighbours[l.from].size < 3 || neighbours[l.to].size < 3) continue;
    union(l.from, l.to);
  }

  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let m = members.get(r);
    if (!m) members.set(r, (m = []));
    m.push(i);
  }

  // Kedjor av korta länkar kan annars svälja ett helt kvarter — släpp för stora kluster.
  for (const [root, m] of members) {
    if (m.length < 2) continue;
    let span = 0;
    for (let a = 0; a < m.length; a++) {
      for (let b = a + 1; b < m.length; b++) {
        span = Math.max(span, Math.hypot(nodeXs[m[a]] - nodeXs[m[b]], nodeYs[m[a]] - nodeYs[m[b]]));
      }
    }
    if (span > MAX_CLUSTER_SPAN) {
      for (const v of m) parent[v] = v;
      members.set(root, [root]);
    }
  }

  // Bygg om nodlistan från klusterrepresentanterna.
  const remap = new Int32Array(n).fill(-1);
  const x: number[] = [];
  const y: number[] = [];
  const ctl: number[] = [];
  const osm: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (remap[r] >= 0) {
      remap[i] = remap[r];
      continue;
    }
    const m = members.get(r) ?? [r];
    const idx = x.length;
    remap[r] = idx;
    remap[i] = idx;
    let sx = 0;
    let sy = 0;
    let best: NodeControl = NodeControl.None;
    for (const v of m) {
      sx += nodeXs[v];
      sy += nodeYs[v];
      if (CONTROL_RANK[nodeCtl[v]] > CONTROL_RANK[best]) best = nodeCtl[v] as NodeControl;
    }
    x.push(sx / m.length);
    y.push(sy / m.length);
    ctl.push(best);
    osm.push(nodeOsm[r]);
  }
  for (let i = 0; i < n; i++) if (remap[i] < 0) remap[i] = remap[find(i)];

  // Länkar inne i ett kluster försvinner; övriga kopplas om till den nya noden.
  const keep: BuildLink[] = [];
  const newIndex = new Int32Array(links.length).fill(-1);
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    const from = remap[l.from];
    const to = remap[l.to];
    if (from === to) continue;
    newIndex[i] = keep.length;
    l.from = from;
    l.to = to;
    keep.push(l);
  }
  for (const l of keep) l.reverse = l.reverse >= 0 ? newIndex[l.reverse] : -1;

  return { links: keep, x, y, ctl, osm };
}

/** Noder som ligger på en cirkulationsring ska styras som rondell, inte som korsning. */
function markRoundaboutNodes(net: RoadNetwork): void {
  for (let i = 0; i < net.linkCount; i++) {
    if (net.linkRoundabout[i] !== 1) continue;
    for (const n of [net.linkFrom[i], net.linkTo[i]]) {
      if (net.nodeControl[n] === NodeControl.None) net.nodeControl[n] = NodeControl.Roundabout;
    }
  }
}

function internName(name: string, names: string[], index: Map<string, number>): number {
  if (!name) return 0;
  let id = index.get(name);
  if (id === undefined) {
    id = names.length;
    names.push(name);
    index.set(name, id);
  }
  return id;
}

function resolveSpeed(tags: Tags, cls: RoadClass, dir: 'forward' | 'backward'): number {
  const directional = parseMaxspeed(tags['maxspeed:' + dir]);
  if (Number.isFinite(directional)) return directional;
  const general = parseMaxspeed(tags.maxspeed);
  if (Number.isFinite(general)) return general;
  const base = CLASS_DEFAULTS[cls].speed;
  // Ramper körs långsammare än den väg de ansluter till.
  return isLink(tags) ? Math.max(30, base - 20) : base;
}

function parseRestriction(rel: OsmRelation): TurnRestriction | null {
  const t = rel.tags?.restriction;
  if (!t) return null;
  const prohibitive = t.startsWith('no_');
  if (!prohibitive && !t.startsWith('only_')) return null;
  let fromWay = -1;
  let toWay = -1;
  let viaNode = -1;
  for (const m of rel.members) {
    if (m.role === 'from' && m.type === 'way') fromWay = m.ref;
    else if (m.role === 'to' && m.type === 'way') toWay = m.ref;
    else if (m.role === 'via' && m.type === 'node') viaNode = m.ref;
  }
  if (fromWay < 0 || toWay < 0 || viaNode < 0) return null;
  return { fromWay, viaNode, toWay, prohibitive };
}

function buildAdjacency(net: RoadNetwork): void {
  const { linkCount, nodeCount, linkFrom, linkTo } = net;
  const outCount = new Int32Array(nodeCount + 1);
  const inCount = new Int32Array(nodeCount + 1);
  for (let i = 0; i < linkCount; i++) {
    outCount[linkFrom[i] + 1]++;
    inCount[linkTo[i] + 1]++;
  }
  for (let n = 0; n < nodeCount; n++) {
    outCount[n + 1] += outCount[n];
    inCount[n + 1] += inCount[n];
  }
  net.nodeOutStart.set(outCount);
  net.nodeInStart.set(inCount);
  const oc = outCount.slice();
  const ic = inCount.slice();
  for (let i = 0; i < linkCount; i++) {
    net.nodeOut[oc[linkFrom[i]]++] = i;
    net.nodeIn[ic[linkTo[i]]++] = i;
  }
}

/**
 * Antal skilda grannoder. Skiljer en verklig ände (1 granne) från mitten av en
 * enkelriktad väg, som också har exakt en inkommande och en utgående länk.
 */
export function junctionDegree(net: RoadNetwork, n: number): number {
  const seen = new Set<number>();
  for (let k = net.nodeInStart[n]; k < net.nodeInStart[n + 1]; k++) {
    seen.add(net.linkFrom[net.nodeIn[k]]);
  }
  for (let k = net.nodeOutStart[n]; k < net.nodeOutStart[n + 1]; k++) {
    seen.add(net.linkTo[net.nodeOut[k]]);
  }
  return seen.size;
}

/**
 * Punkt och riktning en bit in på en länk. `lateral` är sidoförskjutning i meter,
 * positivt åt höger sett i färdriktningen (körfältsmitt i högertrafik).
 */
export function posOnLink(
  net: RoadNetwork,
  link: number,
  along: number,
  lateral: number,
  out: { x: number; y: number; heading: number },
): void {
  const s = net.linkGeomStart[link];
  const e = net.linkGeomStart[link + 1];
  const d = Math.min(Math.max(along, 0), net.geomCum[e - 1]);

  // Linjär sökning: länkgeometrier har nästan alltid färre än 10 punkter.
  let i = s;
  while (i < e - 2 && net.geomCum[i + 1] < d) i++;

  const x0 = net.geomX[i];
  const y0 = net.geomY[i];
  const x1 = net.geomX[i + 1];
  const y1 = net.geomY[i + 1];
  const segLen = net.geomCum[i + 1] - net.geomCum[i];
  const t = segLen > 1e-6 ? (d - net.geomCum[i]) / segLen : 0;

  const heading = Math.atan2(y1 - y0, x1 - x0);
  // Högernormalen till färdriktningen.
  const nx = Math.sin(heading);
  const ny = -Math.cos(heading);

  out.x = x0 + (x1 - x0) * t + nx * lateral;
  out.y = y0 + (y1 - y0) * t + ny * lateral;
  out.heading = heading;
}

/** Sidoförskjutning från vägens mittlinje till körfältets mitt. Fält 0 = längst till höger. */
export function laneOffset(net: RoadNetwork, link: number, lane: number): number {
  const w = net.linkLaneWidth[link];
  const n = net.linkLanes[link];
  const oneWayStreet = net.linkReverse[link] < 0;
  if (oneWayStreet) {
    // Enkelriktad gata: fälten ligger symmetriskt kring mittlinjen.
    return (n / 2 - lane - 0.5) * w;
  }
  // Dubbelriktad: den här riktningen håller sig på höger sida om mittlinjen.
  return (n - lane - 0.5) * w;
}
