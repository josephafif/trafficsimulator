/**
 * Kalibrering: jämför modellens tilldelade flöden med uppmätta trafikmängder.
 *
 *   node scripts/calibrate.mjs [simminuter] [efterfrågeskala]
 *
 * Fyll i din egen mätdata i tabellen nedan. De värden som ligger där nu är grova
 * riktvärden ur minnet och duger bara till att se storleksordningen — byt ut dem
 * mot kommunens egna mätningar innan du drar slutsatser av kvoterna.
 *
 * Körs med litet mikroområde så att siffrorna visar hur mycket trafik modellen
 * *lägger ut* på varje gata, inte hur mycket som råkar komma fram genom en kö.
 * Det är utläggningen som ska stämma innan man börjar skruva på korsningsmodellen.
 *
 * Ligger kvoten under 1 lägger modellen ut mindre trafik än gatan bär; höj
 * `totalTrips` i efterfrågepanelen eller importera en riktig OD-matris. Är
 * mönstret ojämnt — leder för lågt, smågator för högt — är det fördelningen som
 * är fel, och då hjälper bara en riktig OD-matris.
 */
import { readFileSync } from 'node:fs';
import { buildAll } from '../src/net/build.ts';
import { buildDemand, DEFAULT_DEMAND } from '../src/demand/demand.ts';
import { Simulation } from '../src/sim/engine.ts';
import { DEFAULT_CONFIG } from '../src/sim/config.ts';

/**
 * Årsdygnstrafik, båda riktningarna. ERSÄTT MED DIN EGEN MÄTDATA.
 * Nyckeln ska stavas exakt som gatunamnet i OpenStreetMap.
 */
const ADT = {
  Kungsängsleden: 25000,
  'Tycho Hedéns väg': 22000,
  Bärbyleden: 20000,
  Råbyvägen: 15000,
  Luthagsesplanaden: 13000,
  'Dag Hammarskjölds väg': 12000,
  Kungsgatan: 12000,
  Vaksalagatan: 10000,
  Vårdsätravägen: 10000,
  'Sankt Olofsgatan': 8000,
  Svartbäcksgatan: 5000,
  Väderkvarnsgatan: 7000,
  Fyrislundsgatan: 9000,
  Stationsgatan: 6000,
  'E 4': 45000,
  Bergsbrunnagatan: 4000,
};

const minutes = Number(process.argv[2] ?? 60);
const scale = Number(process.argv[3] ?? 1);
const raw = JSON.parse(readFileSync('public/data/uppsala.json', 'utf8'));
const { net, mv, signals } = buildAll(raw);
const demand = buildDemand(net, raw.land, DEFAULT_DEMAND, raw.buildings, raw.parking);
const sim = new Simulation(net, mv, signals, demand, {
  ...DEFAULT_CONFIG, startHour: 7, demandScale: scale,
});
// Litet mikroområde: utläggningen ska mätas utan att korsningsmodellen stryper.
sim.setFocus(net.proj.x(17.6389), net.proj.y(59.8586), 200);
for (let i = 0; i < minutes * 60 * 4; i++) sim.step();

console.log(`\nefterfrågan: ${Math.round(demand.totalTrips * scale).toLocaleString('sv-SE')} resor/dygn`);
console.log(`maxtimmen är ${(100 * Math.max(...demand.profile)).toFixed(1)} % av dygnet\n`);
console.log('gata                       modell f/h   ~ÅDT     modell-ÅDT   kvot');

let sumRatio = 0;
let n = 0;
for (const [namn, adt] of Object.entries(ADT)) {
  const id = net.names.indexOf(namn);
  if (id < 0) continue;
  // Mät i ett tvärsnitt: summera flödet i båda riktningar där de ligger bredvid
  // varandra. En led med skilda körbanor har `linkReverse = -1`, så det räcker
  // inte att slå ihop länkparet — då räknas bara halva leden.
  const länkar = [];
  for (let l = 0; l < net.linkCount; l++) {
    if (net.linkNameId[l] !== id) continue;
    const g = net.linkGeomStart[l], e = net.linkGeomStart[l + 1] - 1;
    länkar.push({ l, x: (net.geomX[g] + net.geomX[e]) / 2, y: (net.geomY[g] + net.geomY[e]) / 2 });
  }
  let tvåvägs = 0;
  for (const a of länkar) {
    let snitt = sim.stats.flow[a.l];
    // Närmaste motriktade körbana inom 60 m hör till samma tvärsnitt.
    let bästa = 0;
    for (const b of länkar) {
      if (b.l === a.l) continue;
      if (Math.hypot(b.x - a.x, b.y - a.y) > 60) continue;
      const motriktad = Math.abs(Math.abs(net.linkHeadIn[b.l] - net.linkHeadIn[a.l]) - Math.PI) < 0.6;
      if (motriktad && sim.stats.flow[b.l] > bästa) bästa = sim.stats.flow[b.l];
    }
    snitt += bästa;
    if (snitt > tvåvägs) tvåvägs = snitt;
  }

  const modellAdt = tvåvägs * 10;
  const kvot = modellAdt / adt;
  sumRatio += kvot;
  n++;
  console.log(
    `${namn.padEnd(26)} ${Math.round(tvåvägs).toString().padStart(6)}   ` +
    `${adt.toString().padStart(6)}   ${Math.round(modellAdt).toString().padStart(7)}   ` +
    `${kvot.toFixed(2)}${kvot > 1.5 || kvot < 0.6 ? '  <-' : ''}`,
  );
}
console.log(`\nmedelkvot modell/verklighet: ${(sumRatio / n).toFixed(2)}`);
console.log('1,0 = modellen lägger ut lika mycket trafik som gatorna faktiskt bär.');
