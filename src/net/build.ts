/**
 * Sätter ihop hela nätet i rätt ordning. Stegen är beroende av varandra:
 * signalerna måste knytas till sina korsningar innan svängrörelserna byggs,
 * eftersom företrädesreglerna ser annorlunda ut i en signalreglerad korsning.
 */

import { buildNetwork, type CityData, type RoadNetwork } from '../osm/network.ts';
import { buildMovements, type Movements } from './intersections.ts';
import { buildSignals, resolveSignalJunctions, type SignalSystem } from './signals.ts';

export interface BuiltNetwork {
  net: RoadNetwork;
  mv: Movements;
  signals: SignalSystem;
  /** Signalreglerade övergångsställen som inte hör till någon korsning. */
  midblockSignals: number;
  timings: Record<string, number>;
}

export function buildAll(data: CityData): BuiltNetwork {
  const timings: Record<string, number> = {};
  let t = performance.now();

  const net = buildNetwork(data);
  timings.nät = performance.now() - t;

  t = performance.now();
  const midblockSignals = resolveSignalJunctions(net);
  timings.signalnoder = performance.now() - t;

  t = performance.now();
  const mv = buildMovements(net);
  timings.korsningar = performance.now() - t;

  t = performance.now();
  const signals = buildSignals(net, mv);
  timings.signalplaner = performance.now() - t;

  return { net, mv, signals, midblockSignals, timings };
}
