/// <reference lib="webworker" />
/**
 * Simuleringstråden. Äger nätet, efterfrågan och fordonen, och skickar en
 * renderingsbuffert till huvudtråden några gånger per sekund.
 *
 * Bufferten återanvänds: huvudtråden skickar tillbaka den när den ritat klart.
 * Har ingen buffert kommit tillbaka hoppas bildrutan över, vilket ger ett naturligt
 * mottryck om renderingen inte hinner med.
 */

import { buildAll } from '../net/build.ts';
import { buildDemand, DEFAULT_DEMAND, exportOdCsv, importOdCsv } from '../demand/demand.ts';
import type { CityData } from '../osm/network.ts';
import { CLASS_DEFAULTS } from '../osm/tags.ts';
import { cycleLength, optimiseWebster, resetController, setGreenWave, GroupState } from '../net/signals.ts';
import { Simulation } from './engine.ts';
import { DEFAULT_CONFIG, VEHICLE_CLASSES, type SimConfig } from './config.ts';
import { VState } from './state.ts';
import {
  LinkMetric,
  VEHICLE_STRIDE,
  type Bottleneck,
  type FromWorker,
  type LinkInfo,
  type RenderNetwork,
  type RenderSignal,
  type ScenarioSummary,
  type ToWorker,
  type VehicleInfo,
} from './protocol.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let sim: Simulation | null = null;
let raw: CityData | null = null;
let playing = false;
let speedFactor = 4;
let metric: LinkMetric = LinkMetric.Speed;

/** Bufferten som är ledig att fylla. Null medan huvudtråden ritar med den. */
let freeBuffer: ArrayBuffer | null = null;
let secondBuffer: ArrayBuffer | null = null;
let lastTick = 0;
let simStart = 0;
const scenarios: ScenarioSummary[] = [];
/** Fordon som gränssnittet följer; dess uppgifter skickas med varje bildruta. */
let followed = -1;
/**
 * Steg kvar av uppvärmningen efter ett tidshopp.
 *
 * Ett tomt nät säger ingenting om hur en rusning ser ut, så trafiken byggs upp
 * till den valda tiden innan bilden visas. Tio minuter räcker för att korta
 * resor ska hinna fram och långa vara igång.
 */
let warmupLeft = 0;
const WARMUP_SECONDS = 10 * 60;

const post = (msg: FromWorker, transfer: Transferable[] = []): void => {
  ctx.postMessage(msg, transfer);
};

ctx.onmessage = (e: MessageEvent<ToWorker>): void => {
  try {
    handle(e.data);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

function handle(msg: ToWorker): void {
  if (msg.type === 'init') {
    void init(msg.url, msg.maxVehicles);
    return;
  }
  if (msg.type === 'returnBuffer') {
    if (!freeBuffer) freeBuffer = msg.buffer;
    else secondBuffer = msg.buffer;
    return;
  }
  if (!sim) return;

  switch (msg.type) {
    case 'run':
      playing = msg.playing;
      speedFactor = msg.speed;
      lastTick = performance.now();
      break;
    case 'config':
      Object.assign(sim.config, msg.patch);
      break;
    case 'demand': {
      const d = sim.demand;
      if (msg.patch.totalTrips !== undefined && msg.patch.totalTrips > 0) {
        const scale = msg.patch.totalTrips / Math.max(d.totalTrips, 1);
        for (let i = 0; i < d.od.length; i++) d.od[i] *= scale;
        d.totalTrips = msg.patch.totalTrips;
        sim.rebuildOd();
      }
      break;
    }
    case 'focus':
      if (msg.full) sim.setFullMicro();
      else sim.setFocus(msg.x, msg.y, msg.radius);
      break;
    case 'metric':
      metric = msg.metric;
      break;
    case 'closeLink':
      sim.closeLink(msg.link, msg.closed);
      break;
    case 'setLanes':
      sim.setLanes(msg.link, msg.lanes);
      break;
    case 'setSpeed':
      sim.setSpeedLimit(msg.link, msg.kmh);
      break;
    case 'signalPlan': {
      const c = sim.signals.controllers[msg.id];
      if (c) {
        c.phases = msg.phases;
        c.offset = msg.offset;
        c.mode = msg.mode;
        c.gapOut = msg.gapOut;
        resetController(sim.signals, msg.id);
        sim.computeNodeDelays();
        post({ type: 'signalUpdated', signals: renderSignals(sim) });
      }
      break;
    }
    case 'signalOptimise':
      optimiseWebster(sim.signals, sim.net, sim.groupFlow);
      sim.computeNodeDelays();
      post({ type: 'signalUpdated', signals: renderSignals(sim) });
      break;
    case 'greenWave':
      setGreenWave(sim.signals, msg.ids, msg.speedKmh / 3.6);
      sim.computeNodeDelays();
      post({ type: 'signalUpdated', signals: renderSignals(sim) });
      break;
    case 'manualFlow': {
      const flows = sim.demand.manualFlows;
      const i = flows.findIndex((f) => f.id === msg.flow.id);
      if (i >= 0) flows[i] = msg.flow;
      else flows.push(msg.flow);
      break;
    }
    case 'removeFlow': {
      const flows = sim.demand.manualFlows;
      const i = flows.findIndex((f) => f.id === msg.id);
      if (i >= 0) flows.splice(i, 1);
      break;
    }
    case 'importOd': {
      const r = importOdCsv(msg.csv, sim.demand, sim.net);
      sim.rebuildOd();
      post({ type: 'odImported', applied: r.applied, skipped: r.skipped });
      break;
    }
    case 'exportOd':
      post({ type: 'odCsv', csv: exportOdCsv(sim.demand) });
      break;
    case 'reset':
      rebuildSimulation(sim.config);
      break;
    case 'snapshot': {
      scenarios.push({
        id: scenarios.length,
        name: 'Körning ' + (scenarios.length + 1),
        stats: sim.networkStats(),
        simMinutes: (sim.time - simStart) / 60,
      });
      post({ type: 'scenarios', list: scenarios });
      break;
    }
    case 'inspect':
      post({ type: 'linkInfo', info: linkInfo(sim, msg.link) });
      break;
    case 'inspectVehicle':
      post({ type: 'vehicleInfo', info: vehicleInfo(sim, msg.vehicle) });
      break;
    case 'followVehicle':
      followed = msg.vehicle;
      break;
    case 'setHour':
      setHour(msg.hour);
      break;
  }
}

async function init(url: string, maxVehicles?: number): Promise<void> {
  post({ type: 'progress', text: 'Hämtar kartdata …' });
  const res = await fetch(url);
  const key = url.split('/').pop()?.replace('.json', '') ?? 'stad';
  // Meddelandet måste fungera både lokalt och i en publicerad version, där det
  // inte går att köra något kommando.
  const missing =
    'Kartdata för "' + key + '" saknas. Kör projektet lokalt och hämta den med ' +
    '"npm run fetch ' + key + '", så följer den med nästa bygge.';
  if (!res.ok) throw new Error(missing);
  const text = await res.text();
  if (!text.startsWith('{')) throw new Error(missing);
  raw = JSON.parse(text) as CityData;

  post({ type: 'progress', text: 'Bygger vägnät och korsningar …' });
  rebuildSimulation({ ...DEFAULT_CONFIG, maxVehicles: maxVehicles ?? DEFAULT_CONFIG.maxVehicles });
  post({ type: 'progress', text: 'Klart' });

  const s = sim!;
  post({
    type: 'ready',
    network: renderNetwork(s),
    stats: s.networkStats(),
    demandTotal: s.demand.totalTrips,
    population: s.demand.population,
  });
  startLoop();
}

function rebuildSimulation(config: SimConfig): void {
  if (!raw) return;
  const { net, mv, signals } = buildAll(raw);
  const demand = buildDemand(net, raw.land, DEFAULT_DEMAND, raw.buildings, raw.parking);
  sim = new Simulation(net, mv, signals, demand, config);
  simStart = sim.time;

  const stride = VEHICLE_STRIDE * 4;
  freeBuffer = new ArrayBuffer(config.maxVehicles * stride);
  secondBuffer = new ArrayBuffer(config.maxVehicles * stride);
}

function renderNetwork(s: Simulation): RenderNetwork {
  const { net, mv } = s;
  return {
    places: s.demand.places.slice(0, 300).map((p) => ({
      name: p.name,
      x: p.x,
      y: p.y,
      kind: placeKind(p.use),
      pull: p.pull,
    })),
    name: net.name,
    bbox: net.bbox,
    lat0: net.proj.lat0,
    lon0: net.proj.lon0,
    bounds: { ...net.bounds },
    linkCount: net.linkCount,
    linkGeomStart: net.linkGeomStart,
    geomX: net.geomX,
    geomY: net.geomY,
    geomCum: net.geomCum,
    linkLanes: net.linkLanes,
    linkLaneWidth: net.linkLaneWidth,
    linkClass: net.linkClass,
    linkSpeed: net.linkSpeed,
    linkCapacity: net.linkCapacity,
    linkFrom: net.linkFrom,
    linkTo: net.linkTo,
    linkReverse: net.linkReverse,
    linkNameId: net.linkNameId,
    linkStartOff: mv.linkStartOff,
    linkDriveLen: mv.linkDriveLen,
    names: net.names,
    nodeX: net.nodeX,
    nodeY: net.nodeY,
    nodeControl: net.nodeControl,
    signals: renderSignals(s),
    zones: s.demand.zones.map((z) => ({
      id: z.id, x: z.x, y: z.y, name: z.name,
      production: z.production, attraction: z.attraction, external: z.external,
    })),
  };
}

function renderSignals(s: Simulation): RenderSignal[] {
  return s.signals.controllers.map((c) => {
    const groupLinks: number[] = [];
    for (let g = 0; g < s.signals.groupCount; g++) {
      if (s.signals.groupCtrl[g] === c.id) groupLinks.push(s.signals.groupLink[g]);
    }
    return {
      id: c.id, x: c.x, y: c.y, name: c.name,
      phaseCount: c.phases.length, cycle: cycleLength(c), offset: c.offset,
      mode: c.mode, gapOut: c.gapOut,
      phases: c.phases.map((p) => ({ ...p, groups: [...p.groups] })),
      groupLinks,
    };
  });
}

/** Allt om en enskild bils resa: varifrån, vart, hur långt kvar och hur det gått. */
function vehicleInfo(s: Simulation, v: number): VehicleInfo | null {
  if (v < 0 || v >= s.s.capacity || s.s.state[v] === VState.Pending) return null;
  const pose = { x: 0, y: 0, heading: 0 };
  if (!s.vehiclePose(v, pose)) return null;

  const zones = s.demand.zones;
  const dest = zones[s.s.destZone[v]] ?? zones[0];
  const from = zones[s.s.originZone[v]] ?? dest;
  const onConn = s.s.state[v] === VState.OnConn;
  const link = onConn ? s.mv.connToLink[s.s.conn[v]] : s.s.link[v];
  const route = s.routeAhead(v);

  return {
    vehicle: v,
    typeName: VEHICLE_CLASSES[s.s.type[v]].label,
    originName: from.name,
    originCharacter: from.character,
    originX: from.originX,
    originY: from.originY,
    destName: dest.name,
    destCharacter: dest.character,
    destX: dest.destX,
    destY: dest.destY,
    elapsed: s.time - s.s.enterTime[v],
    travelled: s.s.distance[v],
    remaining: route.metres,
    delaySeconds: s.s.delay[v],
    stops: s.s.stops[v],
    speedKmh: s.s.speed[v] * 3.6,
    onStreet: link >= 0 ? s.net.names[s.net.linkNameId[link]] || 'Namnlös gata' : '—',
    streetClass: link >= 0 ? CLASS_DEFAULTS[s.net.linkClass[link]].label : '—',
    x: pose.x,
    y: pose.y,
    route: route.points,
    detailed: s.s.state[v] !== VState.Meso,
  };
}

/**
 * Hoppar till ett klockslag och kör upp trafiken till det läget.
 *
 * Ett tomt nät säger ingenting om hur en rusning ser ut, så nätet fylls med den
 * trafik som hör till tiden innan bilden visas. Uppvärmningen körs med grov
 * upplösning — det som ska stämma är hur mycket trafik som är ute och var, inte
 * var varje enskild bil står.
 */
function setHour(hour: number): void {
  if (!sim) return;
  sim.reset();
  sim.setTime(hour * 3600);
  simStart = sim.time;
  // Uppvärmningen körs i portioner inne i den vanliga loopen i stället för i ett
  // svep. Ett svep tar tjugo sekunder och låser tråden hela tiden — inga
  // bildrutor, ingen klocka, inget som säger att något händer.
  warmupLeft = Math.round(WARMUP_SECONDS / DEFAULT_CONFIG.dt);
  post({ type: 'progress', text: 'Fyller nätet med trafik för kl ' + String(hour).padStart(2, '0') + ':00 …' });
}

/** Grupperar byggnadsanvändning till de kategorier kartan visar. */
function placeKind(use: number): number {
  switch (use) {
    case 3: return 0; // handel
    case 4: return 1; // kontor
    case 5: return 2; // industri och lager
    case 6:
    case 7: return 3; // skola och universitet
    case 8: return 4; // vård
    default: return 5;
  }
}

function linkInfo(s: Simulation, link: number): LinkInfo {
  const net = s.net;
  return {
    link,
    name: net.names[net.linkNameId[link]] || 'Namnlös gata',
    className: CLASS_DEFAULTS[net.linkClass[link]].label,
    lanes: s.linkLanes(link),
    speedKmh: Math.round(s.linkSpeed(link) * 3.6),
    flow: s.stats.flow[link],
    saturation: s.stats.saturation[link],
    queue: s.stats.queue[link],
    delayHours: s.stats.delay[link] / 3600,
    meanSpeedKmh: s.stats.speed[link] * 3.6,
    closed: s.linkClosed[link] === 1,
    lengthM: net.linkLength[link],
    reverse: net.linkReverse[link],
  };
}

// --- Körslinga ---------------------------------------------------------------------

function startLoop(): void {
  lastTick = performance.now();
  const tick = (): void => {
    const now = performance.now();
    const wall = Math.min((now - lastTick) / 1000, 0.5);
    lastTick = now;

    if (warmupLeft > 0 && sim) {
      const end = now + 26;
      while (warmupLeft > 0 && performance.now() < end) {
        sim.step();
        warmupLeft--;
      }
      if (warmupLeft === 0) post({ type: 'progress', text: '' });
      else {
        const done = 1 - warmupLeft / (WARMUP_SECONDS / DEFAULT_CONFIG.dt);
        post({ type: 'progress', text: 'Fyller nätet med trafik … ' + Math.round(done * 100) + ' %' });
      }
    } else if (playing && sim) {
      const target = wall * speedFactor;
      const dt = sim.config.dt;
      // Ta aldrig fler steg än vad som hinns med — annars halkar tråden efter
      // och blir sittande i en spiral av inhämtningssteg.
      const maxSteps = 240;
      let steps = Math.min(maxSteps, Math.round(target / dt));
      const budgetEnd = now + 28;
      while (steps-- > 0) {
        sim.step(dt);
        if (performance.now() > budgetEnd) break;
      }
    }
    if (sim) sendFrame(sim);
    ctx.setTimeout(tick, 16);
  };
  tick();
}

function sendFrame(s: Simulation): void {
  const buffer = freeBuffer;
  if (!buffer) return;
  freeBuffer = secondBuffer;
  secondBuffer = null;

  const view = new Float32Array(buffer);
  const pose = { x: 0, y: 0, heading: 0 };
  let n = 0;
  const cap = Math.floor(view.length / VEHICLE_STRIDE);

  for (let v = 0; v < s.s.capacity && n < cap; v++) {
    if (s.s.state[v] === VState.Pending) continue;
    if (!s.vehiclePose(v, pose)) continue;
    const o = n * VEHICLE_STRIDE;
    view[o] = pose.x;
    view[o + 1] = pose.y;
    view[o + 2] = pose.heading;
    // Packa fordonstyp, om det står stilla, och om det körs meso i ett tal.
    const stopped = s.s.speed[v] < 1 ? 1 : 0;
    const meso = s.s.state[v] === VState.Meso ? 1 : 0;
    view[o + 3] = s.s.type[v] + stopped * 8 + meso * 16;
    view[o + 4] = v;
    n++;
  }

  if (followed >= 0) {
    const info = vehicleInfo(s, followed);
    post({ type: 'vehicleInfo', info });
    if (!info) followed = -1;
  }

  post(
    {
      type: 'frame',
      buffer,
      vehicleCount: n,
      linkMetric: linkMetricValues(s),
      signalState: signalStates(s),
      stats: s.networkStats(),
      bottlenecks: bottleneckList(s),
    },
    [buffer],
  );
}

/** Värde per länk i intervallet 0–1 som renderaren färglägger efter. */
function linkMetricValues(s: Simulation): Float32Array {
  const n = s.net.linkCount;
  const out = new Float32Array(n);
  for (let l = 0; l < n; l++) {
    if (s.linkClosed[l]) {
      out[l] = -1;
      continue;
    }
    switch (metric) {
      case LinkMetric.Speed: {
        // 1 = fri hastighet, 0 = stillastående.
        const free = s.linkSpeed(l);
        const now = s.stats.vehicles[l] > 0 ? s.stats.speed[l] : free;
        out[l] = Math.min(1, Math.max(0, now / free));
        break;
      }
      case LinkMetric.Flow:
        out[l] = Math.min(1, s.stats.flow[l] / 2000);
        break;
      case LinkMetric.Saturation:
        out[l] = Math.min(1.2, s.stats.saturation[l]);
        break;
      case LinkMetric.Queue:
        out[l] = Math.min(1, s.stats.queue[l] / 25);
        break;
      case LinkMetric.Delay:
        out[l] = Math.min(1, s.stats.delay[l] / 7200);
        break;
      default:
        out[l] = s.net.linkClass[l] / 8;
    }
  }
  return out;
}

function signalStates(s: Simulation): Uint8Array {
  const out = new Uint8Array(s.signals.controllers.length);
  for (let i = 0; i < out.length; i++) {
    // Anläggningens läge sammanfattas till den bild som är mest "grön".
    let best: number = GroupState.Red;
    const c = s.signals.controllers[i];
    for (const p of c.phases) {
      for (const g of p.groups) {
        const st = s.signals.groupState[g];
        if (st === GroupState.Green) best = GroupState.Green;
        else if (st === GroupState.Amber && best !== GroupState.Green) best = GroupState.Amber;
      }
    }
    out[i] = best;
  }
  return out;
}

function bottleneckList(s: Simulation): Bottleneck[] {
  return s.bottlenecks(15).map((b) => {
    const g = s.net.linkGeomStart[b.link];
    const e = s.net.linkGeomStart[b.link + 1] - 1;
    return {
      link: b.link,
      name: s.net.names[s.net.linkNameId[b.link]] || 'Namnlös gata',
      className: CLASS_DEFAULTS[s.net.linkClass[b.link]].label,
      delayHours: b.delayHours,
      saturation: b.saturation,
      queue: b.queue,
      meanSpeedKmh: s.stats.speed[b.link] * 3.6,
      freeSpeedKmh: s.linkSpeed(b.link) * 3.6,
      x: (s.net.geomX[g] + s.net.geomX[e]) / 2,
      y: (s.net.geomY[g] + s.net.geomY[e]) / 2,
    };
  });
}
