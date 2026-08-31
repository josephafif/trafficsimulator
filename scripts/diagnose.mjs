/**
 * Diagnos av fordon som blir stående, och av korsningarnas genomströmning.
 *
 *   node scripts/diagnose.mjs [simminuter] [efterfrågeskala]
 *
 * Ett fåtal fordon som står länge i en hårt belastad rusning är normalt. Blir de
 * många, eller står något fordon kvar sedan simuleringen började, är det ett fel i
 * modellen och inte en kö — och då talar den här körningen om var det sitter.
 *
 * Kedjan följs bakåt från varje fastlåst fordon till den punkt som faktiskt
 * blockerar: den som står främst och inte väntar på något annat fordon.
 */
import { readFileSync } from 'node:fs';
import { buildAll } from '../src/net/build.ts';
import { buildDemand, DEFAULT_DEMAND } from '../src/demand/demand.ts';
import { Simulation } from '../src/sim/engine.ts';
import { DEFAULT_CONFIG } from '../src/sim/config.ts';
import { VState } from '../src/sim/state.ts';
import { GroupState } from '../src/net/signals.ts';
import { CLASS_DEFAULTS, NodeControl } from '../src/osm/tags.ts';
import { junctionDegree } from '../src/osm/network.ts';

const minutes = Number(process.argv[2] ?? 60);
const scale = Number(process.argv[3] ?? 1);
const raw = JSON.parse(readFileSync('public/data/uppsala.json', 'utf8'));
const { net, mv, signals } = buildAll(raw);
const demand = buildDemand(net, raw.land, DEFAULT_DEMAND, raw.buildings, raw.parking);
const sim = new Simulation(net, mv, signals, demand, {
  ...DEFAULT_CONFIG, startHour: 7, demandScale: scale,
});
sim.setFocus(net.proj.x(17.6389), net.proj.y(59.8586), 1600);
for (let i = 0; i < minutes * 60 * 4; i++) sim.step();

const s = sim.s;
const nameOf = (l) => net.names[net.linkNameId[l]] || '(namnlös)';
const headOfLane = (link, lane) => {
  const b = mv.laneBase[link] + lane;
  return s.bucketStart[b + 1] > s.bucketStart[b] ? s.order[s.bucketStart[b]] : -1;
};

/** Varför står fordonet? Returnerar [orsak, nästa fordon i kedjan]. */
function why(v) {
  if (s.state[v] === VState.OnConn) {
    const c = s.conn[v];
    const tl = mv.connToLink[c];
    const tlane = Math.min(mv.connToLane[c], sim.linkLanes(tl) - 1);
    return [`står i korsningen, väntar på plats i ${nameOf(tl)}`, headOfLane(tl, tlane)];
  }
  if (s.state[v] !== VState.Micro) return ['mesotrafik', -1];

  const link = s.link[v];
  const lane = s.lane[v];
  const head = headOfLane(link, lane);
  if (head !== v) return ['i kö', head];

  const conn = s.nextConn[v];
  if (conn < 0) return ['främst men ingen framkomlig gren', -1];

  const g = mv.connSignalGroup[conn];
  if (g >= 0) {
    const st = signals.groupState[g];
    if (st === GroupState.Red || st === GroupState.RedAmber) return ['röd signal', -1];
  }
  const tl = mv.connToLink[conn];
  const tlane = Math.min(mv.connToLane[conn], sim.linkLanes(tl) - 1);
  const cb = mv.laneCount + conn;
  if (s.bucketStart[cb + 1] > s.bucketStart[cb]) {
    return [`rörelsen upptagen mot ${nameOf(tl)}`, s.order[s.bucketStart[cb + 1] - 1]];
  }
  if (!sim.spaceAfter(conn)) return [`nedströms fullt: ${nameOf(tl)}`, headOfLane(tl, tlane)];
  if (s.forcing[v] === 1) return ['tvingar sig fram men kommer ändå inte loss', -1];
  if (mv.connYield[conn] !== 0 && !sim.hasGap(v, conn)) return ['väjningsplikt: ingen lucka', -1];
  return ['inget hindrar men står ändå (misstänkt fel)', -1];
}

const orsak = new Map();
const plats = new Map();
let ringar = 0;
let fast = 0;
let längst = 0;

for (let v0 = 0; v0 < s.capacity; v0++) {
  if (s.state[v0] === VState.Pending || s.waited[v0] < 120) continue;
  fast++;
  längst = Math.max(längst, s.waited[v0]);
  const sedda = new Set();
  let v = v0;
  let skäl = null;
  for (let hopp = 0; hopp < 400; hopp++) {
    if (sedda.has(v)) {
      ringar++;
      skäl = 'ring av fulla gator';
      break;
    }
    sedda.add(v);
    const [r, nästa] = why(v);
    if (nästa < 0) { skäl = r; break; }
    v = nästa;
  }
  orsak.set(skäl ?? 'kedjan för lång', (orsak.get(skäl ?? 'kedjan för lång') ?? 0) + 1);
  if (s.state[v] === VState.Micro) {
    const k = `${nameOf(s.link[v])} (${CLASS_DEFAULTS[net.linkClass[s.link[v]]].label})`;
    plats.set(k, (plats.get(k) ?? 0) + 1);
  }
}

const st = sim.networkStats();
console.log(`\n=== ${net.name}, ${minutes} min från kl 7, efterfrågan ${(scale * 100).toFixed(0)} % ===`);
console.log(`${st.active} fordon i nätet, ${(st.meanSpeed * 3.6).toFixed(1)} km/h\n`);
console.log(`fast över 2 min: ${fast} (${((100 * fast) / Math.max(st.active, 1)).toFixed(1)} %), ` +
  `längsta väntan ${(längst / 60).toFixed(0)} min, varav ${ringar} i ringar av fulla gator\n`);
console.log('rot till blockeringen:');
for (const [k, n] of [...orsak].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${k}`);
}
console.log('\nvar roten sitter:');
for (const [k, n] of [...plats].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(5)}  ${k}`);
}

// --- Korsningarnas genomströmning ------------------------------------------------
const ctlNamn = ['ingen', 'företräde', 'SIGNAL', 'rondell', 'stopp', 'väjning'];
function riktvärde(node, inLanes) {
  const ctl = net.nodeControl[node];
  if (ctl === NodeControl.Signal) return inLanes * 700;
  if (ctl === NodeControl.Roundabout) return inLanes * 900;
  return junctionDegree(net, node) <= 2 ? inLanes * 1600 : inLanes * 500;
}

const korsningar = [];
for (let n = 0; n < net.nodeCount; n++) {
  if (junctionDegree(net, n) < 3) continue;
  let flöde = 0;
  let kö = 0;
  let fält = 0;
  let mikro = false;
  for (let k = net.nodeInStart[n]; k < net.nodeInStart[n + 1]; k++) {
    const l = net.nodeIn[k];
    if (sim.linkMicro[l] === 1) mikro = true;
    flöde += sim.stats.flow[l];
    kö += sim.stats.queue[l];
    fält += sim.linkLanes(l);
  }
  if (mikro && kö >= 8) korsningar.push({ n, flöde, kö, fält, exp: riktvärde(n, fält) });
}
korsningar.sort((a, b) => b.kö - a.kö);

console.log(`\nmest köade mikrokorsningar (${korsningar.length} med kö >= 8 fordon):`);
for (const r of korsningar.slice(0, 10)) {
  const namn = [];
  for (let k = net.nodeInStart[r.n]; k < net.nodeInStart[r.n + 1]; k++) {
    const nm = nameOf(net.nodeIn[k]);
    if (nm !== '(namnlös)' && !namn.includes(nm)) namn.push(nm);
  }
  console.log(
    `  kö ${String(Math.round(r.kö)).padStart(3)}  ${Math.round(r.flöde).toString().padStart(5)} f/h ` +
    `av ~${r.exp} (${((100 * r.flöde) / r.exp).toFixed(0)} %)  ` +
    `${ctlNamn[net.nodeControl[r.n]].padEnd(8)} ${namn.slice(0, 2).join(' / ')}`,
  );
}
