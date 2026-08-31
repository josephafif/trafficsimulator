/**
 * Kör simuleringen huvudlöst och rapporterar prestanda och trafikala nyckeltal.
 * Snabbaste sättet att se om modellen beter sig rimligt utan att starta webbläsaren.
 *
 *   node scripts/simtest.mjs [stad] [simminuter] [fokusradie_m|full]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll } from '../src/net/build.ts';
import { buildDemand, DEFAULT_DEMAND } from '../src/demand/demand.ts';
import { Simulation } from '../src/sim/engine.ts';
import { DEFAULT_CONFIG } from '../src/sim/config.ts';
import { VState } from '../src/sim/state.ts';
import { CLASS_DEFAULTS } from '../src/osm/tags.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const key = process.argv[2] ?? 'uppsala';
const minutes = Number(process.argv[3] ?? 30);
const focusArg = process.argv[4] ?? '1600';
const demandScale = Number(process.argv[5] ?? 1);

const raw = JSON.parse(readFileSync(resolve(__dirname, '..', 'public', 'data', key + '.json'), 'utf8'));
const { net, mv, signals } = buildAll(raw);
const demand = buildDemand(net, raw.land, DEFAULT_DEMAND, raw.buildings, raw.parking);

const config = { ...DEFAULT_CONFIG, startHour: 7, maxVehicles: 60000, demandScale };
const sim = new Simulation(net, mv, signals, demand, config);

// Fokusera mikroområdet på Uppsala centrum (Stora torget).
const cx = net.proj.x(17.6389);
const cy = net.proj.y(59.8586);
if (focusArg === 'full') sim.setFullMicro();
else sim.setFocus(cx, cy, Number(focusArg));

const steps = Math.round((minutes * 60) / config.dt);
console.log(`\n=== ${net.name} ===`);
console.log(`fokus: ${focusArg === 'full' ? 'hela nätet mikroskopiskt' : focusArg + ' m radie'}`);
console.log(`efterfrågan: ${(demandScale * 100).toFixed(0)} % av basåret`);
console.log(`kör ${minutes} simminuter (${steps} steg à ${config.dt}s) från kl ${config.startHour}:00\n`);

const t0 = performance.now();
let worst = 0;
const samples = [];
for (let i = 0; i < steps; i++) {
  const a = performance.now();
  sim.step();
  const dt = performance.now() - a;
  if (dt > worst) worst = dt;
  samples.push(dt);
  if ((i + 1) % Math.round(steps / 6) === 0) {
    const st = sim.networkStats();
    const hh = String(Math.floor(st.hour)).padStart(2, '0');
    const mm = String(Math.floor((st.hour % 1) * 60)).padStart(2, '0');
    console.log(
      `  ${hh}:${mm}  ${String(st.active).padStart(6)} fordon  ` +
      `${String(st.completed).padStart(6)} resor klara  ` +
      `medelfart ${(st.meanSpeed * 3.6).toFixed(1).padStart(5)} km/h  ` +
      `blockerade ${st.blockedSpawns}`,
    );
  }
}
const elapsed = (performance.now() - t0) / 1000;

samples.sort((a, b) => a - b);
const st = sim.networkStats();
console.log(`\nprestanda:`);
console.log(`  realtidsfaktor: ${(minutes * 60 / elapsed).toFixed(1)}x  (${elapsed.toFixed(1)} s för ${minutes} simminuter)`);
console.log(`  per steg: median ${samples[steps >> 1].toFixed(2)} ms, p95 ${samples[Math.floor(steps * 0.95)].toFixed(2)} ms, värsta ${worst.toFixed(1)} ms`);
console.log(`  mikrolänkar: ${st.microLinks} av ${net.linkCount}`);

console.log(`\ntrafik:`);
console.log(`  fordon i nätet:      ${st.active}`);
console.log(`  avslutade resor:     ${st.completed}`);
console.log(`  medelrestid:         ${(st.meanTripTime / 60).toFixed(1)} min`);
console.log(`  varav fördröjning:   ${(st.meanTripDelay / 60).toFixed(1)} min  (${(100 * st.meanTripDelay / Math.max(st.meanTripTime, 1)).toFixed(0)} %)`);
console.log(`  medelhastighet:      ${(st.meanSpeed * 3.6).toFixed(1)} km/h`);
console.log(`  fordonskilometer:    ${Math.round(st.vehKm).toLocaleString('sv-SE')}`);
console.log(`  CO2:                 ${(st.co2Tonnes * 1000).toFixed(0)} kg`);
console.log(`  ej insläppta fordon: ${st.blockedSpawns}`);
console.log(`  borttagna (ingen väg): ${st.lost}`);

// Fördelning mikro/meso/korsning
const counts = [0, 0, 0, 0];
for (let v = 0; v < sim.s.capacity; v++) counts[sim.s.state[v]]++;
console.log(`  varav mikro ${counts[VState.Micro]}, meso ${counts[VState.Meso]}, i korsning ${counts[VState.OnConn]}`);

// Stillastående fordon som aldrig kommer loss är det tydligaste tecknet på dödläge.
let stuck = 0;
let maxWait = 0;
for (let v = 0; v < sim.s.capacity; v++) {
  if (sim.s.state[v] === VState.Pending) continue;
  if (sim.s.waited[v] > 120) stuck++;
  if (sim.s.waited[v] > maxWait) maxWait = sim.s.waited[v];
}
console.log(`  fast >2 min:         ${stuck}  (längsta väntan ${maxWait.toFixed(0)} s)`);

console.log(`\nvärsta flaskhalsar (fördröjning i fordonstimmar):`);
for (const b of sim.bottlenecks(12)) {
  const name = net.names[net.linkNameId[b.link]] || '(namnlös)';
  const cls = CLASS_DEFAULTS[net.linkClass[b.link]].label;
  const kmh = (sim.stats.speed[b.link] * 3.6).toFixed(0);
  const free = (sim.linkSpeed(b.link) * 3.6).toFixed(0);
  console.log(
    `  ${b.delayHours.toFixed(1).padStart(6)} h  ${name.padEnd(26)} ${cls.padEnd(16)} ` +
    `V/C ${b.saturation.toFixed(2)}  ${kmh}/${free} km/h  kö ${b.queue.toFixed(0)}`,
  );
}

// Flödeskontroll: de mest trafikerade länkarna ska vara stadens huvudstråk.
const busiest = [...Array(net.linkCount).keys()]
  .filter((l) => sim.stats.flow[l] > 0)
  .sort((a, b) => sim.stats.flow[b] - sim.stats.flow[a])
  .slice(0, 10);
console.log(`\nhögst flöde (fordon/h, båda riktningar räknas var för sig):`);
for (const l of busiest) {
  const name = net.names[net.linkNameId[l]] || '(namnlös)';
  console.log(`  ${sim.stats.flow[l].toFixed(0).padStart(5)}  ${name.padEnd(26)} ${CLASS_DEFAULTS[net.linkClass[l]].label}`);
}

// --- Diagnos av fastlåsta fordon --------------------------------------------------
const reasons = new Map();
const bump = (k) => reasons.set(k, (reasons.get(k) ?? 0) + 1);
for (let v = 0; v < sim.s.capacity; v++) {
  if (sim.s.state[v] === VState.Pending || sim.s.waited[v] < 120) continue;
  const stt = sim.s.state[v];
  if (stt === VState.OnConn) { bump('står i korsningen'); continue; }
  if (stt === VState.Meso) { bump('meso'); continue; }
  const link = sim.s.link[v], lane = sim.s.lane[v];
  const b = mv.laneBase[link] + lane;
  const nConn = mv.laneConnStart[b + 1] - mv.laneConnStart[b];
  const atEnd = sim.s.pos[v] > mv.linkDriveLen[link] - 6;
  if (nConn === 0) bump('körfältet har inga svängrörelser');
  else if (!atEnd) bump('står i kö mitt på länken');
  else if (sim.s.nextConn[v] < 0) bump('hittar ingen rörelse mot målet');
  else {
    const c = sim.s.nextConn[v];
    const g = mv.connSignalGroup[c];
    if (g >= 0) bump('väntar vid signal');
    else if (mv.connYield[c] !== 0) bump('väjningsplikt: får ingen lucka');
    else bump('nedströms fullt / annat');
  }
}
console.log('\norsak till att fordon står >2 min:');
for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
