/**
 * Tema för hela gränssnittet.
 *
 * Kartan ritas i WebGL och överlägget i Canvas2D — ingen av dem kan läsa
 * CSS-variabler. Färgerna måste därför finnas som riktiga värden här, och det här
 * är den enda platsen där de bestäms. Panelerna får sina via CSS-variabler som
 * sätts av samma val.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** Färger som kartlagren behöver. RGB i 0–1 för WebGL, CSS-strängar för överlägget. */
export interface MapTheme {
  /** Kartans bakgrund. */
  background: [number, number, number];
  /** Mörk kantlinje runt körbanan. */
  casing: [number, number, number];
  /** Femstegsskala från stopp till fri framkomlighet. */
  ramp: [number, number, number][];
  /** Avstängd länk. */
  closed: [number, number, number];
  /** Fordonsfärger: personbil, skåpbil, lastbil, buss. */
  vehicle: [number, number, number][];
  /** Stillastående fordon. */
  vehicleStopped: [number, number, number];
  /** Fordon som körs i flödesmodellen. */
  vehicleMeso: [number, number, number];
  /** Signalpunktens ring mot bakgrunden. */
  signalRim: [number, number, number];

  /** Överlägget. */
  label: string;
  labelHalo: string;
  selection: string;
  hover: string;
  scaleBar: string;
  zoneFill: string;
  zoneEdge: string;
  zoneExternalFill: string;
  zoneExternalEdge: string;
  focusRing: string;
  measure: string;
  measureBg: string;
  pinText: string;
  /** Den valda bilens resa. */
  trip: string;
  tripHalo: string;
  tripOrigin: string;
  tripDest: string;
  /** Namngivna platser och verksamheter. */
  placeText: string;
  placeHalo: string;
  /** Symbolfärg per verksamhetstyp: handel, kontor, industri, skola, vård, övrigt. */
  placeColors: string[];
}

const DARK: MapTheme = {
  background: [0.043, 0.055, 0.075],
  casing: [0.016, 0.024, 0.038],
  // Skalan är byggd så att fri framkomlighet är dämpad och trängseln lyser.
  // Är även den fria änden mättad blir hela kartan skrikig och ögat hittar
  // inte de ställen som faktiskt är problemet.
  ramp: [
    [0.867, 0.145, 0.216],
    [0.918, 0.365, 0.086],
    [0.902, 0.671, 0.145],
    [0.478, 0.639, 0.318],
    [0.243, 0.435, 0.361],
  ],
  closed: [0.35, 0.36, 0.4],
  vehicle: [
    [0.85, 0.89, 0.94],
    [0.62, 0.8, 0.93],
    [0.95, 0.62, 0.25],
    [0.98, 0.83, 0.3],
  ],
  vehicleStopped: [0.94, 0.27, 0.27],
  vehicleMeso: [0.45, 0.52, 0.62],
  signalRim: [0.06, 0.08, 0.11],

  label: 'rgba(226,232,240,0.94)',
  labelHalo: 'rgba(8,11,15,0.9)',
  selection: '#4dd4ff',
  hover: 'rgba(255,255,255,0.35)',
  scaleBar: 'rgba(226,232,240,0.8)',
  zoneFill: 'rgba(56,189,248,0.18)',
  zoneEdge: 'rgba(56,189,248,0.6)',
  zoneExternalFill: 'rgba(168,85,247,0.22)',
  zoneExternalEdge: 'rgba(168,85,247,0.75)',
  focusRing: 'rgba(96,165,250,0.30)',
  measure: '#facc15',
  measureBg: '#0b0e12',
  pinText: '#0b0e12',
  trip: '#38bdf8',
  tripHalo: 'rgba(8,11,15,0.85)',
  tripOrigin: '#4ade80',
  tripDest: '#f472b6',
  placeText: 'rgba(233,238,246,0.95)',
  placeHalo: 'rgba(8,11,15,0.92)',
  placeColors: ['#f0883e', '#7aa2f7', '#9d8f7a', '#7fd6a8', '#f28ba8', '#a0aec0'],
};

/**
 * Ljust läge. Vägfärgerna är mörkare och mättade — en skala som är läsbar mot
 * svart blir blek och otydlig mot vitt, särskilt de gröna stegen.
 */
const LIGHT: MapTheme = {
  // Nästan vit botten med en aning värme. En kall gråblå botten gör att de
  // gröna vägarna ser smutsiga ut.
  background: [0.964, 0.969, 0.976],
  casing: [0.706, 0.737, 0.773],
  // Fri framkomlighet är avsiktligt dämpad, nästan grågrön. Kartan består till
  // nittio procent av vägar som flyter, och är de mättat gröna dränks de få
  // ställen där det faktiskt står still. Med en lugn grundton syns en orange
  // sträcka direkt.
  ramp: [
    [0.69, 0.106, 0.176],
    [0.808, 0.361, 0.125],
    [0.776, 0.569, 0.118],
    [0.478, 0.557, 0.322],
    [0.353, 0.478, 0.408],
  ],
  closed: [0.78, 0.79, 0.81],
  // Fordonen ligger på körbanan, som är dämpad och mörk även i ljust läge.
  // Vita bilar går inte att skilja från de vita körfältsmarkeringarna, så här är
  // de i stället mörka och kalla — en färgton som varken vägfärgskalan eller
  // markeringarna använder, vilket gör att en bil alltid läses som en bil.
  vehicle: [
    [0.07, 0.11, 0.22],
    [0.13, 0.3, 0.5],
    [0.36, 0.17, 0.04],
    [0.44, 0.29, 0.02],
  ],
  vehicleStopped: [0.78, 0.09, 0.12],
  vehicleMeso: [0.33, 0.38, 0.46],
  signalRim: [1, 1, 1],

  label: 'rgba(23,32,46,0.95)',
  labelHalo: 'rgba(255,255,255,0.92)',
  selection: '#0369a1',
  hover: 'rgba(15,23,42,0.28)',
  scaleBar: 'rgba(30,41,59,0.75)',
  zoneFill: 'rgba(2,132,199,0.16)',
  zoneEdge: 'rgba(2,132,199,0.65)',
  zoneExternalFill: 'rgba(126,34,206,0.16)',
  zoneExternalEdge: 'rgba(126,34,206,0.7)',
  focusRing: 'rgba(37,99,235,0.35)',
  measure: '#a16207',
  measureBg: '#ffffff',
  pinText: '#ffffff',
  trip: '#0369a1',
  tripHalo: 'rgba(255,255,255,0.9)',
  tripOrigin: '#15803d',
  tripDest: '#be185d',
  placeText: 'rgba(20,28,40,0.96)',
  placeHalo: 'rgba(255,255,255,0.95)',
  placeColors: ['#c2410c', '#1d4ed8', '#6b5844', '#047857', '#be185d', '#64748b'],
};

const STORAGE_KEY = 'trafiksimulator:tema';

export class Theme {
  private choice: ThemeChoice = 'system';
  private readonly listeners = new Set<(t: MapTheme, resolved: ResolvedTheme) => void>();
  private readonly media = window.matchMedia('(prefers-color-scheme: light)');

  constructor() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'light' || saved === 'dark' || saved === 'system') this.choice = saved;
    } catch {
      // Privat läge eller blockerad lagring — systemets inställning får gälla.
    }
    this.media.addEventListener('change', () => {
      if (this.choice === 'system') this.apply();
    });
    this.apply();
  }

  get current(): ThemeChoice {
    return this.choice;
  }

  get resolved(): ResolvedTheme {
    if (this.choice === 'system') return this.media.matches ? 'light' : 'dark';
    return this.choice;
  }

  get map(): MapTheme {
    return this.resolved === 'light' ? LIGHT : DARK;
  }

  set(choice: ThemeChoice): void {
    this.choice = choice;
    try {
      localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Valet gäller ändå för den här sessionen.
    }
    this.apply();
  }

  /** Stegar system -> ljust -> mörkt -> system. */
  cycle(): ThemeChoice {
    const order: ThemeChoice[] = ['system', 'light', 'dark'];
    this.set(order[(order.indexOf(this.choice) + 1) % order.length]);
    return this.choice;
  }

  onChange(fn: (t: MapTheme, resolved: ResolvedTheme) => void): void {
    this.listeners.add(fn);
  }

  private apply(): void {
    const resolved = this.resolved;
    if (this.choice === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', this.choice);
    document.documentElement.style.colorScheme = resolved;
    for (const fn of this.listeners) fn(this.map, resolved);
  }
}

/** Skalan som CSS-färger, för teckenförklaringen i gränssnittet. */
export function rampCss(theme: MapTheme): string[] {
  return theme.ramp.map(
    ([r, g, b]) =>
      `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`,
  );
}

export const THEME_LABEL: Record<ThemeChoice, string> = {
  system: 'Följer systemet',
  light: 'Ljust',
  dark: 'Mörkt',
};

export const THEME_ICON: Record<ThemeChoice, string> = {
  system: '◐',
  light: '☀',
  dark: '☾',
};
