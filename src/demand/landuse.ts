/**
 * Resalstring ur bebyggelsen.
 *
 * Trafikplanering räknar resor ur *golvyta och parkeringsplatser*, inte ur
 * gatulängd. Skillnaden är avgörande: ett villaområde har mycket gata per boende
 * och ett flerbostadsområde nästan ingen, så gatulängd lägger trafiken i precis
 * fel ände av staden. Byggnadernas fotavtryck gånger antal våningar säger i
 * stället hur många som bor eller arbetar där.
 *
 * För målpunkter är parkeringskapaciteten det mest tillförlitliga måttet som
 * finns: en handelsplats kan omöjligt ta emot fler bilar per dag än platserna
 * gånger omsättningen, och omvänt fylls platserna om verksamheten drar folk.
 * Golvytan och parkeringen mäter samma sak från två håll, så det högre av dem
 * används — att lägga ihop dem vore att räkna samma resa två gånger.
 */

export interface Building {
  /** `building`-taggens värde. */
  b: string;
  lat: number;
  lon: number;
  /** Fotavtryck i kvadratmeter. */
  a: number;
  /** Våningar, 0 = otaggat. */
  l: number;
  /** Verksamhet i huset (amenity/shop/office), om taggad. */
  f?: string;
  n?: string;
}

export interface Parking {
  lat: number;
  lon: number;
  /** Ytan i kvadratmeter, 0 för punktmarkerade parkeringar. */
  a: number;
  /** Antal platser, 0 = otaggat. */
  c: number;
  t?: string;
}

/** Vad en byggnad används till, ur trafikalstringens synvinkel. */
export const Use = {
  Detached: 0,
  Terraced: 1,
  Apartments: 2,
  Retail: 3,
  Office: 4,
  Industrial: 5,
  School: 6,
  University: 7,
  Hospital: 8,
  Hotel: 9,
  Leisure: 10,
  /**
   * Innerstadskvarter: butik eller kontor i gatuplan, bostäder ovanpå. Räknas
   * huset som ren handel blir centrum stadens största trafikmagnet, och räknas
   * det som ren bostad försvinner butikerna — verkligheten är båda delarna.
   */
  Mixed: 11,
  Other: 12,
} as const;
export type Use = (typeof Use)[keyof typeof Use];

/** Byggnader som aldrig alstrar trafik: garage, förråd, skärmtak och liknande. */
const NON_HABITABLE = new Set([
  'garage', 'garages', 'carport', 'shed', 'roof', 'hut', 'cabin', 'greenhouse',
  'barn', 'stable', 'container', 'bunker', 'ruins', 'construction', 'silo',
  'storage_tank', 'transformer_tower', 'service', 'toilets', 'shelter',
]);

const BUILDING_USE: Record<string, Use> = {
  house: Use.Detached,
  detached: Use.Detached,
  bungalow: Use.Detached,
  static_caravan: Use.Detached,
  terrace: Use.Terraced,
  terraced_house: Use.Terraced,
  semidetached_house: Use.Terraced,
  apartments: Use.Apartments,
  dormitory: Use.Apartments,
  retail: Use.Retail,
  supermarket: Use.Retail,
  shop: Use.Retail,
  kiosk: Use.Retail,
  commercial: Use.Office,
  office: Use.Office,
  industrial: Use.Industrial,
  warehouse: Use.Industrial,
  manufacture: Use.Industrial,
  school: Use.School,
  kindergarten: Use.School,
  college: Use.University,
  university: Use.University,
  hospital: Use.Hospital,
  hotel: Use.Hotel,
  sports_hall: Use.Leisure,
  stadium: Use.Leisure,
  sports_centre: Use.Leisure,
};

/** Verksamhetstaggen i huset går före den generiska `building`-taggen. */
const FUNCTION_USE: Record<string, Use> = {
  supermarket: Use.Retail,
  mall: Use.Retail,
  department_store: Use.Retail,
  convenience: Use.Retail,
  clothes: Use.Retail,
  furniture: Use.Retail,
  doityourself: Use.Retail,
  hardware: Use.Retail,
  car: Use.Retail,
  electronics: Use.Retail,
  restaurant: Use.Leisure,
  cafe: Use.Leisure,
  cinema: Use.Leisure,
  school: Use.School,
  kindergarten: Use.School,
  college: Use.University,
  university: Use.University,
  hospital: Use.Hospital,
  clinic: Use.Hospital,
  doctors: Use.Hospital,
  hotel: Use.Hotel,
};

/**
 * Bilresor som *anländer* per 100 m² våningsyta och vardagsdygn.
 *
 * Handel ligger högst med bred marginal, industri och lager lägst. Nivåerna är
 * planeringsschabloner av samma slag som används i trafikutredningar — de ska
 * bytas mot uppmätta värden när sådana finns, men storleksordningen stämmer:
 * en galleria på 60 000 m² hamnar kring 8 000 bilbesök per dygn, vilket är vad
 * en handelsplats av den storleken faktiskt tar emot.
 */
const ATTRACTION_PER_100M2: Record<Use, number> = {
  [Use.Detached]: 0.8,
  [Use.Terraced]: 0.8,
  [Use.Apartments]: 0.6,
  [Use.Retail]: 14,
  [Use.Office]: 3.5,
  [Use.Industrial]: 1.5,
  [Use.School]: 4,
  // Universitet och sjukhus har stor golvyta men låg bilandel: många anställda,
  // god kollektivtrafik och studenter som sällan kör bil.
  [Use.University]: 1.8,
  [Use.Hospital]: 2.5,
  [Use.Hotel]: 4,
  [Use.Leisure]: 8,
  // Bara gatuplanet drar besökare; se buildingAttraction som räknar på det.
  [Use.Mixed]: 14,
  [Use.Other]: 1.2,
};

/** Genomsnittlig våningsyta per bostad, kvadratmeter. */
const AREA_PER_DWELLING: Record<number, number> = {
  [Use.Detached]: 150,
  [Use.Terraced]: 110,
  [Use.Apartments]: 88,
};

/** Boende per bostad. Villor rymmer fler än lägenheter. */
const PERSONS_PER_DWELLING: Record<number, number> = {
  [Use.Detached]: 2.6,
  [Use.Terraced]: 2.3,
  [Use.Apartments]: 1.75,
};

/** Antaget våningsantal när `building:levels` saknas. */
const DEFAULT_LEVELS: Record<Use, number> = {
  [Use.Detached]: 1.4,
  [Use.Terraced]: 1.8,
  [Use.Apartments]: 3.5,
  [Use.Retail]: 1,
  [Use.Office]: 3,
  [Use.Industrial]: 1,
  [Use.School]: 2,
  [Use.University]: 3,
  [Use.Hospital]: 4,
  [Use.Hotel]: 4,
  [Use.Leisure]: 1,
  [Use.Mixed]: 4,
  [Use.Other]: 1.5,
};

export function useOf(b: Building): Use {
  if (NON_HABITABLE.has(b.b)) return Use.Other;
  if (b.f && FUNCTION_USE[b.f] !== undefined) return FUNCTION_USE[b.f];
  // `building=residential` används i svensk kartläggning för allt från villa till
  // hyreshus; storleken får avgöra vilket.
  if (b.b === 'residential') return residentialBySize(b.a, b.l);
  const u = BUILDING_USE[b.b];
  return u === undefined ? Use.Other : u;
}

/** Omgivningen kring ett hus, som underlag för att gissa vad det används till. */
export interface Context {
  /** Markanvändningen på platsen, om någon polygon täcker den. */
  landuse?: string;
  /** Parkeringsplatser inom några hundra meter. */
  parkingSpaces: number;
  /** Vad de hus i närheten som *är* taggade används till. */
  neighbour?: Use;
}

/**
 * Gissar vad ett otaggat hus används till.
 *
 * Merparten av byggnaderna i OSM bär bara `building=yes`. Att kasta dem vore att
 * kasta bort större delen av staden: villaområdena skulle sakna boende och
 * handelsområdena sakna målpunkter, vilket är precis det fel som gör att trafiken
 * hamnar på fel gator. Gissningen bygger på det en planerare skulle titta på —
 * husets storlek, vad marken används till, hur mycket parkering som ligger
 * bredvid, och vad grannhusen är.
 */
export function classifyUntagged(b: Building, ctx: Context): Use {
  const area = b.a;
  const homes = ctx.neighbour !== undefined && isResidential(ctx.neighbour);

  // Garage, förråd och uthus är otaggade precis som bostadshusen, och på en
  // villatomt finns det fler uthus än hus. Räknas de som bostäder fördubblas
  // folkmängden i villaområdena — och därmed trafiken därifrån.
  if (area < 60) return Use.Other;

  switch (ctx.landuse) {
    case 'retail':
      return area > 400 ? Use.Retail : Use.Office;
    case 'commercial':
      return area > 1500 && ctx.parkingSpaces > 200 ? Use.Retail : Use.Office;
    case 'industrial':
      return Use.Industrial;
    case 'education':
      return Use.School;
    case 'residential':
      // Ett stort hus mitt i ett bostadsområde med mycket parkering är
      // stadsdelens centrum — butik i gatuplan, bostäder ovanpå.
      if (area > 900 && ctx.parkingSpaces > 200) return Use.Mixed;
      return residentialBySize(area, b.l);
    default:
      break;
  }

  // Extern handel: stort hus, mycket parkering och inga bostäder runt omkring.
  // Utan det sista villkoret blir sjukhus och innerstadskvarter till köpcentrum,
  // eftersom de också har parkering intill.
  if (area > 900 && ctx.parkingSpaces > 250 && !homes) return Use.Retail;

  if (ctx.neighbour !== undefined && ctx.neighbour !== Use.Other) {
    if (homes) return residentialBySize(area, b.l);
    return ctx.neighbour;
  }

  // Utan ledtrådar får storleken avgöra, men bara för de småhus som dominerar i
  // antal. Ett stort hus utan vare sig markanvändning, grannar eller parkering
  // går inte att placera — då är det ärligare att låta det stå utan alstring än
  // att gissa fram en folkmängd eller en handelsplats som inte finns.
  if (area <= 320) return residentialBySize(area, b.l);
  return Use.Other;
}

/**
 * Ett hus med butiks- eller kontorsfunktion i flera våningar mitt i staden är
 * ett blandat kvarter, inte en ren handelsplats.
 */
export function refineTagged(b: Building, u: Use, ctx: Context): Use {
  if (u !== Use.Retail && u !== Use.Office) return u;
  const levels = b.l > 0 ? b.l : 0;
  const central = ctx.neighbour !== undefined && isResidential(ctx.neighbour);
  if (central && levels >= 3) return Use.Mixed;
  if (central && levels === 0 && b.a < 900) return Use.Mixed;
  return u;
}

function residentialBySize(area: number, levels: number): Use {
  if (levels >= 3) return Use.Apartments;
  // Radhus kartläggs oftast som en polygon per lägenhet och har litet
  // fotavtryck; en villa ligger däremellan.
  if (area <= 110) return Use.Terraced;
  if (area <= 320) return Use.Detached;
  // Större än så utan våningstagg går inte att avgöra. Verkliga flerbostadshus
  // är nästan alltid taggade som sådana, medan skolor, kyrkor, garagelängor och
  // verksamhetslokaler ofta bara bär `building=yes`. Att gissa på flerbostadshus
  // här mer än fördubblar stadens folkmängd.
  return levels >= 2 && area <= 700 ? Use.Apartments : Use.Other;
}

export function isResidential(u: Use): boolean {
  return u === Use.Detached || u === Use.Terraced || u === Use.Apartments || u === Use.Mixed;
}

/** Våningsyta i kvadratmeter. */
export function floorArea(b: Building, u: Use): number {
  const levels = b.l > 0 ? b.l : DEFAULT_LEVELS[u];
  return b.a * levels;
}

/**
 * Boende i huset.
 *
 * Ett friliggande hus eller ett radhus är *en* bostad, hur stort det än är —
 * en stor villa rymmer en familj, inte tre. Bara flerbostadshus skalar med
 * våningsytan. Räknas småhusen efter yta blir folkmängden i villaområdena
 * flerdubbel, och trafiken därifrån med den.
 */
export function residents(b: Building, u: Use): number {
  if (!isResidential(u)) return 0;
  if (u === Use.Detached || u === Use.Terraced) return PERSONS_PER_DWELLING[u];
  // Blandat kvarter: gatuplanet är verksamhet, resten bostäder.
  const area = u === Use.Mixed ? Math.max(0, floorArea(b, u) - b.a) : floorArea(b, u);
  const dwellings = Math.max(u === Use.Mixed ? 0 : 1, Math.round(area / AREA_PER_DWELLING[Use.Apartments]));
  return dwellings * PERSONS_PER_DWELLING[Use.Apartments];
}

/** Anländande bilresor per vardagsdygn som verksamheten i huset drar till sig. */
export function buildingAttraction(b: Building, u: Use): number {
  if (u === Use.Mixed) {
    // Bara gatuplanet är butik; våningarna ovanpå bidrar som bostäder.
    return (b.a / 100) * ATTRACTION_PER_100M2[Use.Mixed] +
      ((floorArea(b, u) - b.a) / 100) * ATTRACTION_PER_100M2[Use.Apartments];
  }
  return (floorArea(b, u) / 100) * ATTRACTION_PER_100M2[u];
}

/**
 * Bilar som en parkering tar emot per vardagsdygn.
 *
 * Omsättningen skiljer sig kraftigt: en handelsparkering byter besökare fyra
 * gånger om dagen medan en arbetsplatsparkering står upptagen av samma bil hela
 * dagen. Saknas kapacitetstagg räknas den ur ytan — ungefär 26 m² per plats
 * inklusive körytor.
 */
export function parkingArrivals(p: Parking): number {
  const spaces = p.c > 0 ? p.c : Math.round(p.a / 26);
  if (spaces <= 0) return 0;
  const turnover =
    p.t === 'multi-storey' || p.t === 'underground' ? 3.2
    : p.t === 'surface' ? 3.0
    : 2.8;
  return spaces * turnover;
}

/** Platser parkeringen rymmer — används för att se hur väl den är utnyttjad. */
export function parkingSpaces(p: Parking): number {
  return p.c > 0 ? p.c : Math.round(p.a / 26);
}
