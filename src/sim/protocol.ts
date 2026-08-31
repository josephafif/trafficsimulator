/**
 * Meddelanden mellan gränssnittet och simuleringstråden.
 *
 * Simuleringen äger all tillstånd och kör i en Web Worker; huvudtråden får en kopia
 * av det som behövs för att rita, och därefter en fordonsbuffert per bildruta.
 * Bufferten skickas fram och tillbaka (transferable) istället för att kopieras, så
 * 60 000 fordon kostar ingenting att flytta över.
 */

import type { NetworkStats } from './engine.ts';
import type { SimConfig } from './config.ts';
import type { Phase, SignalMode } from '../net/signals.ts';

/**
 * Fält per fordon i renderingsbufferten: x, y, riktning, packad typ/tillstånd,
 * fordonets index och farten i m/s.
 *
 * Indexet följer med för att ett klick i kartan ska kunna fråga simuleringen om
 * just den bilens resa. Farten följer med för att renderingen ska kunna räkna
 * fram var bilen är *mellan* två simuleringssteg: steget är en kvarts sekund
 * medan skärmen ritar sextio bilder i sekunden, så utan det rycker bilarna fram
 * i stället för att rulla.
 */
export const VEHICLE_STRIDE = 6;

export interface RenderNetwork {
  name: string;
  bbox: [number, number, number, number];
  lat0: number;
  lon0: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };

  linkCount: number;
  linkGeomStart: Int32Array;
  geomX: Float32Array;
  geomY: Float32Array;
  geomCum: Float32Array;
  linkLanes: Uint8Array;
  linkLaneWidth: Float32Array;
  linkClass: Uint8Array;
  linkSpeed: Float32Array;
  linkCapacity: Float32Array;
  linkFrom: Int32Array;
  linkTo: Int32Array;
  linkReverse: Int32Array;
  linkNameId: Int32Array;
  linkStartOff: Float32Array;
  linkDriveLen: Float32Array;
  names: string[];

  nodeX: Float64Array;
  nodeY: Float64Array;
  nodeControl: Uint8Array;

  signals: RenderSignal[];
  zones: RenderZone[];
  places: RenderPlace[];
}

export interface RenderSignal {
  id: number;
  x: number;
  y: number;
  name: string;
  phaseCount: number;
  cycle: number;
  offset: number;
  mode: SignalMode;
  gapOut: number;
  phases: Phase[];
  /** Tillfartslänkar per signalgrupp — för att kunna markera dem i kartan. */
  groupLinks: number[];
}

/** En namngiven målpunkt att visa på kartan. */
export interface RenderPlace {
  name: string;
  x: number;
  y: number;
  /** Grupp för symbol och färg: 0 handel, 1 kontor, 2 industri, 3 skola, 4 vård, 5 övrigt. */
  kind: number;
  /** Bilresor per vardagsdygn platsen drar till sig. */
  pull: number;
}

export interface RenderZone {
  id: number;
  x: number;
  y: number;
  name: string;
  production: number;
  attraction: number;
  external: boolean;
}

/** Vad länkfärgen ska visa. */
export const LinkMetric = {
  Speed: 0,
  Flow: 1,
  Saturation: 2,
  Queue: 3,
  Delay: 4,
  Class: 5,
} as const;
export type LinkMetric = (typeof LinkMetric)[keyof typeof LinkMetric];

export type ToWorker =
  | { type: 'init'; city: string; url: string; maxVehicles?: number }
  | { type: 'run'; playing: boolean; speed: number }
  | { type: 'config'; patch: Partial<SimConfig> }
  | { type: 'demand'; patch: { totalTrips?: number } }
  | { type: 'focus'; x: number; y: number; radius: number; full: boolean }
  | { type: 'metric'; metric: LinkMetric }
  | { type: 'closeLink'; link: number; closed: boolean }
  | { type: 'setLanes'; link: number; lanes: number }
  | { type: 'setSpeed'; link: number; kmh: number }
  | { type: 'signalPlan'; id: number; phases: Phase[]; offset: number; mode: SignalMode; gapOut: number }
  | { type: 'signalOptimise'; ids: number[] }
  | { type: 'greenWave'; ids: number[]; speedKmh: number }
  | { type: 'manualFlow'; flow: { id: number; name: string; fromZone: number; toZone: number; vehiclesPerHour: number; active: boolean } }
  | { type: 'removeFlow'; id: number }
  | { type: 'importOd'; csv: string }
  | { type: 'exportOd' }
  | { type: 'reset' }
  | { type: 'snapshot' }
  | { type: 'restore'; id: number }
  | { type: 'inspect'; link: number }
  | { type: 'inspectVehicle'; vehicle: number }
  | { type: 'followVehicle'; vehicle: number }
  | { type: 'setHour'; hour: number }
  | { type: 'returnBuffer'; buffer: ArrayBuffer };

export interface LinkInfo {
  link: number;
  name: string;
  className: string;
  lanes: number;
  speedKmh: number;
  flow: number;
  saturation: number;
  queue: number;
  delayHours: number;
  meanSpeedKmh: number;
  closed: boolean;
  lengthM: number;
  reverse: number;
}

/** En enskild bils resa, som den ser ut just nu. */
export interface VehicleInfo {
  vehicle: number;
  typeName: string;
  /** Varifrån resan startade. */
  originName: string;
  originCharacter: string;
  originX: number;
  originY: number;
  /** Vart den är på väg. */
  destName: string;
  destCharacter: string;
  destX: number;
  destY: number;
  /** Sekunder sedan resan började. */
  elapsed: number;
  /** Körd sträcka i meter. */
  travelled: number;
  /** Återstående sträcka längs vald väg, meter. -1 om vägen inte gick att följa. */
  remaining: number;
  delaySeconds: number;
  stops: number;
  speedKmh: number;
  /** Var bilen är just nu. */
  onStreet: string;
  streetClass: string;
  /** Läge, för att kunna följa bilen i kartan. */
  x: number;
  y: number;
  /** Vald väg framåt som en punktkedja, för att kunna ritas ut. */
  route: Float32Array;
  /** Modellen bilen körs i just nu. */
  detailed: boolean;
}

export interface Bottleneck {
  link: number;
  name: string;
  className: string;
  delayHours: number;
  saturation: number;
  queue: number;
  meanSpeedKmh: number;
  freeSpeedKmh: number;
  x: number;
  y: number;
}

export interface ScenarioSummary {
  id: number;
  name: string;
  stats: NetworkStats;
  simMinutes: number;
}

export type FromWorker =
  | { type: 'progress'; text: string }
  | {
      type: 'ready';
      network: RenderNetwork;
      stats: NetworkStats;
      demandTotal: number;
      /** Uppskattad folkmängd i området — gör efterfrågan granskningsbar. */
      population: number;
    }
  | {
      type: 'frame';
      buffer: ArrayBuffer;
      vehicleCount: number;
      linkMetric: Float32Array;
      signalState: Uint8Array;
      stats: NetworkStats;
      bottlenecks: Bottleneck[];
    }
  | { type: 'linkInfo'; info: LinkInfo }
  | { type: 'vehicleInfo'; info: VehicleInfo | null }
  | { type: 'odCsv'; csv: string }
  | { type: 'odImported'; applied: number; skipped: number }
  | { type: 'signalUpdated'; signals: RenderSignal[] }
  | { type: 'scenarios'; list: ScenarioSummary[] }
  | { type: 'error'; message: string };
