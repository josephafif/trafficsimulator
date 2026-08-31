/**
 * Trafikefterfrågan.
 *
 * Tre källor kan kombineras:
 *  1. Syntetisk OD-matris ur bebyggelsen (resalstring + gravitationsmodell)
 *  2. Importerad OD-matris (CSV) — kommunens egna resmatriser
 *  3. Handritade flöden mellan två punkter
 *
 * Efterfrågan består av två delar som är väsensskilda och därför räknas var för
 * sig: resor inom staden, som följer bebyggelsen, och trafik på infartslederna,
 * som styrs av vad lederna bär. Blandas de ihop försvinner ledtrafiken i
 * gravitationsmodellens avståndsmotstånd, och lederna står tomma medan
 * lokalgatorna får ta hela lasten.
 */

import { SpatialGrid } from '../core/geo.ts';
import { junctionDegree, type OsmElement, type RoadNetwork } from '../osm/network.ts';
import { RoadClass } from '../osm/tags.ts';
import {
  buildingAttraction, classifyUntagged, floorArea, isResidential, parkingArrivals, parkingSpaces,
  refineTagged, residents, Use, useOf, type Building, type Parking,
} from './landuse.ts';

export interface Zone {
  id: number;
  x: number;
  y: number;
  name: string;
  /** Resalstring: bilresor som startar här ett vardagsdygn. */
  production: number;
  /** Målpunktsattraktion i bilresor per vardagsdygn. */
  attraction: number;
  /**
   * Länkar där resor *börjar* — bostadsgator kring befolkningens tyngdpunkt.
   */
  anchors: Int32Array;
  /**
   * Länkar där resor *slutar* — gatorna som matar zonens målpunkter.
   *
   * Skilda från startlänkarna därför att de sällan ligger på samma ställe: en
   * galleria och bostadsområdet runt den hamnar i samma zon, och skickas
   * resorna dit befolkningen bor i stället för dit handeln ligger hamnar
   * trafiken på villagatorna i stället för på infarten till parkeringen.
   */
  destAnchors: Int32Array;
  /** Befolkningens tyngdpunkt i zonen. */
  originX: number;
  originY: number;
  /** Målpunkternas tyngdpunkt i zonen. */
  destX: number;
  destY: number;
  /** Yttre zon = infart till nätet, dvs. genomfarts- och regiontrafik. */
  external: boolean;
  /** Uppskattat antal boende — gör modellen granskningsbar mot verkligheten. */
  residents: number;
  /** Vad zonen domineras av, för gränssnittet. */
  character: string;
}

export interface DemandModel {
  zones: Zone[];
  /** Dygnsresor mellan zonpar, rad = ursprung. */
  od: Float32Array;
  /** 24 timfaktorer som summerar till 1. */
  profile: Float32Array;
  /** Andel av resorna i riktningen bostad→mål per timme (resten är returresor). */
  outboundShare: Float32Array;
  totalTrips: number;
  manualFlows: ManualFlow[];
  /** Namngivna målpunkter, för kartan och för att kunna namnge zonerna. */
  places: Place[];
  /** Uppskattad folkmängd i området. Jämför med verkligheten för att se rimligheten. */
  population: number;
}

export interface ManualFlow {
  id: number;
  name: string;
  fromZone: number;
  toZone: number;
  vehiclesPerHour: number;
  active: boolean;
}

export interface DemandOptions {
  /** Måltal för antalet interna zoner. Fler zoner = finare mönster men tyngre ruttning. */
  targetZones: number;
  /** Resor per dygn totalt. 0 = räkna fram ur bebyggelsen. */
  totalTrips: number;
  /** Personresor per invånare och dygn, alla ärenden och färdsätt. */
  tripsPerPerson: number;
  /** Medelreslängd i km som styr gravitationsmodellens avståndsmotstånd. */
  meanTripKm: number;
  /** Andel av ledtrafiken som passerar staden utan att stanna. */
  throughShare: number;
  /** Skalfaktor på ledtrafiken; höj den om lederna bär mer än modellen tror. */
  corridorScale: number;
}

export const DEFAULT_DEMAND: DemandOptions = {
  targetZones: 150,
  totalTrips: 0,
  tripsPerPerson: 2.9,
  meanTripKm: 5.5,
  throughShare: 0.45,
  corridorScale: 1,
};

/** Dygnsfördelning för biltrafik i svensk tätort, vardag. */
const HOURLY = [
  0.005, 0.003, 0.002, 0.002, 0.006, 0.017, 0.046, 0.086, 0.074, 0.05, 0.045, 0.048,
  0.051, 0.048, 0.056, 0.076, 0.09, 0.084, 0.06, 0.045, 0.035, 0.028, 0.021, 0.012,
];

/** Hur stor del av timmens resor som går bostad→målpunkt (morgonen är enkelriktad). */
const OUTBOUND = [
  0.5, 0.5, 0.5, 0.5, 0.6, 0.75, 0.86, 0.9, 0.86, 0.72, 0.6, 0.55,
  0.5, 0.45, 0.38, 0.28, 0.2, 0.18, 0.25, 0.35, 0.42, 0.45, 0.48, 0.5,
];

/**
 * Bilandel som funktion av hur tätt det bor folk i rutan.
 *
 * Modellen alstrar resor, inte bilresor. I ett tätt stadscentrum görs merparten
 * till fots, med cykel eller kollektivt — Uppsala har en av landets högsta
 * cykelandelar — medan bilandelen är hög i villaområden och ytterkanter.
 */
// Kalibrerade så att Uppsala tätort landar kring 170 000 interna bilresor per
// vardagsdygn — 170 000 invånare, ungefär tre resor var, och en bilandel som är
// låg i en stad där var tredje resa görs på cykel.
const CAR_SHARE_DENSE = 0.165;
const CAR_SHARE_SPARSE = 0.48;
/** Boende per hektar där bilandelen fallit halvvägs mot den täta nivån. */
const DENSITY_MIDPOINT = 55;

/** Rutstorlek för resalstringen, meter. */
const CELL = 300;

interface Cell {
  x: number;
  y: number;
  production: number;
  attraction: number;
  residents: number;
  retail: number;
  jobs: number;
}

/**
 * En namngiven plats i staden: en handelsplats, skola, arbetsplats eller annan
 * målpunkt som är värd att se på kartan och att kunna säga att en resa går till.
 */
export interface Place {
  name: string;
  x: number;
  y: number;
  /** Byggnadens användning, för symbol och färg. */
  use: number;
  /** Hur mycket trafik platsen drar, bilresor per vardagsdygn. */
  pull: number;
}

export function buildDemand(
  net: RoadNetwork,
  land: OsmElement[],
  opts: DemandOptions = DEFAULT_DEMAND,
  buildings: Building[] = [],
  parking: Parking[] = [],
): DemandModel {
  const raster = rasterise(net, land, buildings, parking, opts);
  const places = collectPlaces(net, buildings, parking, raster.uses);
  const internal = clusterZones(raster.cells, opts.targetZones);
  const external = boundaryZones(net, opts);

  const zones: Zone[] = [...internal, ...external];
  zones.forEach((z, i) => (z.id = i));
  nameZones(internal, places);
  attachAnchors(net, zones);

  const od = buildMatrix(zones, internal.length, opts);
  let totalTrips = 0;
  for (let i = 0; i < od.length; i++) totalTrips += od[i];

  // En uttrycklig totalsiffra skalar om hela matrisen men behåller mönstret.
  if (opts.totalTrips > 0 && totalTrips > 0) {
    const scale = opts.totalTrips / totalTrips;
    for (let i = 0; i < od.length; i++) od[i] *= scale;
    totalTrips = opts.totalTrips;
  }

  return {
    zones,
    od,
    profile: normalise(HOURLY),
    outboundShare: Float32Array.from(OUTBOUND),
    totalTrips,
    manualFlows: [],
    places,
    population: raster.population,
  };
}

// --- Resalstring ur bebyggelsen ---------------------------------------------------

function rasterise(
  net: RoadNetwork,
  land: OsmElement[],
  buildings: Building[],
  parking: Parking[],
  opts: DemandOptions,
): { cells: Cell[]; population: number; uses: Uint8Array } {
  const b = net.bounds;
  const cols = Math.ceil((b.maxX - b.minX) / CELL) + 1;
  const rows = Math.ceil((b.maxY - b.minY) / CELL) + 1;
  const size = cols * rows;

  const pop = new Float64Array(size);
  const attrBuildings = new Float64Array(size);
  const attrParking = new Float64Array(size);
  const retailArea = new Float64Array(size);
  const jobArea = new Float64Array(size);

  const idx = (x: number, y: number): number => {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((x - b.minX) / CELL)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((y - b.minY) / CELL)));
    return cy * cols + cx;
  };

  const uses = classifyBuildings(net, land, buildings, parking, idx, size, cols);


  for (let k = 0; k < buildings.length; k++) {
    const building = buildings[k];
    const use = uses[k] as Use;
    const i = idx(net.proj.x(building.lon), net.proj.y(building.lat));
    attrBuildings[i] += buildingAttraction(building, use);
    if (isResidential(use)) {
      pop[i] += residents(building, use);
    } else {
      const area = floorArea(building, use);
      jobArea[i] += area;
      if (use === Use.Retail) retailArea[i] += area;
    }
  }

  for (const p of parking) {
    attrParking[idx(net.proj.x(p.lon), net.proj.y(p.lat))] += parkingArrivals(p);
  }

  addLandUseFallback(net, land, idx, attrBuildings, pop);

  let population = 0;
  for (let i = 0; i < size; i++) population += pop[i];

  const cells: Cell[] = [];
  const hectares = (CELL * CELL) / 10000;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      // Golvyta och parkering mäter samma målpunkt från två håll — att lägga
      // ihop dem vore att räkna samma resa två gånger.
      const attraction = Math.max(attrBuildings[i], attrParking[i]);
      if (pop[i] < 1 && attraction < 1) continue;

      const density = pop[i] / hectares;
      const carShare =
        CAR_SHARE_SPARSE -
        (CAR_SHARE_SPARSE - CAR_SHARE_DENSE) * (density / (density + DENSITY_MIDPOINT));

      cells.push({
        x: b.minX + (cx + 0.5) * CELL,
        y: b.minY + (cy + 0.5) * CELL,
        production: pop[i] * opts.tripsPerPerson * carShare,
        attraction: attraction * carShare * 1.35,
        residents: pop[i],
        retail: retailArea[i],
        jobs: jobArea[i],
      });
    }
  }
  return { cells, population, uses };
}

/**
 * Plockar ut de namngivna målpunkterna ur bebyggelsen.
 *
 * Ett hus räknas som en plats värd att visa om det både har ett namn och drar
 * märkbart med trafik. Parkeringen intill räknas in i dragningskraften, eftersom
 * det är den som avgör hur många som faktiskt kan komma dit med bil.
 */
function collectPlaces(
  net: RoadNetwork,
  buildings: Building[],
  parking: Parking[],
  uses: Uint8Array,
): Place[] {
  const found = new Map<string, Place>();
  for (let k = 0; k < buildings.length; k++) {
    const b = buildings[k];
    if (!b.n) continue;
    const use = uses[k] as Use;
    if (use === Use.Detached || use === Use.Terraced || use === Use.Other) continue;
    const pull = buildingAttraction(b, use);
    if (pull < 60) continue;
    const x = net.proj.x(b.lon);
    const y = net.proj.y(b.lat);
    // Samma namn på flera huskroppar är ett och samma ställe; behåll det största.
    const previous = found.get(b.n);
    if (previous && previous.pull >= pull) continue;
    found.set(b.n, { name: b.n, x, y, use, pull });
  }

  // Lägg parkeringen till närmaste plats — det är den som sätter taket för
  // hur många bilar stället kan ta emot.
  const list = [...found.values()];
  for (const p of parking) {
    const px = net.proj.x(p.lon);
    const py = net.proj.y(p.lat);
    let best: Place | null = null;
    let bestD = 220 * 220;
    for (const place of list) {
      const d = (place.x - px) ** 2 + (place.y - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = place;
      }
    }
    if (best) best.pull += parkingArrivals(p) * 0.5;
  }
  list.sort((a, b) => b.pull - a.pull);
  return list.slice(0, 400);
}

/**
 * Ger zonerna namn efter den plats som faktiskt ligger där.
 *
 * "Zon 38" säger ingenting för den som ska bedöma om trafikmönstret är rimligt.
 * Heter zonen i stället efter sin tyngsta målpunkt går det att se direkt att
 * resorna verkligen går dit man förväntar sig.
 */
function nameZones(zones: Zone[], places: Place[]): void {
  for (const z of zones) {
    let best: Place | null = null;
    let bestScore = 0;
    for (const p of places) {
      const d = Math.hypot(p.x - z.destX, p.y - z.destY);
      if (d > 900) continue;
      // Nära och stark väger tyngst.
      const score = p.pull / (300 + d);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) z.name = best.name;
  }
}

/**
 * Bestämmer vad varje hus används till.
 *
 * Merparten bär bara `building=yes` och klassificeras då ur sin omgivning. Utan
 * det steget saknar villaområdena boende och handelsplatserna målpunkter — och
 * det är precis den bristen som lägger trafiken på fel gator.
 */
export function classifyBuildings(
  net: RoadNetwork,
  land: OsmElement[],
  buildings: Building[],
  parking: Parking[],
  idx: (x: number, y: number) => number,
  size: number,
  cols: number,
): Uint8Array {
  const context = buildContext(net, land, buildings, parking, idx, size, cols);
  const uses = new Uint8Array(buildings.length);
  for (let k = 0; k < buildings.length; k++) {
    const i = idx(net.proj.x(buildings[k].lon), net.proj.y(buildings[k].lat));
    const ctx = {
      landuse: context.landuse[i] || undefined,
      parkingSpaces: context.spaces[i],
      neighbour: context.dominant[i] === 255 ? undefined : (context.dominant[i] as Use),
    };
    const tagged = useOf(buildings[k]);
    uses[k] =
      tagged === Use.Other
        ? classifyUntagged(buildings[k], ctx)
        : refineTagged(buildings[k], tagged, ctx);
  }
  return uses;
}

/** Rutnätets uppslagsfunktion, så granskningsverktyg kan använda samma indelning. */
export function cellIndexer(net: RoadNetwork): {
  idx: (x: number, y: number) => number; size: number; cols: number;
} {
  const b = net.bounds;
  const cols = Math.ceil((b.maxX - b.minX) / CELL) + 1;
  const rows = Math.ceil((b.maxY - b.minY) / CELL) + 1;
  return {
    cols,
    size: cols * rows,
    idx: (x, y) => {
      const cx = Math.min(cols - 1, Math.max(0, Math.floor((x - b.minX) / CELL)));
      const cy = Math.min(rows - 1, Math.max(0, Math.floor((y - b.minY) / CELL)));
      return cy * cols + cx;
    },
  };
}

/**
 * Bygger upp den omgivningsbild som otaggade hus klassificeras mot: markens
 * användning, parkeringen i närheten och vad grannhusen är taggade som.
 */
function buildContext(
  net: RoadNetwork,
  land: OsmElement[],
  buildings: Building[],
  parking: Parking[],
  idx: (x: number, y: number) => number,
  size: number,
  cols: number,
): { landuse: string[]; spaces: Float64Array; dominant: Uint8Array } {
  const landuse = new Array<string>(size).fill('');
  const spaces = new Float64Array(size);
  const dominant = new Uint8Array(size).fill(255);

  const nodePos = new Map<number, [number, number]>();
  for (const el of land) {
    if (el.type === 'node') nodePos.set(el.id, [net.proj.x(el.lon), net.proj.y(el.lat)]);
  }
  // Markanvändningen målas ut över polygonens hela utbredning, inte bara dess
  // mittpunkt — ett villaområde är hundratals rutor stort.
  for (const el of land) {
    if (el.type !== 'way' || !el.tags?.landuse) continue;
    const geom = (el as { geometry?: [number, number][] }).geometry;
    const pts: [number, number][] = [];
    if (geom) for (const [lat, lon] of geom) pts.push([net.proj.x(lon), net.proj.y(lat)]);
    else if (el.nodes) {
      for (const id of el.nodes) {
        const p = nodePos.get(id);
        if (p) pts.push(p);
      }
    }
    if (pts.length < 3) continue;
    paintPolygon(pts, el.tags.landuse, landuse, idx);
  }

  for (const p of parking) {
    spreadValue(idx(net.proj.x(p.lon), net.proj.y(p.lat)), parkingSpaces(p), spaces, size, cols, 1);
  }

  // Grannhusens användning: rösta fram den vanligaste taggade i varje ruta och
  // sprid den ett steg, så att luckor i taggningen fylls av sin omgivning.
  const votes = new Map<number, Map<number, number>>();
  for (const b of buildings) {
    const u = useOf(b);
    if (u === Use.Other) continue;
    const i = idx(net.proj.x(b.lon), net.proj.y(b.lat));
    let m = votes.get(i);
    if (!m) votes.set(i, (m = new Map()));
    m.set(u, (m.get(u) ?? 0) + 1);
  }
  const local = new Uint8Array(size).fill(255);
  for (const [i, m] of votes) {
    let best = 255;
    let bestN = 0;
    for (const [u, count] of m) {
      if (count > bestN) {
        bestN = count;
        best = u;
      }
    }
    local[i] = best;
  }
  for (let i = 0; i < size; i++) {
    if (local[i] !== 255) {
      dominant[i] = local[i];
      continue;
    }
    for (const d of [-1, 1, -cols, cols, -cols - 1, -cols + 1, cols - 1, cols + 1]) {
      const j = i + d;
      if (j >= 0 && j < size && local[j] !== 255) {
        dominant[i] = local[j];
        break;
      }
    }
  }
  return { landuse, spaces, dominant };
}

/** Rastrerar en polygon till rutnätet med ett enkelt svep över dess omslutande rektangel. */
function paintPolygon(
  pts: [number, number][],
  value: string,
  target: string[],
  idx: (x: number, y: number) => number,
): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  // Rutnätet är 300 m; steg om halva rutan räcker för att täcka polygonen.
  const step = CELL / 2;
  for (let y = minY; y <= maxY + step; y += step) {
    for (let x = minX; x <= maxX + step; x += step) {
      if (!pointInPolygon(x, y, pts)) continue;
      const i = idx(x, y);
      if (!target[i] || rank(value) > rank(target[i])) target[i] = value;
    }
  }
}

/** Mer specifik markanvändning vinner över mindre specifik när de överlappar. */
function rank(value: string): number {
  return value === 'retail' ? 4 : value === 'commercial' ? 3
    : value === 'industrial' ? 2 : value === 'education' ? 2 : 1;
}

function pointInPolygon(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Lägger ett värde i rutan och dess grannar, så närhet räknas över rutkanter. */
function spreadValue(
  i: number, value: number, target: Float64Array, size: number, cols: number, radius: number,
): void {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const j = i + dy * cols + dx;
      if (j >= 0 && j < size) target[j] += value;
    }
  }
}

/**
 * Där byggnadsdata saknas får markanvändningspolygoner och punkter bära
 * alstringen, så att glest kartlagda områden inte blir helt trafikfria. Där
 * husen redan svarat för målpunkten läggs ingenting till — annars räknas samma
 * butik både som byggnad och som symbol ovanpå byggnaden.
 */
function addLandUseFallback(
  net: RoadNetwork,
  land: OsmElement[],
  idx: (x: number, y: number) => number,
  attraction: Float64Array,
  pop: Float64Array,
): void {
  const nodePos = new Map<number, [number, number]>();
  for (const el of land) {
    if (el.type === 'node') nodePos.set(el.id, [net.proj.x(el.lon), net.proj.y(el.lat)]);
  }

  for (const el of land) {
    const tags = el.tags;
    if (!tags) continue;

    if (el.type === 'node') {
      const pos = nodePos.get(el.id);
      if (!pos) continue;
      const i = idx(pos[0], pos[1]);
      if (attraction[i] > 5) continue;
      attraction[i] += poiFallback(tags);
      continue;
    }
    if (el.type !== 'way') continue;

    const ring = wayRing(el, net, nodePos);
    if (!ring) continue;
    const i = idx(ring.cx, ring.cy);
    if (tags.landuse === 'residential' && pop[i] < 5) {
      // Bostadsmark utan kartlagda hus: ca 45 boende per hektar som schablon.
      pop[i] += ring.areaHa * 45;
    }
    if (attraction[i] > 5) continue;
    const perHa: Record<string, number> = {
      commercial: 130, retail: 220, industrial: 45, education: 90, institutional: 70,
    };
    const rate = tags.landuse ? perHa[tags.landuse] : undefined;
    if (rate) attraction[i] += ring.areaHa * rate;
  }
}

function poiFallback(tags: Record<string, string>): number {
  if (tags.amenity === 'university' || tags.amenity === 'college') return 260;
  if (tags.amenity === 'hospital') return 320;
  if (tags.amenity === 'school') return 90;
  if (tags.amenity === 'kindergarten') return 45;
  if (tags.shop === 'supermarket' || tags.shop === 'mall') return 300;
  if (tags.shop) return 22;
  if (tags.office) return 28;
  if (tags.public_transport === 'station') return 140;
  if (tags.amenity) return 16;
  return 0;
}

function wayRing(
  el: Extract<OsmElement, { type: 'way' }>,
  net: RoadNetwork,
  nodePos: Map<number, [number, number]>,
): { cx: number; cy: number; areaHa: number } | null {
  const pts: [number, number][] = [];
  const geom = (el as { geometry?: [number, number][] }).geometry;
  if (geom) {
    for (const [lat, lon] of geom) pts.push([net.proj.x(lon), net.proj.y(lat)]);
  } else if (el.nodes) {
    for (const id of el.nodes) {
      const p = nodePos.get(id);
      if (p) pts.push(p);
    }
  }
  if (pts.length < 3) return null;

  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const cross = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    area2 += cross;
    cx += (pts[j][0] + pts[i][0]) * cross;
    cy += (pts[j][1] + pts[i][1]) * cross;
  }
  if (Math.abs(area2) < 1e-6) {
    const mx = pts.reduce((s, q) => s + q[0], 0) / pts.length;
    const my = pts.reduce((s, q) => s + q[1], 0) / pts.length;
    return { cx: mx, cy: my, areaHa: 0.05 };
  }
  return { cx: cx / (3 * area2), cy: cy / (3 * area2), areaHa: Math.abs(area2 / 2) / 10000 };
}

// --- Zonindelning -------------------------------------------------------------------

function clusterZones(cells: Cell[], k: number): Zone[] {
  if (cells.length === 0) return [];
  const K = Math.min(k, cells.length);
  const weight = cells.map((c) => c.production + c.attraction);

  const cx = new Float64Array(K);
  const cy = new Float64Array(K);
  let rng = 12345;
  const rand = (): number => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 4294967296;
  };
  const first = weightedPick(weight, rand());
  cx[0] = cells[first].x;
  cy[0] = cells[first].y;

  const best = new Float64Array(cells.length).fill(Infinity);
  for (let c = 1; c < K; c++) {
    for (let i = 0; i < cells.length; i++) {
      const d = (cells[i].x - cx[c - 1]) ** 2 + (cells[i].y - cy[c - 1]) ** 2;
      if (d < best[i]) best[i] = d;
    }
    const pick = weightedPick(cells.map((_, i) => best[i] * weight[i]), rand());
    cx[c] = cells[pick].x;
    cy[c] = cells[pick].y;
  }

  const assign = new Int32Array(cells.length);
  for (let iter = 0; iter < 18; iter++) {
    let moved = 0;
    for (let i = 0; i < cells.length; i++) {
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < K; c++) {
        const d = (cells[i].x - cx[c]) ** 2 + (cells[i].y - cy[c]) ** 2;
        if (d < bd) {
          bd = d;
          bi = c;
        }
      }
      if (assign[i] !== bi) moved++;
      assign[i] = bi;
    }
    const sx = new Float64Array(K);
    const sy = new Float64Array(K);
    const sw = new Float64Array(K);
    for (let i = 0; i < cells.length; i++) {
      const c = assign[i];
      const w = weight[i] + 1e-3;
      sx[c] += cells[i].x * w;
      sy[c] += cells[i].y * w;
      sw[c] += w;
    }
    for (let c = 0; c < K; c++) {
      if (sw[c] > 0) {
        cx[c] = sx[c] / sw[c];
        cy[c] = sy[c] / sw[c];
      }
    }
    if (moved === 0) break;
  }

  const zones: Zone[] = [];
  const retail = new Float64Array(K);
  const jobs = new Float64Array(K);
  for (let c = 0; c < K; c++) {
    zones.push({
      id: c, x: cx[c], y: cy[c], name: 'Zon ' + (c + 1),
      production: 0, attraction: 0,
      anchors: new Int32Array(0), destAnchors: new Int32Array(0),
      originX: cx[c], originY: cy[c], destX: cx[c], destY: cy[c],
      external: false, residents: 0, character: '',
    });
  }
  const ox = new Float64Array(K);
  const oy = new Float64Array(K);
  const ow = new Float64Array(K);
  const dx = new Float64Array(K);
  const dy = new Float64Array(K);
  const dw = new Float64Array(K);
  for (let i = 0; i < cells.length; i++) {
    const c = assign[i];
    const z = zones[c];
    z.production += cells[i].production;
    z.attraction += cells[i].attraction;
    z.residents += cells[i].residents;
    retail[c] += cells[i].retail;
    jobs[c] += cells[i].jobs;
    ox[c] += cells[i].x * cells[i].production;
    oy[c] += cells[i].y * cells[i].production;
    ow[c] += cells[i].production;
    dx[c] += cells[i].x * cells[i].attraction;
    dy[c] += cells[i].y * cells[i].attraction;
    dw[c] += cells[i].attraction;
  }
  for (const z of zones) {
    const c = z.id;
    if (ow[c] > 0) {
      z.originX = ox[c] / ow[c];
      z.originY = oy[c] / ow[c];
    }
    if (dw[c] > 0) {
      z.destX = dx[c] / dw[c];
      z.destY = dy[c] / dw[c];
    }
    z.character = describe(z, retail[c], jobs[c]);
  }
  return zones.filter((z) => z.production + z.attraction > 0);
}

/** Kort beskrivning av vad zonen är, för gränssnittet. */
function describe(z: Zone, retailArea: number, jobArea: number): string {
  const ratio = z.attraction / Math.max(z.production, 1);
  if (retailArea > 12000 || (ratio > 4 && retailArea > 4000)) return 'Handelsplats';
  if (ratio > 3) return 'Arbetsplats- och målområde';
  if (jobArea > 30000) return 'Verksamhetsområde';
  if (ratio < 0.45) return 'Bostadsområde';
  return 'Blandad bebyggelse';
}

function weightedPick(weights: number[] | Float64Array, r: number): number {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  if (total <= 0) return 0;
  let acc = r * total;
  for (let i = 0; i < weights.length; i++) {
    acc -= weights[i];
    if (acc <= 0) return i;
  }
  return weights.length - 1;
}

// --- Infartsleder -------------------------------------------------------------------

/**
 * Yttre zoner: där vägnätet klipps av kartutsnittet kommer trafik in utifrån.
 *
 * Volymen skattas ur ledens kapacitet i stället för ur bebyggelse — en motorväg
 * bär den trafik den bär oavsett vad som ligger vid kartkanten. För Uppsala är
 * det E4, väg 55, 272, 282 och 288. Utan den här delen står lederna tomma i
 * modellen medan trafiken pressas ut på gator som aldrig burit den.
 */
function boundaryZones(net: RoadNetwork, opts: DemandOptions): Zone[] {
  const b = net.bounds;
  const EDGE = 1500;
  const atEdge = (x: number, y: number): boolean =>
    x - b.minX < EDGE || b.maxX - x < EDGE || y - b.minY < EDGE || b.maxY - y < EDGE;

  const raw: {
    x: number; y: number; capacity: number; inbound: number[]; outbound: number[];
    name: string; cls: number;
  }[] = [];

  // Nätets kanter hittas som käll- och sänknoder, inte som "grad 1".
  //
  // En dubbelriktad led klipps i två skilda punkter, en per körbana, och den
  // körbana som slutar strax efter en påfartsramp har grad två — inte ett. Med
  // gradvillkoret hittas då bara den ena riktningen, och leden får trafik in men
  // ingen väg ut. Trafiken kommer in på länkar som utgår från en källnod och
  // lämnar nätet på länkar som mynnar i en sänknod.
  for (let n = 0; n < net.nodeCount; n++) {
    const outs = net.nodeOutStart[n + 1] - net.nodeOutStart[n];
    const ins = net.nodeInStart[n + 1] - net.nodeInStart[n];
    const isSource = ins === 0 && outs > 0;
    const isSink = outs === 0 && ins > 0;
    const isDeadEnd = junctionDegree(net, n) === 1;
    if (!isSource && !isSink && !isDeadEnd) continue;

    let cls = 99;
    let capacity = 0;
    const inbound: number[] = [];
    const outbound: number[] = [];
    if (isSource || isDeadEnd) {
      for (let k = net.nodeOutStart[n]; k < net.nodeOutStart[n + 1]; k++) {
        const l = net.nodeOut[k];
        cls = Math.min(cls, net.linkClass[l]);
        capacity += net.linkCapacity[l] * net.linkLanes[l];
        inbound.push(l);
      }
    }
    if (isSink || isDeadEnd) {
      for (let k = net.nodeInStart[n]; k < net.nodeInStart[n + 1]; k++) {
        const l = net.nodeIn[k];
        cls = Math.min(cls, net.linkClass[l]);
        if (isSink) capacity += net.linkCapacity[l] * net.linkLanes[l];
        outbound.push(l);
      }
    }
    if (cls > RoadClass.Tertiary || inbound.length + outbound.length === 0) continue;
    if (cls > RoadClass.Secondary && !atEdge(net.nodeX[n], net.nodeY[n])) continue;

    raw.push({
      x: net.nodeX[n], y: net.nodeY[n], capacity: capacity || 1000, inbound, outbound, cls,
      name: net.names[net.linkNameId[(inbound[0] ?? outbound[0]) as number]] || 'väg',
    });
  }

  // En led som är uppdelad i två körriktningar ger två ändar — slå ihop dem.
  const MERGE = 400;
  const used = new Array(raw.length).fill(false);
  const zones: Zone[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (used[i]) continue;
    const group = [raw[i]];
    used[i] = true;
    for (let j = i + 1; j < raw.length; j++) {
      if (used[j] || Math.hypot(raw[j].x - raw[i].x, raw[j].y - raw[i].y) > MERGE) continue;
      used[j] = true;
      group.push(raw[j]);
    }
    // Grupperna innehåller båda körbanorna; kapaciteten avser leden som helhet.
    const capacity = group.reduce((s, g) => s + g.capacity, 0);
    const cls = Math.min(...group.map((g) => g.cls));

    // Skattad årsdygnstrafik som andel av ledens timkapacitet gånger dygnet.
    //
    // Nivåerna är satta så att en fyrfältig motorväg landar kring 45 000 fordon
    // per dygn och en tvåfältig länsväg kring 10 000 — det är vad sådana leder
    // faktiskt bär in mot en stad av Uppsalas storlek. Räknas de högre pressas
    // mer trafik in i nätet än det kan svälja, och allt saktar ner.
    const utilisation =
      cls <= RoadClass.Trunk ? 0.22 : cls <= RoadClass.Primary ? 0.12 : 0.08;
    const adt = capacity * 24 * utilisation * opts.corridorScale;

    const inbound = group.flatMap((g) => g.inbound);
    const outbound = group.flatMap((g) => g.outbound);
    if (inbound.length === 0 && outbound.length === 0) continue;
    zones.push({
      id: 0,
      x: group.reduce((s, g) => s + g.x, 0) / group.length,
      y: group.reduce((s, g) => s + g.y, 0) / group.length,
      name: 'Infart ' + group[0].name,
      production: adt / 2,
      attraction: adt / 2,
      anchors: Int32Array.from(inbound.length ? inbound : outbound),
      destAnchors: Int32Array.from(outbound.length ? outbound : inbound),
      originX: group.reduce((s, g) => s + g.x, 0) / group.length,
      originY: group.reduce((s, g) => s + g.y, 0) / group.length,
      destX: group.reduce((s, g) => s + g.x, 0) / group.length,
      destY: group.reduce((s, g) => s + g.y, 0) / group.length,
      external: true,
      residents: 0,
      character: cls <= RoadClass.Trunk ? 'Infartsled, motorväg' : 'Infartsled',
    });
  }
  return zones;
}

// --- Matrisen -------------------------------------------------------------------------

/**
 * Avståndsmotstånd enligt Tanners funktion: en potens gånger en exponential.
 *
 * En ren exponential ger för få långa resor. Verkligheten har en lång svans av
 * arbetspendling och ärenden tvärs över staden, och det är den svansen som
 * fyller lederna. Potensdelen håller uppe de långa resorna, exponentialdelen ser
 * till att svansen ändå tar slut. Sista faktorn dämpar de allra kortaste
 * resorna, som i praktiken görs till fots.
 */
function deterrence(km: number, meanKm: number): number {
  const d = Math.max(km, 0.35);
  const beta = 1.6 / meanKm;
  return Math.pow(d, -0.55) * Math.exp(-beta * d) * (1 - Math.exp(-d / 0.9));
}

function buildMatrix(zones: Zone[], internalCount: number, opts: DemandOptions): Float32Array {
  const n = zones.length;
  const od = new Float32Array(n * n);
  const km = (a: Zone, z: Zone): number => Math.hypot(z.x - a.x, z.y - a.y) / 1000;

  // --- 1. Resor inom staden ---------------------------------------------------
  let internalSum = 0;
  const target = zones.slice(0, internalCount).reduce((s, z) => s + z.production, 0);
  for (let i = 0; i < internalCount; i++) {
    for (let j = 0; j < internalCount; j++) {
      if (i === j) continue;
      const t =
        zones[i].production * zones[j].attraction *
        deterrence(km(zones[i], zones[j]), opts.meanTripKm);
      od[i * n + j] = t;
      internalSum += t;
    }
  }
  if (internalSum > 0) {
    const scale = target / internalSum;
    for (let i = 0; i < internalCount; i++) {
      for (let j = 0; j < internalCount; j++) od[i * n + j] *= scale;
    }
  }

  // --- 2. Ledtrafiken ----------------------------------------------------------
  // Genomfarten fördelas mellan lederna efter deras storlek. Den led trafiken
  // kom in på är inte ett rimligt mål för samma resa.
  const attractionSum = zones.slice(0, internalCount).reduce((s, z) => s + z.attraction, 0) || 1;
  const productionSum = target || 1;

  for (let e = internalCount; e < n; e++) {
    const inbound = zones[e].production;
    const through = inbound * opts.throughShare;
    const toCity = inbound - through;

    let peerWeight = 0;
    for (let o = internalCount; o < n; o++) if (o !== e) peerWeight += zones[o].attraction;
    if (peerWeight > 0) {
      for (let o = internalCount; o < n; o++) {
        if (o === e) continue;
        od[e * n + o] += through * (zones[o].attraction / peerWeight);
      }
    }

    for (let j = 0; j < internalCount; j++) {
      od[e * n + j] += toCity * (zones[j].attraction / attractionSum);
    }
    // Motsvarande utgående riktning: staden matar leden.
    const outbound = zones[e].attraction * (1 - opts.throughShare);
    for (let i = 0; i < internalCount; i++) {
      od[i * n + e] += outbound * (zones[i].production / productionSum);
    }
  }
  return od;
}

// --- Ankarlänkar -----------------------------------------------------------------------

/**
 * Kopplar varje zon till de länkar där fordon rimligen startar och slutar.
 *
 * En bostadsresa börjar på en lokalgata, men en resa till en handelsplats slutar
 * vid dess infart — inte på en villagata i närheten. Målzoner med stark
 * attraktion får därför uppsamlings- och genomfartsgator som ankare, så trafiken
 * kommer in på det stråk som faktiskt matar platsen.
 */
function attachAnchors(net: RoadNetwork, zones: Zone[]): void {
  const midX = new Float64Array(net.linkCount);
  const midY = new Float64Array(net.linkCount);
  for (let l = 0; l < net.linkCount; l++) {
    const s = net.linkGeomStart[l];
    const e = net.linkGeomStart[l + 1];
    const m = (s + e) >> 1;
    midX[l] = net.geomX[m];
    midY[l] = net.geomY[m];
  }
  const grid = new SpatialGrid(net.bounds, 500, net.linkCount, midX, midY);

  const search = (
    x: number, y: number, accept: (cls: number) => boolean,
  ): Int32Array => {
    const found: { link: number; d: number }[] = [];
    for (let radius = 500; radius <= 2800 && found.length < 10; radius *= 2) {
      found.length = 0;
      grid.forEachNear(x, y, radius, (l) => {
        if (!accept(net.linkClass[l])) return;
        const d = Math.hypot(midX[l] - x, midY[l] - y);
        if (d <= radius) found.push({ link: l, d });
      });
    }
    found.sort((a, b) => a.d - b.d);
    return Int32Array.from(found.slice(0, 30).map((f) => f.link));
  };

  // Resor börjar på bostadsgator och slutar på de stråk som matar målpunkterna.
  const origin = (c: number): boolean => c >= RoadClass.Tertiary && c !== RoadClass.Service;
  const destination = (c: number): boolean =>
    c >= RoadClass.Secondary && c <= RoadClass.Residential;

  for (const z of zones) {
    if (z.external) continue;
    z.anchors = search(z.originX, z.originY, origin);
    z.destAnchors = search(z.destX, z.destY, destination);
    if (z.anchors.length === 0) z.anchors = z.destAnchors;
    if (z.destAnchors.length === 0) z.destAnchors = z.anchors;
  }
}

function normalise(a: number[]): Float32Array {
  const s = a.reduce((x, y) => x + y, 0);
  return Float32Array.from(a, (v) => v / s);
}

/** Efterfrågan i fordon per timme vid en given tidpunkt (timmar sedan midnatt). */
export function flowAt(dm: DemandModel, hour: number): number {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  return dm.totalTrips * dm.profile[h];
}

// --- CSV ------------------------------------------------------------------------

/**
 * Läser en OD-matris. Format: `från,till,fordon_per_dygn` med zonnamn eller
 * zonnummer, alternativt `från_lat,från_lon,till_lat,till_lon,fordon_per_dygn`.
 */
export function importOdCsv(
  text: string,
  dm: DemandModel,
  net: RoadNetwork,
): { applied: number; skipped: number } {
  const n = dm.zones.length;
  const byName = new Map(dm.zones.map((z) => [z.name.toLowerCase(), z.id]));
  const od = new Float32Array(n * n);
  let applied = 0;
  let skipped = 0;

  for (const line of text.split(/\r?\n/)) {
    const row = line.trim();
    if (!row || row.startsWith('#')) continue;
    const parts = row.split(/[,;\t]/).map((s) => s.trim());
    if (parts.length < 3) continue;
    if (/^[a-zA-ZåäöÅÄÖ_ ]+$/.test(parts[0]) && Number.isNaN(Number(parts[2]))) continue;

    let from: number;
    let to: number;
    let value: number;
    if (parts.length >= 5 && !Number.isNaN(Number(parts[3]))) {
      from = zoneAt(dm, net, Number(parts[0]), Number(parts[1]));
      to = zoneAt(dm, net, Number(parts[2]), Number(parts[3]));
      value = Number(parts[4]);
    } else {
      from = resolveZone(parts[0], byName);
      to = resolveZone(parts[1], byName);
      value = Number(parts[2]);
    }
    if (from < 0 || to < 0 || from >= n || to >= n || !Number.isFinite(value)) {
      skipped++;
      continue;
    }
    od[from * n + to] += value;
    applied++;
  }

  if (applied > 0) {
    dm.od.set(od);
    dm.totalTrips = od.reduce((a, b) => a + b, 0);
  }
  return { applied, skipped };
}

function resolveZone(token: string, byName: Map<string, number>): number {
  const byIndex = Number(token);
  if (Number.isInteger(byIndex)) return byIndex;
  return byName.get(token.toLowerCase()) ?? -1;
}

export function zoneAt(dm: DemandModel, net: RoadNetwork, lat: number, lon: number): number {
  return nearestZone(dm, net.proj.x(lon), net.proj.y(lat));
}

export function nearestZone(dm: DemandModel, x: number, y: number): number {
  let best = -1;
  let bd = Infinity;
  for (const z of dm.zones) {
    const d = (z.x - x) ** 2 + (z.y - y) ** 2;
    if (d < bd) {
      bd = d;
      best = z.id;
    }
  }
  return best;
}

export function exportOdCsv(dm: DemandModel): string {
  const n = dm.zones.length;
  const rows: string[] = ['från,till,fordon_per_dygn'];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = dm.od[i * n + j];
      if (v >= 0.5) rows.push(`${dm.zones[i].name},${dm.zones[j].name},${v.toFixed(1)}`);
    }
  }
  return rows.join('\n');
}
