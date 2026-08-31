/**
 * Tolkning av OSM-taggar till trafiktekniska storheter.
 *
 * Där OSM saknar taggar används svensk praxis som fallback (VGU/Trafikverkets
 * schablonvärden), eftersom ca 60 % av gatorna i ett svenskt tätortsnät saknar
 * explicit `maxspeed` och `lanes`.
 */

export type Tags = Record<string, string>;

export const RoadClass = {
  Motorway: 0,
  Trunk: 1,
  Primary: 2,
  Secondary: 3,
  Tertiary: 4,
  Unclassified: 5,
  Residential: 6,
  LivingStreet: 7,
  Service: 8,
} as const;
export type RoadClass = (typeof RoadClass)[keyof typeof RoadClass];

export const ROAD_CLASS_COUNT = 9;

export interface ClassDefaults {
  /** Skyltad hastighet i km/h när `maxspeed` saknas. */
  speed: number;
  /** Körfält per riktning när `lanes` saknas. */
  lanesPerDir: number;
  /** Mättnadsflöde, fordon/timme/körfält — används av mesomodellen och V/C-kvoten. */
  capacity: number;
  /** Företrädesrang i korsning utan skyltning; högre vinner. */
  priority: number;
  /** Bredd i meter per körfält (renderingen och konfliktzonerna använder den). */
  laneWidth: number;
  label: string;
}

export const CLASS_DEFAULTS: readonly ClassDefaults[] = [
  { speed: 110, lanesPerDir: 2, capacity: 2100, priority: 9, laneWidth: 3.75, label: 'Motorväg' },
  { speed: 90, lanesPerDir: 1, capacity: 1900, priority: 8, laneWidth: 3.5, label: 'Motortrafikled' },
  { speed: 70, lanesPerDir: 1, capacity: 1700, priority: 7, laneWidth: 3.5, label: 'Huvudled' },
  { speed: 60, lanesPerDir: 1, capacity: 1500, priority: 6, laneWidth: 3.25, label: 'Genomfartsgata' },
  { speed: 50, lanesPerDir: 1, capacity: 1300, priority: 5, laneWidth: 3.25, label: 'Uppsamlingsgata' },
  { speed: 50, lanesPerDir: 1, capacity: 1100, priority: 4, laneWidth: 3.0, label: 'Övrig gata' },
  { speed: 40, lanesPerDir: 1, capacity: 900, priority: 3, laneWidth: 3.0, label: 'Lokalgata' },
  { speed: 7, lanesPerDir: 1, capacity: 300, priority: 1, laneWidth: 3.0, label: 'Gångfartsområde' },
  { speed: 30, lanesPerDir: 1, capacity: 600, priority: 2, laneWidth: 2.75, label: 'Angöringsväg' },
];

const HIGHWAY_TO_CLASS: Record<string, RoadClass> = {
  motorway: RoadClass.Motorway,
  motorway_link: RoadClass.Motorway,
  trunk: RoadClass.Trunk,
  trunk_link: RoadClass.Trunk,
  primary: RoadClass.Primary,
  primary_link: RoadClass.Primary,
  secondary: RoadClass.Secondary,
  secondary_link: RoadClass.Secondary,
  tertiary: RoadClass.Tertiary,
  tertiary_link: RoadClass.Tertiary,
  unclassified: RoadClass.Unclassified,
  road: RoadClass.Unclassified,
  residential: RoadClass.Residential,
  living_street: RoadClass.LivingStreet,
  service: RoadClass.Service,
  busway: RoadClass.Service,
};

export function roadClassOf(tags: Tags): RoadClass | -1 {
  const hw = tags.highway;
  if (hw === undefined) return -1;
  const c = HIGHWAY_TO_CLASS[hw];
  return c === undefined ? -1 : c;
}

export function isLink(tags: Tags): boolean {
  return typeof tags.highway === 'string' && tags.highway.endsWith('_link');
}

/** Kan en personbil lagligt köra här? */
export function isDrivable(tags: Tags): boolean {
  if (roadClassOf(tags) === -1) return false;
  const blocked = new Set(['no', 'private', 'customers', 'delivery', 'agricultural', 'forestry']);
  for (const key of ['motor_vehicle', 'vehicle', 'access'] as const) {
    const v = tags[key];
    if (v !== undefined) {
      if (blocked.has(v)) return false;
      break; // mer specifik tagg vinner
    }
  }
  // Rena parkerings- och uppfarts-service-vägar ger enorma mängder brus i nätet.
  if (tags.highway === 'service') {
    const s = tags.service;
    if (s === 'parking_aisle' || s === 'driveway' || s === 'drive-through') return false;
  }
  return true;
}

const IMPLICIT_SPEEDS: Record<string, number> = {
  'se:urban': 50,
  'se:rural': 70,
  'se:motorway': 110,
  'se:trunk': 90,
  'se:living_street': 7,
  walk: 5,
  none: 130,
  signals: 70,
  variable: 70,
};

/** Returnerar skyltad hastighet i km/h, eller NaN om taggen saknas/är otolkbar. */
export function parseMaxspeed(raw: string | undefined): number {
  if (!raw) return NaN;
  const s = raw.trim().toLowerCase();
  const implicit = IMPLICIT_SPEEDS[s];
  if (implicit !== undefined) return implicit;
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|knots)?$/.exec(s);
  if (!m) return NaN;
  const value = parseFloat(m[1]);
  if (m[2] === 'mph') return value * 1.609344;
  if (m[2] === 'knots') return value * 1.852;
  return value;
}

/** 1 = enkelriktad i way-riktningen, -1 = enkelriktad mot, 0 = dubbelriktad. */
export function onewayOf(tags: Tags): 1 | -1 | 0 {
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 1;
  if (isLink(tags) && tags.oneway === undefined) {
    // Av- och påfartsramper är i praktiken alltid enkelriktade även när taggen saknas.
    const c = roadClassOf(tags);
    if (c === RoadClass.Motorway || c === RoadClass.Trunk) return 1;
  }
  switch (tags.oneway) {
    case 'yes':
    case 'true':
    case '1':
      return 1;
    case '-1':
    case 'reverse':
      return -1;
    default:
      return 0;
  }
}

export interface LaneCounts {
  forward: number;
  backward: number;
}

/**
 * Körfält per riktning. `lanes` i OSM räknar båda riktningarna tillsammans,
 * så en dubbelriktad gata med `lanes=2` har ett fält åt vardera hållet.
 */
export function laneCountsOf(tags: Tags, cls: RoadClass, oneway: 1 | -1 | 0): LaneCounts {
  const def = CLASS_DEFAULTS[cls];
  const perDirDefault = isLink(tags) ? 1 : def.lanesPerDir;

  const fwdTag = parseIntTag(tags['lanes:forward']);
  const bwdTag = parseIntTag(tags['lanes:backward']);
  const totalTag = parseIntTag(tags.lanes);
  const bothWays = parseIntTag(tags['lanes:both_ways']) || 0;

  if (oneway !== 0) {
    const n = fwdTag || bwdTag || totalTag || perDirDefault;
    return oneway === 1 ? { forward: n, backward: 0 } : { forward: 0, backward: n };
  }

  if (fwdTag && bwdTag) return { forward: fwdTag, backward: bwdTag };
  if (totalTag) {
    const usable = Math.max(2, totalTag - bothWays);
    if (fwdTag) return { forward: fwdTag, backward: Math.max(1, usable - fwdTag) };
    if (bwdTag) return { forward: Math.max(1, usable - bwdTag), backward: bwdTag };
    const half = Math.floor(usable / 2);
    // Udda totalantal på dubbelriktad gata = extra fält (t.ex. vänstersvängfält); ge det åt båda.
    return { forward: Math.max(1, half), backward: Math.max(1, usable - half - (usable % 2)) || 1 };
  }
  return { forward: fwdTag || perDirDefault, backward: bwdTag || perDirDefault };
}

function parseIntTag(v: string | undefined): number {
  if (!v) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 12 ? n : 0;
}

/** Svängbitmask per körfält, från `turn:lanes`. */
export const Turn = {
  Left: 1,
  SlightLeft: 2,
  Through: 4,
  SlightRight: 8,
  Right: 16,
  Reverse: 32,
  MergeLeft: 64,
  MergeRight: 128,
  None: 256,
} as const;
export type Turn = (typeof Turn)[keyof typeof Turn];

export const TURN_ANY = Turn.Left | Turn.SlightLeft | Turn.Through | Turn.SlightRight | Turn.Right;

const TURN_WORDS: Record<string, number> = {
  left: Turn.Left,
  sharp_left: Turn.Left,
  slight_left: Turn.SlightLeft,
  through: Turn.Through,
  slight_right: Turn.SlightRight,
  right: Turn.Right,
  sharp_right: Turn.Right,
  reverse: Turn.Reverse,
  merge_to_left: Turn.MergeLeft,
  merge_to_right: Turn.MergeRight,
  none: Turn.None,
  '': Turn.None,
};

/**
 * `turn:lanes` listas i OSM från vänster till höger sett i körriktningen.
 * Vi indexerar körfält 0 = längst till höger (högertrafik), så listan vänds.
 */
export function parseTurnLanes(raw: string | undefined, laneCount: number): Uint16Array | null {
  if (!raw) return null;
  const parts = raw.split('|');
  if (parts.length !== laneCount) return null;
  const out = new Uint16Array(laneCount);
  for (let i = 0; i < parts.length; i++) {
    let mask = 0;
    for (const w of parts[i].split(';')) {
      const bit = TURN_WORDS[w.trim()];
      if (bit !== undefined) mask |= bit;
    }
    if (mask === 0 || mask === Turn.None) mask = Turn.Through;
    out[laneCount - 1 - i] = mask;
  }
  return out;
}

/** Klassificerar en sväng utifrån vinkeländringen i radianer. */
export function turnFromAngle(delta: number): Turn {
  const d = (delta * 180) / Math.PI;
  if (d > 150 || d < -150) return Turn.Reverse;
  if (d > 45) return Turn.Left;
  if (d > 15) return Turn.SlightLeft;
  if (d < -45) return Turn.Right;
  if (d < -15) return Turn.SlightRight;
  return Turn.Through;
}

export const NodeControl = {
  None: 0,
  /** Väjningsplikt/högerregel — modelleras med gap-acceptance. */
  Priority: 1,
  Signal: 2,
  Roundabout: 3,
  Stop: 4,
  GiveWay: 5,
} as const;
export type NodeControl = (typeof NodeControl)[keyof typeof NodeControl];

export function nodeControlOf(tags: Tags | undefined): NodeControl {
  if (!tags) return NodeControl.None;
  switch (tags.highway) {
    case 'traffic_signals':
      return NodeControl.Signal;
    case 'stop':
      return NodeControl.Stop;
    case 'give_way':
      return NodeControl.GiveWay;
    case 'mini_roundabout':
      return NodeControl.Roundabout;
    default:
      return NodeControl.None;
  }
}
