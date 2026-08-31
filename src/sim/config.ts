/**
 * Inställningar för simuleringen: förarbeteende, trafikregler och fordonsmix.
 * Allt här är avsett att kunna ändras från gränssnittet under körning.
 *
 * Standardvärdena är kalibrerade mot svenska förhållanden — tidsluckor och
 * kritiska luckor följer VGU och Trafikverkets kapacitetshandbok.
 */

export const VehicleType = {
  Car: 0,
  Van: 1,
  Truck: 2,
  Bus: 3,
} as const;
export type VehicleType = (typeof VehicleType)[keyof typeof VehicleType];

export interface VehicleClass {
  label: string;
  /** Meter, inklusive den lucka som alltid hålls till framförvarande. */
  length: number;
  /** Största komfortabla acceleration, m/s². */
  accel: number;
  /** Komfortabel inbromsning, m/s². */
  decel: number;
  /** Andel av skyltad hastighet fordonet siktar på. */
  speedFactor: number;
  /** Gram CO2 per kilometer vid 50 km/h, jämn körning. */
  co2Base: number;
}

export const VEHICLE_CLASSES: readonly VehicleClass[] = [
  { label: 'Personbil', length: 4.6, accel: 1.6, decel: 2.2, speedFactor: 1.0, co2Base: 145 },
  { label: 'Skåpbil', length: 5.8, accel: 1.2, decel: 2.0, speedFactor: 0.98, co2Base: 210 },
  { label: 'Lastbil', length: 12.5, accel: 0.7, decel: 1.6, speedFactor: 0.9, co2Base: 720 },
  { label: 'Buss', length: 12.0, accel: 0.9, decel: 1.8, speedFactor: 0.92, co2Base: 830 },
];

export interface SimConfig {
  // --- Förarbeteende (IDM) ------------------------------------------------------
  /** Önskad tidslucka till framförvarande, sekunder. */
  timeHeadway: number;
  /** Minsta avstånd vid stillastående, meter. */
  minGap: number;
  /** Spridning i önskad hastighet mellan förare, som andel. */
  speedVariation: number;
  /** Hur mycket över skyltad hastighet en genomsnittsförare kör. */
  speedCompliance: number;
  /** MOBIL-hövlighet: 0 = tar alltid luckan, 1 = tar bara hänsyn till andra. */
  politeness: number;
  /** Otålighet: hur snabbt kritiska luckor krymper när man stått still länge. */
  impatience: number;

  // --- Trafikregler --------------------------------------------------------------
  /** Kritisk lucka vid väjningsplikt, sekunder. */
  giveWayGap: number;
  /** Kritisk lucka för vänstersväng mot mötande, sekunder. */
  leftTurnGap: number;
  /** Kritisk lucka vid infart i cirkulationsplats, sekunder. */
  roundaboutGap: number;
  /** Kritisk lucka efter stopplikt, sekunder. */
  stopSignGap: number;
  /** Tid som krävs stillastående vid stopplikt, sekunder. */
  stopSignDwell: number;
  /** Andel förare som kör på gult när de kunde ha stannat. */
  amberRunning: number;
  /**
   * Förbud mot att köra in i en korsning man inte kan lämna. Avstängt ger
   * blockerade korsningar vid överbelastning — vilket är precis vad som händer
   * i verkligheten när regeln inte följs.
   */
  blockingRule: boolean;
  /** Global hastighetsjustering i km/h, adderas på alla skyltade gränser. */
  speedLimitDelta: number;

  // --- Fordonsmix ---------------------------------------------------------------
  /** Andel lastbilar, 0–1. */
  truckShare: number;
  /** Andel bussar, 0–1. */
  busShare: number;
  /** Andel skåpbilar, 0–1. */
  vanShare: number;

  // --- Efterfrågan --------------------------------------------------------------
  /**
   * Skalfaktor på hela efterfrågan. 1,2 = 20 % mer trafik än basåret.
   *
   * 1 betyder den efterfrågan modellen själv räknat fram ur bebyggelsen.
   */
  demandScale: number;
  /** Startklockslag i timmar. */
  startHour: number;

  // --- Simulering ---------------------------------------------------------------
  /** Tidssteg i sekunder. 0,25 ger stabil IDM upp till motorvägshastighet. */
  dt: number;
  /** Radie runt kameran där fordon simuleras mikroskopiskt, meter. */
  focusRadius: number;
  /** Övre gräns för antal samtidiga fordon. */
  maxVehicles: number;
  /**
   * Hur lång tid en full omräkning av alla ruttträd får ta, i simulerade sekunder.
   * Det är den här takten som avgör hur snabbt trafiken hittar undan från en kö —
   * går den för långsamt fortsätter fordon att välja vägar som redan står stilla,
   * och nätet lastar upp sig utan att hitta jämvikt.
   */
  rerouteCycle: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  timeHeadway: 1.2,
  minGap: 2.0,
  speedVariation: 0.11,
  speedCompliance: 1.05,
  politeness: 0.3,
  impatience: 0.06,

  giveWayGap: 5.5,
  leftTurnGap: 5.0,
  roundaboutGap: 4.0,
  stopSignGap: 6.0,
  stopSignDwell: 1.5,
  amberRunning: 0.25,
  blockingRule: true,
  speedLimitDelta: 0,

  truckShare: 0.05,
  busShare: 0.015,
  vanShare: 0.08,

  demandScale: 1,
  startHour: 7,

  dt: 0.25,
  focusRadius: 1400,
  maxVehicles: 60000,
  rerouteCycle: 240,
};
