/**
 * Bygger nätet i Node och skriver ut nyckeltal. Snabb återkoppling utan webbläsare —
 * de flesta fel i tagg- och korsningstolkningen syns direkt i statistiken här.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll } from '../src/net/build.ts';
import { YieldKind } from '../src/net/intersections.ts';
import { CLASS_DEFAULTS } from '../src/osm/tags.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const key = process.argv[2] ?? 'uppsala';
const raw = JSON.parse(readFileSync(resolve(__dirname, '..', 'public', 'data', key + '.json'), 'utf8'));

let t = Date.now();
const built = buildAll(raw);
const { net, mv } = built;

const km = (m) => (m / 1000).toFixed(1);
let totalLen = 0;
for (let i = 0; i < net.linkCount; i++) totalLen += net.linkLength[i];

console.log(`\n=== ${net.name} ===`);
console.log('bygge:      ' + Object.entries(built.timings).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(', ') + `  (totalt ${Date.now() - t} ms)`);
console.log(`mittblockssignaler utan korsning: ${built.midblockSignals}`);
console.log(`noder:      ${net.nodeCount}`);
console.log(`länkar:     ${net.linkCount}  (${km(totalLen)} km körfältsoberoende väglängd)`);
console.log(`körfält:    ${mv.laneCount}`);
console.log(`rörelser:   ${mv.connCount}`);
console.log(`konflikter: ${mv.conflict.length / 2} par`);
console.log(`område:     ${km(net.bounds.maxX - net.bounds.minX)} x ${km(net.bounds.maxY - net.bounds.minY)} km`);

const byClass = new Array(CLASS_DEFAULTS.length).fill(0);
const lenByClass = new Array(CLASS_DEFAULTS.length).fill(0);
for (let i = 0; i < net.linkCount; i++) {
  byClass[net.linkClass[i]]++;
  lenByClass[net.linkClass[i]] += net.linkLength[i];
}
console.log('\nvägklasser:');
for (let c = 0; c < byClass.length; c++) {
  if (byClass[c] === 0) continue;
  console.log(`  ${CLASS_DEFAULTS[c].label.padEnd(18)} ${String(byClass[c]).padStart(6)} länkar  ${km(lenByClass[c]).padStart(7)} km`);
}

const ctlNames = ['ingen', 'företräde', 'signal', 'rondell', 'stopp', 'väjning'];
const ctl = new Array(6).fill(0);
for (let n = 0; n < net.nodeCount; n++) ctl[net.nodeControl[n]]++;
console.log('\nnodstyrning:');
ctl.forEach((v, i) => v && console.log(`  ${ctlNames[i].padEnd(12)} ${v}`));

const y = [0, 0, 0];
for (let c = 0; c < mv.connCount; c++) y[mv.connYield[c]]++;
console.log(`\nföreträde:  ${y[YieldKind.Major]} med företräde, ${y[YieldKind.Give]} väjningsplikt, ${y[YieldKind.Stop]} stopplikt`);

// --- Sanitetskontroller ---------------------------------------------------------
let deadEnds = 0;
let unreachable = 0;
for (let l = 0; l < net.linkCount; l++) {
  const lb = mv.laneBase[l];
  let outs = 0;
  for (let lane = 0; lane < net.linkLanes[l]; lane++) {
    outs += mv.laneConnStart[lb + lane + 1] - mv.laneConnStart[lb + lane];
  }
  if (outs === 0) deadEnds++;
}
const hasIn = new Uint8Array(net.linkCount);
for (let c = 0; c < mv.connCount; c++) hasIn[mv.connToLink[c]] = 1;
for (let l = 0; l < net.linkCount; l++) if (!hasIn[l]) unreachable++;

console.log(`\nsanity:     ${deadEnds} länkar utan utgående rörelse, ${unreachable} utan inkommande`);

let zeroLane = 0;
let tooLong = 0;
for (let l = 0; l < net.linkCount; l++) {
  if (net.linkLanes[l] < 1) zeroLane++;
  if (net.linkLength[l] > 5000) tooLong++;
}
console.log(`            ${zeroLane} länkar utan körfält, ${tooLong} länkar över 5 km`);

const speeds = {};
for (let i = 0; i < net.linkCount; i++) {
  const kmh = Math.round(net.linkSpeed[i] * 3.6);
  speeds[kmh] = (speeds[kmh] ?? 0) + 1;
}
console.log('hastigheter:', Object.entries(speeds).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join('  '));

// --- Signaler --------------------------------------------------------------------
const { buildSignals, cycleLength, GroupState, stepSignals } = await import('../src/net/signals.ts');
t = Date.now();
const sig = buildSignals(net, mv);
console.log(`\nsignaler:   ${sig.controllers.length} anläggningar, ${sig.groupCount} signalgrupper (${Date.now() - t} ms)`);
const phaseHist = {};
for (const c of sig.controllers) phaseHist[c.phases.length] = (phaseHist[c.phases.length] ?? 0) + 1;
console.log('  faser/anläggning:', Object.entries(phaseHist).sort((a,b)=>a[0]-b[0]).map(([k,v])=>`${k}:${v}`).join('  '));
const cycles = sig.controllers.map(cycleLength);
console.log(`  cykeltid: min ${Math.min(...cycles).toFixed(0)}s  median ${cycles.sort((a,b)=>a-b)[cycles.length>>1].toFixed(0)}s  max ${Math.max(...cycles).toFixed(0)}s`);
const nodesPer = sig.controllers.map(c=>c.nodes.length);
console.log(`  noder/anläggning: max ${Math.max(...nodesPer)}, snitt ${(nodesPer.reduce((a,b)=>a+b,0)/nodesPer.length).toFixed(1)}`);
console.log('  exempel:', sig.controllers.slice(0,5).map(c=>`${c.name} (${c.phases.length} faser, ${cycleLength(c).toFixed(0)}s)`).join(' | '));

// Kör 200 s signaltid och kontrollera att alla grupper hinner bli gröna.
const seenGreen = new Uint8Array(sig.groupCount);
for (let s = 0; s < 2000; s++) {
  stepSignals(sig, 0.1);
  for (let g = 0; g < sig.groupCount; g++) if (sig.groupState[g] === GroupState.Green) seenGreen[g] = 1;
}
let never = 0;
for (let g = 0; g < sig.groupCount; g++) if (!seenGreen[g]) never++;
console.log(`  grupper utan grönt på 200 s: ${never}`);
let signalledConns = 0;
for (let c = 0; c < mv.connCount; c++) if (mv.connSignalGroup[c] >= 0) signalledConns++;
console.log(`  signalreglerade rörelser: ${signalledConns}`);

// --- Efterfrågan ------------------------------------------------------------------
const { buildDemand, DEFAULT_DEMAND } = await import('../src/demand/demand.ts');
t = Date.now();
const dm = buildDemand(net, raw.land, DEFAULT_DEMAND, raw.buildings, raw.parking);
console.log(`\nefterfrågan: ${dm.zones.length} zoner (${dm.zones.filter(z=>z.external).length} yttre) på ${Date.now()-t} ms`);
console.log(`  dygnsresor: ${Math.round(dm.totalTrips).toLocaleString('sv-SE')}`);
console.log(`  maxtimme:   ${Math.round(dm.totalTrips*Math.max(...dm.profile)).toLocaleString('sv-SE')} fordon/h kl ${dm.profile.indexOf(Math.max(...dm.profile))}`);
const noAnchor = dm.zones.filter(z=>z.anchors.length===0).length;
console.log(`  zoner utan ankarlänk: ${noAnchor}`);
const top = [...dm.zones].sort((a,b)=>b.attraction-a.attraction).slice(0,5);
console.log('  starkaste målzoner:', top.map(z=>`${z.name}(${Math.round(z.attraction)})`).join(' '));
// Reslängdsfördelning ur matrisen
let tripKm = 0, tripN = 0;
const n = dm.zones.length;
for (let i=0;i<n;i++) for (let j=0;j<n;j++) { const v=dm.od[i*n+j]; if(v>0){ tripKm += v*Math.hypot(dm.zones[j].x-dm.zones[i].x, dm.zones[j].y-dm.zones[i].y)/1000; tripN += v; } }
console.log(`  medelreslängd: ${(tripKm/tripN).toFixed(2)} km  (matrisceller: ${dm.od.filter(v=>v>0.5).length})`);

// --- Ruttning ---------------------------------------------------------------------
const { RouteTrees } = await import('../src/net/routing.ts');
const rt = new RouteTrees(net, mv, sig.groupCount);
rt.setDestinations(dm.zones.map(z=>z.anchors));
t = Date.now();
const tree = rt.tree(0, 0);
console.log(`\nruttning:   första trädet på ${Date.now()-t} ms`);
let reach = 0; for (let l=0;l<net.linkCount;l++) if (tree[l] >= 0) reach++;
console.log(`  ${reach}/${net.linkCount} länkar (${(100*reach/net.linkCount).toFixed(1)} %) når zon 0`);
t = Date.now();
for (let z = 1; z < 20; z++) rt.tree(z, 0);
console.log(`  19 träd till: ${Date.now()-t} ms (${((Date.now()-t)/19).toFixed(1)} ms/träd)`);
