#!/usr/bin/env node
/**
 * Hämtar OSM-data (vägnät + markanvändning) från Overpass och cachar till public/data/.
 * Användning:
 *   node scripts/fetch-osm.mjs uppsala
 *   node scripts/fetch-osm.mjs mitt-omrade 59.78 17.53 59.93 17.78
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'data');

// bbox = [syd, väst, nord, öst]
export const CITIES = {
  uppsala: { name: 'Uppsala tätort', bbox: [59.78, 17.53, 59.93, 17.78] },
  'uppsala-centrum': { name: 'Uppsala centrum', bbox: [59.84, 17.6, 59.88, 17.68] },
  stockholm: { name: 'Stockholms innerstad', bbox: [59.29, 18.0, 59.375, 18.15] },
  goteborg: { name: 'Göteborg centrum', bbox: [57.66, 11.9, 57.74, 12.03] },
  malmo: { name: 'Malmö', bbox: [55.55, 12.94, 55.63, 13.08] },
  linkoping: { name: 'Linköping', bbox: [58.37, 15.55, 58.44, 15.68] },
  vasteras: { name: 'Västerås', bbox: [59.57, 16.48, 59.65, 16.62] },
  orebro: { name: 'Örebro', bbox: [59.23, 15.15, 59.32, 15.29] },
};

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

const DRIVABLE =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service|road|busway';

const NODE_TAGS =
  'traffic_signals|stop|give_way|mini_roundabout|turning_circle|crossing|motorway_junction';

function roadQuery(bbox) {
  const bb = bbox.join(',');
  return [
    '[out:json][timeout:600];',
    '(',
    '  way["highway"~"^(' + DRIVABLE + ')$"]["area"!~"yes"](' + bb + ');',
    '  node["highway"~"^(' + NODE_TAGS + ')$"](' + bb + ');',
    '  relation["type"="restriction"](' + bb + ');',
    ');',
    'out body;',
    '>;',
    'out skel qt;',
  ].join('\n');
}

/**
 * Markanvändningen hämtas i två lätta frågor istället för en tung.
 * `out geom` bäddar in koordinaterna direkt, så vi slipper `>;`-rekursionen
 * som annars får Overpass att timeouta på en tätort i den här storleken.
 */
function landusePolygonQuery(bbox) {
  const bb = bbox.join(',');
  return [
    '[out:json][timeout:300];',
    '(',
    '  way["landuse"~"^(residential|commercial|retail|industrial|education|institutional)$"](' + bb + ');',
    '  way["amenity"~"^(school|university|college|hospital|kindergarten)$"](' + bb + ');',
    '  way["shop"~"^(supermarket|mall|department_store)$"](' + bb + ');',
    ');',
    'out geom;',
  ].join('\n');
}

/**
 * Byggnader och parkeringsytor. Golvyta är det underlag resalstring normalt
 * bygger på — antal våningar gånger fotavtryck säger hur många som bor eller
 * arbetar där, på ett sätt som gatulängd aldrig kan göra. Utan det här kan
 * modellen inte skilja ett villaområde från ett flerbostadsområde.
 *
 * Geometrin bakas in med `out geom` och räknas om till en yta direkt vid
 * hämtningen, så det som sparas blir en rad per byggnad i stället för hundratals
 * koordinater.
 */
function buildingQuery(bbox, part) {
  const [s, w, n, e] = bbox;
  // Delas i två band; hela tätortens byggnader i en fråga får Overpass att ge upp.
  const mid = (s + n) / 2;
  const bb = part === 0 ? [s, w, mid, e].join(',') : [mid, w, n, e].join(',');
  return ['[out:json][timeout:600];', 'way["building"](' + bb + ');', 'out geom;'].join('\n');
}

function parkingQuery(bbox) {
  const bb = bbox.join(',');
  return [
    '[out:json][timeout:300];',
    '(',
    '  way["amenity"="parking"](' + bb + ');',
    '  node["amenity"="parking"](' + bb + ');',
    ');',
    'out geom;',
  ].join('\n');
}

function poiQuery(bbox) {
  const bb = bbox.join(',');
  return [
    '[out:json][timeout:300];',
    '(',
    '  node["shop"](' + bb + ');',
    '  node["office"](' + bb + ');',
    '  node["amenity"~"^(school|university|college|hospital|kindergarten|restaurant|cafe|bank|pharmacy|cinema)$"](' + bb + ');',
    '  node["public_transport"="station"](' + bb + ');',
    '  node["tourism"~"^(hotel|museum|attraction)$"](' + bb + ');',
    '  node["leisure"~"^(sports_centre|fitness_centre|stadium)$"](' + bb + ');',
    ');',
    'out body;',
  ].join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query, label, attempts = 4) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      const wait = 8000 * attempt;
      console.log('  ... väntar ' + wait / 1000 + 's (Overpass är upptagen)');
      await sleep(wait);
    }
    for (const url of MIRRORS) {
      const got = await tryMirror(url, query, label);
      if (got.ok) return got.json;
      lastErr = got.err;
    }
  }
  throw lastErr;
}

async function tryMirror(url, query, label) {
  {
    process.stdout.write('  [' + label + '] ' + new URL(url).host + ' ... ');
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass-speglarna sitter bakom mod_security som svarar 406 utan riktig UA.
          'User-Agent': 'trafiksimulator/0.1 (stadsplaneringsverktyg)',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (!text.trimStart().startsWith('{')) throw new Error('icke-JSON svar (rate limit?)');
      const json = JSON.parse(text);
      if (json.elements.length === 0) throw new Error('tomt svar');
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log('OK ' + json.elements.length + ' element på ' + dt + 's');
      return { ok: true, json };
    } catch (err) {
      console.log('MISS (' + err.message + ')');
      return { ok: false, err };
    }
  }
}

/** Polygonens yta i kvadratmeter, ur inbäddad `out geom`-geometri. */
function ringArea(geometry) {
  if (!geometry || geometry.length < 3) return 0;
  const lat0 = geometry[0].lat;
  const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  let a2 = 0;
  for (let i = 0, j = geometry.length - 1; i < geometry.length; j = i++) {
    const xi = geometry[i].lon * mPerLon;
    const yi = geometry[i].lat * 110574;
    const xj = geometry[j].lon * mPerLon;
    const yj = geometry[j].lat * 110574;
    a2 += xj * yi - xi * yj;
  }
  return Math.abs(a2 / 2);
}

function ringCentre(geometry) {
  let la = 0;
  let lo = 0;
  for (const p of geometry) {
    la += p.lat;
    lo += p.lon;
  }
  return [la / geometry.length, lo / geometry.length];
}

/**
 * En byggnad blir en rad: typ, läge, fotavtryck och våningar. Att spara
 * geometrin skulle göra filen tio gånger större utan att tillföra något —
 * modellen behöver ytan, inte formen.
 */
function slimBuildings(json) {
  const out = [];
  for (const el of json.elements) {
    if (el.type !== 'way' || !el.tags?.building || !el.geometry) continue;
    const area = ringArea(el.geometry);
    if (area < 12) continue; // skjul och uthus alstrar ingen trafik
    const [lat, lon] = ringCentre(el.geometry);
    const levels = parseFloat(el.tags['building:levels']);
    out.push({
      b: el.tags.building,
      lat: +lat.toFixed(5),
      lon: +lon.toFixed(5),
      a: Math.round(area),
      l: Number.isFinite(levels) && levels > 0 && levels < 60 ? levels : 0,
      f: el.tags.amenity || el.tags.shop || el.tags.office || undefined,
      n: el.tags.name || undefined,
    });
  }
  return out;
}

/** Parkering: kapacitet om den finns, annars ytan — bägge säger hur många bilar som ryms. */
function slimParking(json) {
  const out = [];
  for (const el of json.elements) {
    const tags = el.tags ?? {};
    if (tags.amenity !== 'parking') continue;
    if (tags.access === 'private' || tags.access === 'no') continue;
    let lat;
    let lon;
    let area = 0;
    if (el.type === 'node') {
      lat = el.lat;
      lon = el.lon;
    } else if (el.geometry && el.geometry.length >= 3) {
      area = ringArea(el.geometry);
      [lat, lon] = ringCentre(el.geometry);
    } else continue;
    const cap = parseInt(tags.capacity ?? '', 10);
    out.push({
      lat: +lat.toFixed(5),
      lon: +lon.toFixed(5),
      a: Math.round(area),
      c: Number.isFinite(cap) && cap > 0 ? cap : 0,
      t: tags.parking || undefined,
    });
  }
  return out;
}

/** Behåll bara taggar vi faktiskt använder — filstorleken sjunker kraftigt. */
const KEEP_WAY_TAGS = new Set([
  'highway', 'name', 'ref', 'oneway', 'junction', 'lanes', 'lanes:forward', 'lanes:backward',
  'lanes:both_ways', 'maxspeed', 'maxspeed:forward', 'maxspeed:backward', 'turn:lanes',
  'turn:lanes:forward', 'turn:lanes:backward', 'access', 'motor_vehicle', 'vehicle', 'service',
  'bridge', 'tunnel', 'layer', 'width', 'traffic_calming', 'priority_road', 'bus', 'psv',
  'landuse', 'building', 'amenity', 'shop', 'office', 'capacity', 'building:levels', 'area',
]);
const KEEP_NODE_TAGS = new Set([
  'highway', 'traffic_signals', 'traffic_signals:direction', 'direction', 'crossing', 'amenity',
  'shop', 'office', 'public_transport', 'name', 'railway', 'barrier',
]);

function slim(json, keepWay, keepNode) {
  const elements = [];
  for (const el of json.elements) {
    if (el.type === 'node') {
      const out = { type: 'node', id: el.id, lat: el.lat, lon: el.lon };
      if (el.tags) {
        const t = {};
        let any = false;
        for (const k in el.tags) if (keepNode.has(k)) { t[k] = el.tags[k]; any = true; }
        if (any) out.tags = t;
      }
      elements.push(out);
    } else if (el.type === 'way') {
      const out = { type: 'way', id: el.id, nodes: el.nodes };
      // `out geom` ger koordinaterna inbakade — behåll dem, då slipper vi noduppslag.
      if (el.geometry) out.geometry = el.geometry.map((p) => [p.lat, p.lon]);
      if (el.tags) {
        const t = {};
        let any = false;
        for (const k in el.tags) if (keepWay.has(k)) { t[k] = el.tags[k]; any = true; }
        if (any) out.tags = t;
      }
      elements.push(out);
    } else if (el.type === 'relation') {
      elements.push({ type: 'relation', id: el.id, members: el.members, tags: el.tags });
    }
  }
  return elements;
}

/** Noder kan komma både med taggar (out body) och utan (out skel) — behåll den taggade. */
function dedupeNodes(elements) {
  const idx = new Map();
  const out = [];
  for (const el of elements) {
    if (el.type !== 'node') { out.push(el); continue; }
    const prev = idx.get(el.id);
    if (prev === undefined) { idx.set(el.id, out.length); out.push(el); }
    else if (el.tags && !out[prev].tags) out[prev] = el;
  }
  return out;
}

const CACHE_DIR = resolve(OUT_DIR, '.cache');

/** Råsvaren cachas per delfråga så ett avbrott inte tvingar fram en helt ny nedladdning. */
async function cached(cityKey, part, query, label) {
  const file = resolve(CACHE_DIR, cityKey + '.' + part + '.json');
  if (existsSync(file)) {
    console.log('  [' + label + '] cache-träff');
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  const json = await overpass(query, label);
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(json));
  return json;
}

async function main() {
  const [key, ...rest] = process.argv.slice(2);
  if (!key) {
    console.error('Ange stad. Tillgängliga: ' + Object.keys(CITIES).join(', '));
    process.exit(1);
  }
  let city = CITIES[key];
  if (rest.length === 4) city = { name: key, bbox: rest.map(Number) };
  if (!city) {
    console.error('Okänd stad "' + key + '". Ange bbox: node scripts/fetch-osm.mjs ' + key + ' <syd> <väst> <nord> <öst>');
    process.exit(1);
  }

  console.log('Hämtar ' + city.name + '  bbox=[' + city.bbox.join(', ') + ']');
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const roads = await cached(key, 'roads', roadQuery(city.bbox), 'vägnät');
  await sleep(4000); // Overpass strypar den som skickar tunga frågor i rad.
  const poly = await cached(key, 'landuse', landusePolygonQuery(city.bbox), 'markanv');
  await sleep(4000);
  const poi = await cached(key, 'poi', poiQuery(city.bbox), 'poi');
  await sleep(4000);
  const husSyd = await cached(key, 'buildings-s', buildingQuery(city.bbox, 0), 'byggnader syd');
  await sleep(4000);
  const husNorr = await cached(key, 'buildings-n', buildingQuery(city.bbox, 1), 'byggnader norr');
  await sleep(4000);
  const parkering = await cached(key, 'parking', parkingQuery(city.bbox), 'parkering');

  const payload = {
    version: 1,
    key,
    name: city.name,
    bbox: city.bbox,
    fetchedAt: new Date().toISOString(),
    roads: dedupeNodes(slim(roads, KEEP_WAY_TAGS, KEEP_NODE_TAGS)),
    land: dedupeNodes([
      ...slim(poly, KEEP_WAY_TAGS, KEEP_NODE_TAGS),
      ...slim(poi, KEEP_WAY_TAGS, KEEP_NODE_TAGS),
    ]),
    buildings: [...slimBuildings(husSyd), ...slimBuildings(husNorr)],
    parking: slimParking(parkering),
  };

  const file = resolve(OUT_DIR, key + '.json');
  const text = JSON.stringify(payload);
  writeFileSync(file, text);
  const mb = (Buffer.byteLength(text) / 1048576).toFixed(1);
  const ways = payload.roads.filter((e) => e.type === 'way').length;
  console.log(
    '\nSparat ' + file + '  (' + mb + ' MB, ' + ways + ' vägsegment, ' +
    payload.land.length + ' markanv-element, ' + payload.buildings.length + ' byggnader, ' +
    payload.parking.length + ' parkeringar)',
  );
}

main().catch((e) => { console.error('\nFEL: ' + e.message); process.exit(1); });
