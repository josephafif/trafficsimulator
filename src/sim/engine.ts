/**
 * Simuleringsmotorn.
 *
 * Hybridmodell: länkar nära det område planeraren tittar på körs mikroskopiskt
 * (varje fordon för sig, med IDM, filbyten och luckacceptans i korsningarna),
 * resten körs mesoskopiskt som kö-och-server per länk. Fordonen är desamma i båda
 * fallen och byter modell när de går över till en ny länk, så en resa kan börja i
 * meso, köra igenom mikroområdet och fortsätta i meso utan att tappa sin rutt.
 */

import { laneOffset, posOnLink, type RoadNetwork } from '../osm/network.ts';
import { posOnConn, YieldKind, type Movements } from '../net/intersections.ts';
import { GroupState, stepSignals, type SignalSystem } from '../net/signals.ts';
import { DRIVER_MIX, RouteTrees } from '../net/routing.ts';
import { NodeControl, Turn } from '../osm/tags.ts';
import type { DemandModel } from '../demand/demand.ts';
import { PATH_SLOT, SimState, VState } from './state.ts';
import { DEFAULT_CONFIG, VEHICLE_CLASSES, VehicleType, type SimConfig } from './config.ts';

/** Största komfortabla inbromsning innan en förare hellre kör på gult. */
const COMFORT_STOP = 3.0;
/** Säkerhetsgräns vid filbyte — den bakomvarande får inte tvingas bromsa hårdare. */
const SAFE_DECEL = 4.0;
/** Fordon per kilometer och körfält vid stillastående kö. */
const JAM_DENSITY = 145;
/** Sekunder ett fordon får stå still innan det tvingar sig fram ur ett dödläge. */
const DEADLOCK_TIME = 35;
/** Drar en förarklass ur blandningen. */
function pickDriverClass(r: number): number {
  let acc = 0;
  for (let i = 0; i < DRIVER_MIX.length; i++) {
    acc += DRIVER_MIX[i];
    if (r < acc) return i;
  }
  return DRIVER_MIX.length - 1;
}

/**
 * BPR-funktionens parametrar. Restiden är fri hastighet gånger
 * `1 + alfa * belastning^beta`, och de här värdena är de klassiska.
 */
const BPR_ALPHA = 0.15;
const BPR_BETA = 4;
/** Sekunder över beräknad restid innan ett mesofordon tvingar sig vidare. */
const MESO_DEADLOCK = 120;

/** Sekunder innan en förare överväger att svänga av från en igenproppad gata. */
const DIVERT_WAIT = 18;
/** Sekunder innan hela vägvalet görs om från nuvarande läge. */
const REPLAN_WAIT = 45;
/**
 * Hur långt före korsningen en förare börjar lägga sig i rätt fil, meter.
 *
 * Verkliga förare positionerar sig i god tid — det är just det som gör att en
 * sammanflätning fungerar. Väntar alla till stopplinjen uppstår i stället en
 * propp av bilar som ska korsa varandras körfält på de sista tio metrarna.
 */
const LANE_LOOKAHEAD = 320;
/** Vinsten i acceleration som krävs för ett frivilligt filbyte, m/s². */
const LANE_CHANGE_THRESHOLD = 0.25;
/** Extra dragning åt höger, så att vänsterfilen används för omkörning. */
const KEEP_RIGHT_BIAS = 0.18;

export interface LinkStats {
  /** Fordon på länken just nu. */
  vehicles: Float32Array;
  /** Utjämnat flöde, fordon/timme. */
  flow: Float32Array;
  /** Utjämnad medelhastighet, m/s. */
  speed: Float32Array;
  /** Stillastående fordon — köns längd i fordon. */
  queue: Float32Array;
  /** Ackumulerad fördröjning på länken, fordonssekunder. */
  delay: Float32Array;
  /**
   * Belastningsgrad. På en länk med fritt flöde är det flödet delat med
   * kapaciteten. På en överbelastad länk är det uppmätta flödet lågt just för att
   * kön stryper genomsläppet — där mäts belastningen istället som hur stor del av
   * länkens uppställningsplats som är upptagen, annars skulle den värsta
   * flaskhalsen se ut som den minst belastade sträckan i nätet.
   */
  saturation: Float32Array;
  /** Fordonskilometer sedan start — underlag för utsläpp. */
  vehKm: Float32Array;
  /** Gram CO2 sedan start. */
  co2: Float32Array;
}

export interface NetworkStats {
  time: number;
  hour: number;
  active: number;
  completed: number;
  /** Genomsnittlig restid för avslutade resor, sekunder. */
  meanTripTime: number;
  /** Genomsnittlig fördröjning per avslutad resa, sekunder. */
  meanTripDelay: number;
  meanSpeed: number;
  totalDelayHours: number;
  vehKm: number;
  co2Tonnes: number;
  /** Fordon som inte kunde släppas in i nätet på grund av köer. */
  blockedSpawns: number;
  /** Fordon som plockats bort ur nätet för att de saknade framkomlig väg. */
  lost: number;
  microLinks: number;
  spawnRate: number;
}

export class Simulation {
  readonly net: RoadNetwork;
  readonly mv: Movements;
  readonly signals: SignalSystem;
  readonly demand: DemandModel;
  readonly routes: RouteTrees;
  config: SimConfig;

  readonly s: SimState;
  time = 0;

  /** 1 = mikroskopisk länk, 0 = mesoskopisk. */
  readonly linkMicro: Uint8Array;
  /** Fordon i mesomodellens kö per länk. */
  private readonly mesoLoad: Int32Array;
  /** Utflödespott per länk, fordon som får lämna. */
  private readonly mesoTokens: Float32Array;
  /**
   * Fördröjning i korsningen i änden av varje länk, sekunder.
   *
   * Mikromodellen får sin korsningsfördröjning gratis: fordonen står och väntar.
   * Mesomodellen skulle utan den här termen låta trafiken rulla obehindrat genom
   * varje korsning, och resultatet skulle hoppa beroende på hur stort område som
   * råkar simuleras i detalj. Det gör siffrorna omöjliga att lita på.
   */
  private readonly nodeDelay: Float32Array;
  /** Avstängda länkar. */
  readonly linkClosed: Uint8Array;
  /** Ändrat antal körfält, -1 = oförändrat. */
  readonly laneOverride: Int8Array;
  /** Ändrad hastighet i m/s, 0 = oförändrad. */
  readonly speedOverride: Float32Array;

  readonly stats: LinkStats;
  /** Fordon per signalgrupp sedan start — underlag för Webster-optimering. */
  readonly groupFlow: Float32Array;
  private readonly groupCount: Float32Array;

  /** Körfältshink -> länk, för att slippa söka baklänges i varje steg. */
  private readonly laneLink: Int32Array;
  private readonly laneIndex: Uint8Array;

  private odCum: Float32Array;
  private odRowTotal: Float32Array;
  private odTCum: Float32Array;
  private odTRowTotal: Float32Array;

  private completed = 0;
  private tripTimeSum = 0;
  private tripDelaySum = 0;
  private blockedSpawns = 0;
  /** Fordon som togs bort för att grunddatan inte gav dem någon väg vidare. */
  private lost = 0;
  /** Återanvänd mellan ruttplaneringar för att slippa allokera per fordon. */
  private readonly planSeen = new Set<number>();
  /** När fordonet senast gjorde om hela sitt vägval, så det inte sker varje steg. */
  private readonly lastReplan: Float32Array;
  private spawnCarry = 0;
  private rerouteBudget = 0;
  private frame = 0;
  private rng = 0x9e3779b9;

  /** Positioner som bokats i ett körfält under pågående filbytespass. */
  private readonly claimed = new Map<number, number[]>();

  /** Flödesräknare per länk under aktuellt utjämningsfönster. */
  private readonly linkExits: Float32Array;
  private statWindow = 0;

  constructor(
    net: RoadNetwork,
    mv: Movements,
    signals: SignalSystem,
    demand: DemandModel,
    config: SimConfig = DEFAULT_CONFIG,
  ) {
    this.net = net;
    this.mv = mv;
    this.signals = signals;
    this.demand = demand;
    this.config = { ...config };
    this.routes = new RouteTrees(net, mv, signals.groupCount);
    this.routes.setDestinations(demand.zones.map((z) => z.destAnchors));

    this.s = new SimState(config.maxVehicles, mv.laneCount + mv.connCount);
    this.time = config.startHour * 3600;

    this.linkMicro = new Uint8Array(net.linkCount).fill(1);
    this.mesoLoad = new Int32Array(net.linkCount);
    this.mesoTokens = new Float32Array(net.linkCount);
    this.nodeDelay = new Float32Array(net.linkCount);
    this.lastReplan = new Float32Array(config.maxVehicles);
    this.linkClosed = new Uint8Array(net.linkCount);
    this.laneOverride = new Int8Array(net.linkCount).fill(-1);
    this.speedOverride = new Float32Array(net.linkCount);

    this.stats = {
      vehicles: new Float32Array(net.linkCount),
      flow: new Float32Array(net.linkCount),
      speed: new Float32Array(net.linkCount),
      queue: new Float32Array(net.linkCount),
      delay: new Float32Array(net.linkCount),
      saturation: new Float32Array(net.linkCount),
      vehKm: new Float32Array(net.linkCount),
      co2: new Float32Array(net.linkCount),
    };
    this.linkExits = new Float32Array(net.linkCount);
    this.groupFlow = new Float32Array(signals.groupCount);
    this.groupCount = new Float32Array(signals.groupCount);

    this.laneMark = new Int32Array(mv.laneCount).fill(-1);
    this.laneAdded = new Int32Array(mv.laneCount);
    this.laneTail = new Float32Array(mv.laneCount);
    this.laneLink = new Int32Array(mv.laneCount);
    this.laneIndex = new Uint8Array(mv.laneCount);
    for (let l = 0; l < net.linkCount; l++) {
      for (let k = 0; k < net.linkLanes[l]; k++) {
        this.laneLink[mv.laneBase[l] + k] = l;
        this.laneIndex[mv.laneBase[l] + k] = k;
      }
    }

    this.microLinkCount = net.linkCount;
    this.computeNodeDelays();

    const n = demand.zones.length;
    this.odCum = new Float32Array(n * n);
    this.odRowTotal = new Float32Array(n);
    this.odTCum = new Float32Array(n * n);
    this.odTRowTotal = new Float32Array(n);
    this.rebuildOd();
  }

  // --- Slumptal -------------------------------------------------------------------

  private rand(): number {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
    return this.rng / 4294967296;
  }

  /** Stabil pseudoslump per fordon — samma förare beter sig likadant varje gång. */
  private vehicleHash(v: number, salt: number): number {
    let h = (v * 2654435761 + salt * 2246822519) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 2246822519) >>> 0;
    return (h >>> 8) / 16777216;
  }

  // --- Efterfrågan ----------------------------------------------------------------

  /** Bygger om samplingstabellerna när OD-matrisen ändrats. */
  rebuildOd(): void {
    const n = this.demand.zones.length;
    const od = this.demand.od;
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j < n; j++) {
        acc += od[i * n + j];
        this.odCum[i * n + j] = acc;
      }
      this.odRowTotal[i] = acc;
    }
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let i = 0; i < n; i++) {
        acc += od[i * n + j];
        this.odTCum[j * n + i] = acc;
      }
      this.odTRowTotal[j] = acc;
    }
  }

  private sampleOd(outbound: boolean): [number, number] {
    const n = this.demand.zones.length;
    const rowTotals = outbound ? this.odRowTotal : this.odTRowTotal;
    const cum = outbound ? this.odCum : this.odTCum;

    let total = 0;
    for (let i = 0; i < n; i++) total += rowTotals[i];
    if (total <= 0) return [-1, -1];

    let r = this.rand() * total;
    let row = 0;
    for (; row < n - 1; row++) {
      if (r < rowTotals[row]) break;
      r -= rowTotals[row];
    }
    const rowSum = rowTotals[row];
    if (rowSum <= 0) return [-1, -1];
    const target = this.rand() * rowSum;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[row * n + mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return outbound ? [row, lo] : [lo, row];
  }

  /** Fordon per timme som ska släppas in just nu. */
  currentDemand(): number {
    const hour = Math.floor((this.time / 3600) % 24);
    let base = this.demand.totalTrips * this.demand.profile[hour] * this.config.demandScale;
    for (const f of this.demand.manualFlows) if (f.active) base += f.vehiclesPerHour;
    return base;
  }

  // --- Fordonsskapande ------------------------------------------------------------

  private pickVehicleType(): VehicleType {
    const r = this.rand();
    const c = this.config;
    if (r < c.truckShare) return VehicleType.Truck;
    if (r < c.truckShare + c.busShare) return VehicleType.Bus;
    if (r < c.truckShare + c.busShare + c.vanShare) return VehicleType.Van;
    return VehicleType.Car;
  }

  private spawn(dt: number): void {
    const perSecond = this.currentDemand() / 3600;
    this.spawnCarry += perSecond * dt;
    let budget = Math.floor(this.spawnCarry);
    if (budget <= 0) return;
    this.spawnCarry -= budget;
    // Håll takten även om nätet är fullt, annars byggs en oändlig skuld upp.
    budget = Math.min(budget, 400);

    const hour = Math.floor((this.time / 3600) % 24);
    const outboundShare = this.demand.outboundShare[hour];

    for (let i = 0; i < budget; i++) {
      const manual = this.pickManualFlow();
      const [from, to] = manual ?? this.sampleOd(this.rand() < outboundShare);
      if (from < 0 || to < 0 || from === to) continue;
      if (!this.insertVehicle(from, to)) this.blockedSpawns++;
    }
  }

  private pickManualFlow(): [number, number] | null {
    const flows = this.demand.manualFlows;
    if (flows.length === 0) return null;
    let total = 0;
    for (const f of flows) if (f.active) total += f.vehiclesPerHour;
    if (total <= 0) return null;
    const share = total / Math.max(this.currentDemand(), 1);
    if (this.rand() > share) return null;
    let r = this.rand() * total;
    for (const f of flows) {
      if (!f.active) continue;
      r -= f.vehiclesPerHour;
      if (r <= 0) return [f.fromZone, f.toZone];
    }
    return null;
  }

  private insertVehicle(fromZone: number, toZone: number): boolean {
    const origin = this.demand.zones[fromZone];
    const dest = this.demand.zones[toZone];
    if (origin.anchors.length === 0 || dest.destAnchors.length === 0) return false;

    const link = origin.anchors[Math.floor(this.rand() * origin.anchors.length)];
    if (this.linkClosed[link]) return false;

    const v = this.s.alloc();
    if (v < 0) return false;

    const type = this.pickVehicleType();
    const vc = VEHICLE_CLASSES[type];
    const s = this.s;
    s.type[v] = type;
    s.length[v] = vc.length;
    // Förarklassen dras ur den verkliga blandningen: de flesta kör snabbaste
    // vägen, en mindre del kör påtagligt annorlunda.
    s.driver[v] = pickDriverClass(this.rand());
    s.originZone[v] = fromZone;
    s.destZone[v] = toZone;
    s.destLink[v] = dest.destAnchors[Math.floor(this.rand() * dest.destAnchors.length)];
    s.pathLen[v] = 0;
    s.pathPos[v] = 0;
    s.enterTime[v] = this.time;
    s.linkEnterTime[v] = this.time;
    s.delay[v] = 0;
    s.distance[v] = 0;
    s.stops[v] = 0;
    s.waited[v] = 0;
    s.dwell[v] = 0;
    s.lateral[v] = 0;
    s.nextConn[v] = -1;
    s.wantLink[v] = -1;
    s.desired[v] = this.desiredSpeed(v, link);

    if (this.linkMicro[link] === 1) {
      const lane = this.freeLaneOn(link, vc.length);
      if (lane < 0) {
        s.release(v);
        return false;
      }
      s.state[v] = VState.Micro;
      s.link[v] = link;
      s.conn[v] = -1;
      s.lane[v] = lane;
      s.pos[v] = 0;
      s.speed[v] = Math.min(this.net.linkSpeed[link], s.desired[v]) * 0.6;
      this.s.registerNew(v);
    } else {
      if (!this.mesoHasRoom(link)) {
        s.release(v);
        return false;
      }
      this.enterMeso(v, link);
    }
    return true;
  }

  /** Önskad hastighet: skyltat värde justerat för förartyp, spridning och regeländring. */
  private desiredSpeed(v: number, link: number): number {
    const c = this.config;
    const base = this.linkSpeed(link);
    const spread = 1 + c.speedVariation * (this.vehicleHash(v, 7) * 2 - 1);
    const vc = VEHICLE_CLASSES[this.s.type[v]];
    return Math.max(3, base * c.speedCompliance * spread * vc.speedFactor);
  }

  linkSpeed(link: number): number {
    const override = this.speedOverride[link];
    const base = override > 0 ? override : this.net.linkSpeed[link];
    return Math.max(2, base + this.config.speedLimitDelta / 3.6);
  }

  linkLanes(link: number): number {
    const o = this.laneOverride[link];
    return o >= 0 ? Math.max(1, o) : this.net.linkLanes[link];
  }

  /**
   * Körfältens beläggning under pågående tidssteg.
   *
   * Fordon kommer in i ett körfält från tre håll — nya resor, filbyten och fordon
   * som lämnar en korsning — och hinkarna uppdateras först vid nästa sortering.
   * Utan en gemensam bokning ser alla tre samma lediga plats och packar in fler
   * fordon än körfältet är långt, varpå de överlappar och låser sig för gott.
   */
  private readonly laneMark: Int32Array;
  private readonly laneAdded: Int32Array;
  /** Bakersta stötfångarläget som bokats i körfältet under steget. */
  private readonly laneTail: Float32Array;

  /** Fordon körfältet rymmer stötfångare mot stötfångare. */
  private laneCapacity(link: number): number {
    return Math.max(1, Math.floor(this.mv.linkDriveLen[link] / 6.5));
  }

  private laneReset(b: number): void {
    if (this.laneMark[b] === this.frame) return;
    this.laneMark[b] = this.frame;
    this.laneAdded[b] = 0;
    this.laneTail[b] = Infinity;
  }

  /**
   * Fordon som redan rullar genom korsningen mot det här körfältet har tagit sin
   * plats, även om de inte står på länken än. Räknas de inte med godkänner varje
   * tillfart för sig samma enda lucka, och de blir alla stående i korsningen.
   */
  private committedTo(link: number, lane: number): number {
    const mv = this.mv;
    const b = mv.laneBase[link] + lane;
    let n = 0;
    for (let k = mv.laneInStart[b]; k < mv.laneInStart[b + 1]; k++) {
      const conn = mv.laneIn[k];
      const cb = mv.laneCount + conn;
      // Bara de som passerat halva korsningen — den som just kört in hinner
      // stanna, och att reservera plats åt den kväver genomsläppet i onödan.
      const half = mv.connLength[conn] * 0.5;
      for (let i = this.s.bucketStart[cb]; i < this.s.bucketStart[cb + 1]; i++) {
        if (this.s.pos[this.s.order[i]] >= half) n++;
      }
    }
    return n;
  }

  /**
   * Finns det plats för ytterligare ett fordon längst bak i körfältet?
   *
   * `relaxed` används när ett fordon tvingar sig ur ett dödläge: kravet på lucka
   * släpps, men aldrig så långt att fordonet hamnar ovanpå det som redan står
   * där. Två fordon på samma punkt kan nämligen aldrig separera igen — de bromsar
   * för varandra i all evighet och blir stående för gott.
   */
  private laneRoom(link: number, lane: number, reserve = 0, relaxed = false): boolean {
    const b = this.mv.laneBase[link] + lane;
    this.laneReset(b);
    const s = this.s;
    const start = s.bucketStart[b];
    const end = s.bucketStart[b + 1];
    if (!relaxed && end - start + this.laneAdded[b] + reserve >= this.laneCapacity(link)) {
      return false;
    }
    // Bara ett fordon per körfält och tidssteg får krångla sig in.
    if (relaxed && this.laneAdded[b] > 0) return false;

    let rearTail = this.laneTail[b];
    if (end > start) {
      const rear = s.order[end - 1];
      rearTail = Math.min(rearTail, s.pos[rear] - s.length[rear]);
    }
    // Även ett trängande fordon behöver en hel bils lucka. Utan den hamnar det
    // ovanpå kön, och två fordon på samma punkt kan aldrig separera igen.
    return rearTail > (relaxed ? 1.5 : this.config.minGap);
  }

  /** Bokar platsen så att nästa inmatningsväg ser den som upptagen. */
  private laneTake(link: number, lane: number, pos: number, length: number): void {
    const b = this.mv.laneBase[link] + lane;
    this.laneReset(b);
    this.laneAdded[b]++;
    this.laneTail[b] = Math.min(this.laneTail[b], pos - length);
  }

  /** Ett körfält på länkens början med plats för ett nytt fordon. */
  private freeLaneOn(link: number, length: number): number {
    const lanes = this.linkLanes(link);
    for (let k = 0; k < lanes; k++) {
      if (!this.laneRoom(link, k)) continue;
      this.laneTake(link, k, 0, length);
      return k;
    }
    return -1;
  }


  // --- Meso -----------------------------------------------------------------------

  /**
   * Schablonfördröjning per korsningstyp, samma storleksordning som mikromodellen
   * ger. Signalfördröjningen räknas om när signalplanerna ändras.
   */
  computeNodeDelays(): void {
    const net = this.net;
    for (let l = 0; l < net.linkCount; l++) {
      const node = net.linkTo[l];
      const grenar =
        net.nodeInStart[node + 1] - net.nodeInStart[node] +
        net.nodeOutStart[node + 1] - net.nodeOutStart[node];
      if (grenar <= 2) {
        this.nodeDelay[l] = 0;
        continue;
      }
      switch (net.nodeControl[node]) {
        case NodeControl.Signal: {
          // Medelväntetid vid jämn ankomst; signalplanen bestämmer den exakt.
          let cycle = 0;
          let green = 0;
          for (let c = this.mv.nodeConnStart[node]; c < this.mv.nodeConnStart[node + 1]; c++) {
            if (this.mv.connFromLink[c] !== l) continue;
            const g = this.mv.connSignalGroup[c];
            if (g < 0) continue;
            const ctrl = this.signals.controllers[this.signals.groupCtrl[g]];
            if (!ctrl) continue;
            cycle = 0;
            green = 0;
            for (const p of ctrl.phases) {
              cycle += p.green + p.amber + p.allRed + 1;
              if (p.groups.includes(g)) green += p.green;
            }
            break;
          }
          // Websters fördröjning: den jämna väntan på grönt plus ett tillägg som
          // växer när tillfarten närmar sig sin kapacitet. Utan tillägget ser en
          // överbelastad korsning lika snabb ut som en tom.
          if (cycle > 0) {
            const share = green / cycle;
            const capacity = net.linkCapacity[l] * this.linkLanes(l) * share;
            const x = Math.min(this.stats.flow[l] / Math.max(capacity, 1), 0.98);
            const uniform = (cycle * (1 - share) ** 2) / (2 * (1 - share * x));
            const overflow = (x * x) / (2 * Math.max(1 - x, 0.02)) * 0.9;
            this.nodeDelay[l] = uniform + Math.min(overflow, 120);
          } else {
            this.nodeDelay[l] = 12;
          }
          break;
        }
        case NodeControl.Roundabout:
          this.nodeDelay[l] = 3;
          break;
        default:
          // Väjningsplikt eller högerregel: högre klass slipper undan billigare.
          this.nodeDelay[l] = net.linkPriority[l] >= 6 ? 1.5 : 4;
      }
    }
  }

  private mesoStorage(link: number): number {
    // Golvet på tre fordon är viktigt: nätet är fullt av korta länkstumpar
    // mellan täta korsningar, och en stump som rymmer ett enda fordon spärrar
    // uppströms så fort någon står där. Den spärren fortplantar sig bakåt och
    // låser hela stråk som i verkligheten flyter.
    return Math.max(3, (this.mv.linkDriveLen[link] / 1000) * JAM_DENSITY * this.linkLanes(link));
  }

  private mesoHasRoom(link: number): boolean {
    return this.mesoLoad[link] < this.mesoStorage(link);
  }

  private enterMeso(v: number, link: number): void {
    const s = this.s;
    s.state[v] = VState.Meso;
    s.link[v] = link;
    s.conn[v] = -1;
    s.pos[v] = 0;
    s.mesoEnter[v] = this.time;
    s.linkEnterTime[v] = this.time;
    this.mesoLoad[link]++;

    const len = this.mv.linkDriveLen[link];
    const free = Math.min(this.linkSpeed(link), s.desired[v]);

    // Restiden sätts av två saker som verkar oberoende av varandra: hur hårt
    // belastad sträckan är, och hur mycket som väntas bort i korsningen i änden.
    //
    // Belastningen räknas med BPR-funktionen, standardmodellen i nätutläggning:
    // restiden växer med belastningsgraden upphöjt till fyra, alltså knappt alls
    // tills flödet närmar sig kapaciteten och sedan mycket snabbt. Tätheten på
    // länken just nu duger inte som mått — den hålls låg av att fordonen hinner
    // ut, vilket ger en återkoppling som aldrig biter.
    const capacity = this.net.linkCapacity[link] * this.linkLanes(link);
    const load = Math.min(this.stats.flow[link] / Math.max(capacity, 1), 2.5);
    const congestion = 1 + BPR_ALPHA * Math.pow(load, BPR_BETA);
    const speed = Math.max(free / congestion, free * 0.1);

    // Korsningen i änden av länken kostar också tid. Mättnadsberoendet ligger
    // redan i nodeDelay via Websters formel, så här behövs inget påslag ovanpå.
    const queueing = Math.min(this.nodeDelay[link], 90);
    const travelTime = len / speed + queueing;

    // Hastigheten som redovisas måste rymma hela restiden, väntan inräknad.
    // Räknas bara sträckan ser ett fordon som står och väntar i en korsning ut
    // att köra i skyltad hastighet, och nätet framstår som friktionsfritt i
    // statistiken samtidigt som bilarna i själva verket blir stående.
    s.speed[v] = len / Math.max(travelTime, 0.5);
    s.mesoExit[v] = this.time + travelTime;
  }

  private leaveMeso(v: number): void {
    this.mesoLoad[this.s.link[v]]--;
  }

  private stepMeso(dt: number): void {
    const s = this.s;
    const net = this.net;

    for (let l = 0; l < net.linkCount; l++) {
      if (this.linkMicro[l] === 1 || this.mesoLoad[l] === 0) continue;
      // Utflödet begränsas av mättnadsflödet, precis som i mikromodellen.
      const cap = (net.linkCapacity[l] * this.linkLanes(l)) / 3600;
      this.mesoTokens[l] = Math.min(this.mesoTokens[l] + cap * dt, 3);
    }

    for (let v = 0; v < s.capacity; v++) {
      if (s.state[v] !== VState.Meso) continue;
      const link = s.link[v];
      // Mesofordonen går inte genom integrate(), så deras fördröjning måste
      // bokföras här — annars ser nätet orimligt friktionsfritt ut i statistiken.
      s.delay[v] += dt * Math.max(0, 1 - s.speed[v] / s.desired[v]);
      if (this.time < s.mesoExit[v]) continue;
      if (this.mesoTokens[link] < 1) continue;
      // Har fordonet stått långt över sin beräknade restid är stråket låst.
      // Mesomodellen har annars ingen väg ur ett sådant läge — till skillnad
      // från mikromodellen, där föraren till slut tvingar sig fram — och en
      // enda propp kan låsa en hel infartsled bakåt i all evighet.
      const overdue = this.time - s.mesoExit[v] > MESO_DEADLOCK;

      // Framme vid målet är något helt annat än att ha tappat sin väg. Räknas
      // det senare som en avslutad resa försvinner fordonet ur nätet i förtid,
      // resorna ser kortare ut än de är och statistiken visar fler klara resor
      // än vad som faktiskt kört fram.
      if (link === s.destLink[v]) {
        this.mesoTokens[link] -= 1;
        this.leaveMeso(v);
        this.recordLinkExit(v, link);
        this.finishTrip(v);
        continue;
      }
      const next = this.routeNext(v, link);
      if (next < 0 || next === link) {
        this.mesoTokens[link] -= 1;
        this.leaveMeso(v);
        this.recordLinkExit(v, link);
        this.lost++;
        s.release(v);
        continue;
      }
      if (this.linkClosed[next]) {
        // Stängd väg framför: sök ny rutt vid nästa försök.
        s.mesoExit[v] = this.time + 2;
        continue;
      }

      if (this.linkMicro[next] === 1) {
        const lane = this.freeLaneOn(next, s.length[v]);
        if (lane < 0) continue; // spillback: kön står kvar på den här länken
        void overdue;
        this.mesoTokens[link] -= 1;
        this.leaveMeso(v);
        this.recordLinkExit(v, link);
        s.state[v] = VState.Micro;
        s.link[v] = next;
        s.lane[v] = lane;
        s.pos[v] = 0;
        s.conn[v] = -1;
        s.nextConn[v] = -1;
        s.wantLink[v] = -1;
        s.desired[v] = this.desiredSpeed(v, next);
        s.speed[v] = Math.min(s.speed[v], s.desired[v]);
        s.linkEnterTime[v] = this.time;
        s.registerNew(v);
      } else {
        if (!this.mesoHasRoom(next) && !overdue) continue;
        this.mesoTokens[link] -= 1;
        this.leaveMeso(v);
        this.recordLinkExit(v, link);
        s.desired[v] = this.desiredSpeed(v, next);
        this.enterMeso(v, next);
      }
    }
  }

  // --- Ruttval --------------------------------------------------------------------

  /**
   * Lägger upp en färdig rutt från `link` till fordonets mål.
   *
   * Rutten byggs ur målzonens kortaste-väg-träd för förarens klass, och samma
   * länk kan aldrig förekomma två gånger — det är den garantin som gör rundgång
   * omöjlig. Blir vägen längre än det som ryms planeras resten under färden.
   *
   * Returnerar false om målet inte går att nå.
   */
  private planRoute(v: number, link: number): boolean {
    const s = this.s;
    const base = v * PATH_SLOT;
    const tree = this.routes.tree(s.destZone[v], s.driver[v]);
    if (!tree) return false;

    let current = link;
    let n = 0;
    let arrives = false;
    const seen = this.planSeen;
    seen.clear();
    while (n < PATH_SLOT) {
      s.pathPool[base + n] = current;
      n++;
      seen.add(current);
      if (current === s.destLink[v]) {
        arrives = true;
        break;
      }
      const next = tree[current];
      if (next < 0) break;
      // Rotkontrollen måste ligga före cykelkontrollen: en rot pekar på sig själv,
      // och länken ligger redan i besökslistan.
      if (next === current) {
        // Trädet har alla målzonens ankarlänkar som rot, så vägen leder till den
        // närmaste av dem — inte nödvändigtvis till just den som lottades fram.
        // Det är den punkten resan faktiskt slutar vid, så målet flyttas dit.
        // Utan det här misslyckas planeringen för nästan varje resa inom staden,
        // och fordonen försvinner ur nätet på halva vägen.
        s.destLink[v] = current;
        arrives = true;
        break;
      }
      if (seen.has(next)) break;
      current = next;
    }
    s.pathLen[v] = n;
    s.pathPos[v] = 0;
    return n > 0 && (arrives || n === PATH_SLOT);
  }

  /**
   * Nästa länk enligt fordonets planerade rutt.
   *
   * Ligger fordonet inte där rutten säger — det har svängt av från en igenproppad
   * gata, eller kommit ut på en länk som planerades bort — läggs en ny rutt upp
   * från där det faktiskt står.
   */
  private routeNext(v: number, link: number): number {
    const s = this.s;
    if (link === s.destLink[v]) return link;
    const base = v * PATH_SLOT;
    let pos = s.pathPos[v];

    if (pos >= s.pathLen[v] || s.pathPool[base + pos] !== link) {
      // Sök först i det som återstår av rutten; en enda avvikelse ska inte
      // kosta en helt ny planering.
      let found = -1;
      for (let i = pos; i < s.pathLen[v]; i++) {
        if (s.pathPool[base + i] === link) {
          found = i;
          break;
        }
      }
      if (found >= 0) {
        pos = found;
        s.pathPos[v] = pos;
      } else if (!this.planRoute(v, link)) {
        return -1;
      } else {
        pos = 0;
      }
    }

    // Nära slutet av den lagrade delen utan att vara framme: planera vidare.
    if (pos + 2 >= s.pathLen[v] && s.pathPool[base + s.pathLen[v] - 1] !== s.destLink[v]) {
      if (!this.planRoute(v, link)) return -1;
      pos = 0;
    }
    return pos + 1 < s.pathLen[v] ? s.pathPool[base + pos + 1] : -1;
  }

  /** Rutten framåt som en lista av länkar, för granskning och utritning. */
  plannedPath(v: number): Int32Array {
    const s = this.s;
    const base = v * PATH_SLOT;
    return s.pathPool.subarray(base + s.pathPos[v], base + s.pathLen[v]);
  }

  // --- Mikromodell ----------------------------------------------------------------

  private bucketOf = (v: number): number => {
    const st = this.s.state[v];
    if (st === VState.Micro) return this.mv.laneBase[this.s.link[v]] + this.s.lane[v];
    if (st === VState.OnConn) return this.mv.laneCount + this.s.conn[v];
    return -1;
  };

  /** Intelligent Driver Model. */
  private idm(v: number, gap: number, leadSpeed: number): number {
    const s = this.s;
    const c = this.config;
    const vc = VEHICLE_CLASSES[s.type[v]];
    const speed = s.speed[v];
    const v0 = s.desired[v];

    const freeTerm = 1 - (speed / v0) ** 4;
    if (gap === Infinity) return vc.accel * freeTerm;

    const dv = speed - leadSpeed;
    const sStar =
      c.minGap + Math.max(0, speed * c.timeHeadway + (speed * dv) / (2 * Math.sqrt(vc.accel * vc.decel)));
    const interaction = (sStar / Math.max(gap, 0.4)) ** 2;
    return vc.accel * (freeTerm - interaction);
  }

  private stepMicro(dt: number): void {
    const s = this.s;
    const mv = this.mv;

    // --- Körfält ------------------------------------------------------------------
    for (let b = 0; b < mv.laneCount; b++) {
      const start = s.bucketStart[b];
      const end = s.bucketStart[b + 1];
      if (end === start) continue;
      const link = this.laneLink[b];
      const lane = this.laneIndex[b];
      const lanes = this.linkLanes(link);
      const driveLen = mv.linkDriveLen[link];

      for (let i = start; i < end; i++) {
        const v = s.order[i];
        let gap: number;
        let leadSpeed: number;
        if (i === start) {
          const con = this.junctionConstraint(v, link, lane, driveLen);
          gap = con.gap;
          leadSpeed = con.speed;
        } else {
          const lead = s.order[i - 1];
          gap = s.pos[lead] - s.length[lead] - s.pos[v];
          leadSpeed = s.speed[lead];
        }

        // Samverkan: ser jag någon i grannfilen som måste in framför mig,
        // släpper jag fram. Det är så en sammanflätning fungerar i verkligheten
        // — annars uppstår aldrig någon lucka när det är tätt, och båda filerna
        // stannar upp i stället för att vävas ihop.
        const merger = this.mergerBeside(v, link, lane, lanes);
        if (merger >= 0) {
          const mergeGap = s.pos[merger] - s.length[merger] - s.pos[v];
          if (mergeGap < gap) {
            gap = mergeGap;
            leadSpeed = s.speed[merger];
          }
        }
        s.accel[v] = this.idm(v, gap, leadSpeed);
      }
    }

    // --- Inne i korsningarna --------------------------------------------------------
    for (let c = 0; c < mv.connCount; c++) {
      const b = mv.laneCount + c;
      const start = s.bucketStart[b];
      const end = s.bucketStart[b + 1];
      if (end === start) continue;
      const connLen = mv.connLength[c];
      const toLink = mv.connToLink[c];
      const toLane = mv.connToLane[c];

      for (let i = start; i < end; i++) {
        const v = s.order[i];
        // Den som blivit stående inne i korsningen måste också kunna ta sig ut.
        // Ett enda icke-tvingande fordon främst på rörelsen låser annars alla
        // bakom det, och därmed hela korsningen.
        if (s.forcing[v] === 0 && s.waited[v] > DEADLOCK_TIME) s.forcing[v] = 1;
        let gap = Infinity;
        let leadSpeed = 0;
        if (i > start) {
          const lead = s.order[i - 1];
          gap = s.pos[lead] - s.length[lead] - s.pos[v];
          leadSpeed = s.speed[lead];
        } else if (this.linkMicro[toLink] === 1) {
          // Följ efter kön på länken man ska ut på. Det gäller även den som
          // tvingar sig fram ur ett dödläge: ventilen får släppa på *reglerna* —
          // väjningsplikt, förbudet att köra in i en korsning man inte kan lämna
          // — men aldrig på fysiken. En bil kan inte köra genom en annan bil, och
          // gör den det i modellen syns det direkt på skärmen.
          const tb = mv.laneBase[toLink] + Math.min(toLane, this.linkLanes(toLink) - 1);
          const te = s.bucketStart[tb + 1];
          if (te > s.bucketStart[tb]) {
            const lead = s.order[te - 1];
            gap = connLen - s.pos[v] + s.pos[lead] - s.length[lead];
            leadSpeed = s.speed[lead];
          }
        }
        s.accel[v] = this.idm(v, gap, leadSpeed);
      }
    }

    this.laneChanges();
    this.integrate(dt);
    this.separate();
    this.transfer();
  }

  /**
   * Vad som stoppar fordonet längst fram i ett körfält: signal, väjningsplikt,
   * fordon i korsningen eller kö på länken efter.
   */
  private junctionConstraint(
    v: number,
    link: number,
    lane: number,
    driveLen: number,
  ): { gap: number; speed: number } {
    const s = this.s;
    const mv = this.mv;
    const distToLine = driveLen - s.pos[v];
    const free = { gap: Infinity, speed: 0 };
    const stop = { gap: Math.max(distToLine, 0.1), speed: 0 };

    // Har fordonet väntat orimligt länge tar det sig fram oavsett. Beslutet
    // ligger kvar tills korsningen är passerad, annars nollställs väntetiden av
    // den första metern och fordonet blir stående för alltid.
    //
    // Otåligheten måste avgöras *före* grenvalet. Väntar fordonet på ett filbyte
    // som aldrig går att göra håller grenvalet inne sitt svar tills ventilen har
    // släppt — och släpper den först efteråt blir fordonet stående för gott och
    // spärrar hela kön bakom sig.
    if (s.forcing[v] === 0 && s.waited[v] > DEADLOCK_TIME) s.forcing[v] = 1;
    const forcing = s.forcing[v] === 1;

    const conn = this.chooseConnection(v, link, lane, distToLine);
    // Inget körfält härifrån leder rätt och ingen gren gick att ta — stanna.
    if (conn < 0) return stop;

    // Sänk farten inför en sväng — man kör inte 50 km/h runt ett gathörn.
    const turnLimit = this.turnSpeed(mv.connTurn[conn]);
    if (turnLimit < s.desired[v] && distToLine < 40) {
      const braking = Math.max(distToLine, 1);
      const needed = (s.speed[v] ** 2 - turnLimit ** 2) / (2 * braking);
      if (needed > 0.2) return { gap: braking, speed: turnLimit };
    }

    // Fordon redan inne på svängrörelsen.
    const cb = mv.laneCount + conn;
    if (s.bucketStart[cb + 1] > s.bucketStart[cb]) {
      const rear = s.order[s.bucketStart[cb + 1] - 1];
      return { gap: distToLine + s.pos[rear] - s.length[rear], speed: s.speed[rear] };
    }

    if (this.linkClosed[mv.connToLink[conn]]) return stop;

    // Signal.
    const group = mv.connSignalGroup[conn];
    if (group >= 0) {
      const st = this.signals.groupState[group];
      if (st === GroupState.Red || st === GroupState.RedAmber) {
        this.signals.groupDemand[group] += 1;
        return stop;
      }
      if (st === GroupState.Amber) {
        const needed = s.speed[v] ** 2 / (2 * Math.max(distToLine, 0.5));
        const runs = this.vehicleHash(v, 21) < this.config.amberRunning;
        if (needed <= COMFORT_STOP && !runs) return stop;
      }
      this.signals.groupGap[group] = 0;
    }

    // Väjnings- och stopplikt.
    const yieldKind = mv.connYield[conn];
    if (yieldKind !== YieldKind.Major && distToLine < 25) {
      // Permissiv vänstersväng vid signal: den som väntat en stund på grönt tar
      // luckan betydligt mer bestämt än i en osignalerad korsning, och när det
      // slår om till gult tömmer de väntande korsningen. Utan det här beteendet
      // står vänstersvängfältet still hela cykeln och proppar igen tillfarten.
      if (group >= 0 && this.signals.groupState[group] === GroupState.Amber && s.speed[v] < 3) {
        return free;
      }
      if (yieldKind === YieldKind.Stop && !forcing) {
        if (s.speed[v] > 0.4 && s.dwell[v] < this.config.stopSignDwell) return stop;
        s.dwell[v] += this.config.dt;
      }
      // Den som väntat tillräckligt länge tar sig fram ändå. Utan det kan tre
      // tillfarter som var för sig lämnar företräde åt höger låsa varandra för gott
      // — i verkligheten löser förarna det genom att någon tar initiativet.
      if (!forcing && !this.hasGap(v, conn)) return stop;
    }

    // Kör inte in i en korsning man inte kan lämna.
    if (this.config.blockingRule && !this.spaceAfter(conn)) {
      // Står gatan man ska ut på helt stilla svänger föraren av åt annat håll
      // istället för att vänta ut den. Det är både vad folk gör och det enda som
      // löser upp en ring av fulla gator i ett rutnät: så länge alla står kvar
      // och väntar på varandra kommer ringen aldrig i rörelse igen.
      const alternative = this.divertFrom(v, link, lane, conn);
      if (alternative >= 0) return free;
      if (!forcing) return stop;
    }
    return free;
  }

  /**
   * Ett fordon i grannfilen som behöver in framför mig, eller -1.
   *
   * Bara den som verkligen måste byta fil för att komma rätt räknas, och bara
   * strax framför — annars skulle varje bil bromsa för allt som råkar ligga
   * bredvid.
   */
  private mergerBeside(v: number, link: number, lane: number, lanes: number): number {
    const s = this.s;
    const mv = this.mv;
    let best = -1;
    let bestGap = Infinity;
    for (const dir of [-1, 1] as const) {
      const other = lane + dir;
      if (other < 0 || other >= lanes) continue;
      const b = mv.laneBase[link] + other;
      const start = s.bucketStart[b];
      const end = s.bucketStart[b + 1];
      for (let i = start; i < end; i++) {
        const u = s.order[i];
        const ahead = s.pos[u] - s.pos[v];
        if (ahead < -2 || ahead > 28) continue;
        if (s.mergeUrge[u] < 0.35) continue;
        if (s.mergeDir[u] !== -dir) continue; // ska den hit, till min fil?
        const gap = s.pos[u] - s.length[u] - s.pos[v];
        if (gap < bestGap) {
          bestGap = gap;
          best = u;
        }
      }
    }
    return best;
  }

  private turnSpeed(turn: number): number {
    if (turn === Turn.Left || turn === Turn.Right) return 6.5;
    if (turn === Turn.Reverse) return 3.5;
    if (turn === Turn.SlightLeft || turn === Turn.SlightRight) return 10;
    return Infinity;
  }

  /**
   * Väljer svängrörelse enligt rutten och sätter fordonets önskade nästa länk.
   *
   * Går målet inte att nå från något körfält på länken — vilket händer vid
   * avstängningar och i nätets utkanter — tas närmaste framkomliga gren direkt,
   * med företräde för en som målet fortfarande går att nå ifrån. Att i stället
   * vänta gör bara att fordonet blir stående och proppar igen sitt körfält.
   */
  private chooseConnection(v: number, link: number, lane: number, distToLine: number): number {
    const s = this.s;
    const mv = this.mv;
    const cached = s.nextConn[v];
    if (cached >= 0 && mv.connFromLink[cached] === link && mv.connFromLane[cached] === lane) {
      return cached;
    }

    let want = s.wantLink[v];
    if (want < 0 || this.linkClosed[want]) {
      want = this.routeNext(v, link);
      s.wantLink[v] = want;
    }

    const b = mv.laneBase[link] + lane;
    const cs = mv.laneConnStart[b];
    const ce = mv.laneConnStart[b + 1];
    if (ce === cs) return -1;

    for (let k = cs; k < ce; k++) {
      if (mv.connToLink[mv.laneConn[k]] === want) {
        s.nextConn[v] = mv.laneConn[k];
        return mv.laneConn[k];
      }
    }

    // Rätt gren finns på länken men i ett annat körfält: ge filbytet en chans så
    // länge det finns sträcka kvar att göra det på. Fordonet ska normalt aldrig
    // hamna här — det väljer rätt fil redan när det kommer in på länken — och när
    // det ändå gör det är avståndet kort.
    if (want >= 0 && distToLine > 25 && s.forcing[v] === 0) {
      const lanes = this.linkLanes(link);
      for (let other = 0; other < lanes; other++) {
        if (other !== lane && this.laneServes(link, other, want)) return -1;
      }
    }

    const tree = this.routes.tree(s.destZone[v], s.driver[v]);
    let fallback = -1;
    for (let k = cs; k < ce; k++) {
      const c = mv.laneConn[k];
      const to = mv.connToLink[c];
      if (this.linkClosed[to]) continue;
      if (fallback < 0) fallback = c;
      // Föredra en gren som målet fortfarande går att nå ifrån.
      if (tree && tree[to] >= 0) {
        fallback = c;
        break;
      }
    }
    if (fallback < 0) return -1;
    s.nextConn[v] = fallback;
    s.wantLink[v] = mv.connToLink[fallback];
    return fallback;
  }

  /**
   * Söker en annan gren ut ur korsningen när den valda är full.
   *
   * Väljs bara efter en stunds väntan, och bara om målet fortfarande går att nå
   * den vägen — annars skulle fordon börja irra runt så fort det blev trögt.
   * Returnerar den nya rörelsen, eller -1 om ingen duger.
   */
  private divertFrom(v: number, link: number, lane: number, current: number): number {
    const s = this.s;
    if (s.waited[v] < DIVERT_WAIT) return -1;

    // Har det gått riktigt länge räcker det inte att välja en annan gren av samma
    // rutt — hela vägvalet behöver göras om från där bilen står. Det är vad en
    // förare med en navigator gör, och det är den enda utvägen när rutten leder
    // rakt in i något som står stilla.
    if (s.waited[v] > REPLAN_WAIT && this.time - this.lastReplan[v] > REPLAN_WAIT) {
      this.lastReplan[v] = this.time;
      s.pathLen[v] = 0;
      s.pathPos[v] = 0;
    }

    const mv = this.mv;
    const b = mv.laneBase[link] + lane;
    const tree = this.routes.tree(s.destZone[v], s.driver[v]);

    for (let k = mv.laneConnStart[b]; k < mv.laneConnStart[b + 1]; k++) {
      const c = mv.laneConn[k];
      if (c === current) continue;
      const to = mv.connToLink[c];
      if (this.linkClosed[to]) continue;
      // Vänd inte tillbaka dit man kom ifrån, och bara vägar som leder vidare.
      if (to === this.net.linkReverse[link]) continue;
      if (tree && tree[to] < 0) continue;
      if (!this.spaceAfter(c)) continue;
      if (mv.connYield[c] !== YieldKind.Major && !this.hasGap(v, c)) continue;

      s.nextConn[v] = c;
      s.wantLink[v] = to;
      return c;
    }
    return -1;
  }

  /** Luckacceptans: finns en tillräckligt stor lucka i de strömmar man väjer för? */
  private hasGap(v: number, conn: number): boolean {
    const s = this.s;
    const mv = this.mv;
    const net = this.net;

    let critical = this.config.giveWayGap;
    if (mv.connTurn[conn] === Turn.Left) critical = this.config.leftTurnGap;
    if (mv.connYield[conn] === YieldKind.Stop) critical = this.config.stopSignGap;
    if (net.nodeControl[mv.connNode[conn]] === NodeControl.Roundabout) {
      critical = this.config.roundaboutGap;
    }
    // Vid signal vet föraren att grönperioden är begränsad och tar mindre luckor.
    if (mv.connSignalGroup[conn] >= 0) critical *= 0.72;
    // Otålighet: den som väntat länge accepterar mindre luckor.
    critical *= Math.max(0.45, 1 - this.config.impatience * s.waited[v]);

    for (let k = mv.yieldToStart[conn]; k < mv.yieldToStart[conn + 1]; k++) {
      const other = mv.yieldTo[k];

      // Någon är redan inne i konfliktpunkten.
      const ob = mv.laneCount + other;
      const os = s.bucketStart[ob];
      const oe = s.bucketStart[ob + 1];
      for (let i = os; i < oe; i++) {
        if (s.pos[s.order[i]] < mv.connLength[other] * 0.9) return false;
      }

      // Rödljus på den motstående strömmen gör den ofarlig.
      const og = mv.connSignalGroup[other];
      if (og >= 0) {
        const st = this.signals.groupState[og];
        if (st === GroupState.Red || st === GroupState.RedAmber) continue;
      }

      const fl = mv.connFromLink[other];
      if (this.linkMicro[fl] === 0) continue; // mesolänk: ingen mikroskopisk lucka att mäta
      const lb = mv.laneBase[fl] + mv.connFromLane[other];
      const ls = s.bucketStart[lb];
      if (s.bucketStart[lb + 1] === ls) continue;

      const head = s.order[ls];
      const nc = s.nextConn[head];
      if (nc >= 0 && nc !== other) continue; // kör åt annat håll

      // Står den andra också still är det ingen lucka att vänta på, utan en
      // förhandling: den som stannade först kör först. Utan turordningen väjer
      // fyra tillfarter i en högerregelkorsning för varandra i all evighet, och
      // korsningen släpper bara igenom ett fordon per dödlägesventil.
      if (s.speed[head] < 0.7) {
        const weWaitedLonger =
          s.waited[v] > s.waited[head] || (s.waited[v] === s.waited[head] && v < head);
        if (weWaitedLonger) continue;
        return false;
      }

      const dist = mv.linkDriveLen[fl] - s.pos[head];
      if (dist > 120) continue;
      const arrival = dist / Math.max(s.speed[head], 1.5);
      if (arrival < critical) return false;
    }
    return true;
  }

  /** Plats på länken efter korsningen. */
  private spaceAfter(conn: number): boolean {
    const mv = this.mv;
    const s = this.s;
    const toLink = mv.connToLink[conn];
    if (this.linkMicro[toLink] === 0) return this.mesoHasRoom(toLink);

    const toLane = Math.min(mv.connToLane[conn], this.linkLanes(toLink) - 1);
    void s;
    // Den som redan är inne i korsningen på väg hit räknas som upptagen plats,
    // minus det här fordonet självt om det redan är på sin rörelse.
    return this.laneRoom(toLink, toLane, this.committedTo(toLink, toLane));
  }

  // --- Filbyten -------------------------------------------------------------------

  /**
   * Filbyten enligt MOBIL, med framförhållning och samverkan.
   *
   * Modellen väger tre saker mot varandra, precis som en förare gör: vinner jag
   * något på att byta, förlorar den bakom mig i målfilen på det, och måste jag
   * byta för att komma rätt i nästa korsning. Behovet växer ju närmare
   * korsningen man kommer, så positioneringen sker i god tid i stället för som
   * en panikmanöver vid stopplinjen.
   */
  private laneChanges(): void {
    const s = this.s;
    const mv = this.mv;
    const phase = this.frame & 3;
    this.claimed.clear();

    for (let b = 0; b < mv.laneCount; b++) {
      const start = s.bucketStart[b];
      const end = s.bucketStart[b + 1];
      if (end === start) continue;
      const link = this.laneLink[b];
      const lanes = this.linkLanes(link);
      const lane = this.laneIndex[b];
      if (lanes < 2 || lane >= lanes) continue;

      for (let i = start; i < end; i++) {
        const v = s.order[i];
        if ((v & 3) !== phase) continue;

        let want = s.wantLink[v];
        if (want < 0) {
          want = this.routeNext(v, link);
          s.wantLink[v] = want;
        }

        // Behovet: hur nära korsningen är jag, och leder filen dit jag ska?
        const serves = this.laneServes(link, lane, want);
        const distance = mv.linkDriveLen[link] - s.pos[v];
        const urgency = serves ? 0 : Math.min(1, Math.max(0.15, 1 - distance / LANE_LOOKAHEAD));
        const target = serves ? -1 : this.nearestServingLane(link, lane, want, lanes);
        s.mergeUrge[v] = urgency;
        s.mergeDir[v] = target < 0 ? 0 : Math.sign(target - lane);

        let bestDir = 0;
        let bestScore = LANE_CHANGE_THRESHOLD;
        for (const dir of [-1, 1] as const) {
          const other = lane + dir;
          if (other < 0 || other >= lanes) continue;
          const score = this.mobilScore(v, link, lane, other, want, serves, urgency, target);
          if (score > bestScore) {
            bestScore = score;
            bestDir = dir;
          }
        }
        if (bestDir === 0) continue;

        const to = lane + bestDir;
        // Nära korsningen tvingar sig den som måste in; annars gäller full lucka.
        const forced = !serves && distance < 60;
        if (!this.canChangeTo(v, link, to, forced)) continue;

        const bucket = mv.laneBase[link] + to;
        this.laneReset(bucket);
        if (s.bucketStart[bucket + 1] - s.bucketStart[bucket] + this.laneAdded[bucket] >=
            this.laneCapacity(link)) {
          continue;
        }
        if (!this.claimSlot(bucket, s.pos[v], s.length[v])) continue;
        this.laneAdded[bucket]++;

        s.lateral[v] = -bestDir * this.net.linkLaneWidth[link];
        s.lane[v] = to;
        s.nextConn[v] = -1;
        s.mergeUrge[v] = 0;
        s.mergeDir[v] = 0;
      }
    }
  }

  /**
   * MOBIL-nyttan av att byta till en given fil, i m/s².
   *
   * Positivt värde betyder att bytet är värt att göra. Hövligheten avgör hur
   * mycket den bakomvarandes förlust väger — noll ger en hänsynslös förare som
   * alltid tar luckan, ett ger en som aldrig tränger sig.
   */
  private mobilScore(
    v: number, link: number, from: number, to: number, want: number,
    serves: boolean, urgency: number, target: number,
  ): number {
    const s = this.s;
    const c = this.config;

    const here = this.neighbours(link, from, s.pos[v], v);
    const there = this.neighbours(link, to, s.pos[v], v);

    // Kan bytet göras utan att tvinga någon till nödbromsning?
    if (there.follower >= 0) {
      const after = this.idmBetween(there.follower, v);
      if (after < -SAFE_DECEL) return -Infinity;
    }

    const mineNow = this.idmBetween(v, here.leader);
    const mineThen = this.idmBetween(v, there.leader);
    let score = mineThen - mineNow;

    // Hövlighet: väg in vad de bakomvarande förlorar respektive vinner.
    if (c.politeness > 0) {
      let others = 0;
      if (there.follower >= 0) {
        others += this.idmBetween(there.follower, v) - this.idmBetween(there.follower, there.leader);
      }
      if (here.follower >= 0) {
        others += this.idmBetween(here.follower, here.leader) - this.idmBetween(here.follower, v);
      }
      score += c.politeness * others;
    }

    // Behovet av att komma i rätt fil väger tyngre ju närmare korsningen man är.
    if (!serves && target >= 0) {
      const towards = Math.sign(target - from) === Math.sign(to - from);
      score += towards ? 6 * urgency : -6 * urgency;
    } else if (serves && !this.laneServes(link, to, want)) {
      // Lämna inte en fil som leder rätt för en som inte gör det.
      score -= 4;
    }

    // Håll till höger när det går; vänsterfilen är till för omkörning.
    if (to < from) score += KEEP_RIGHT_BIAS;
    return score;
  }

  /** Fordonet närmast framför och bakom en position i ett givet körfält. */
  private neighbours(
    link: number, lane: number, pos: number, self: number,
  ): { leader: number; follower: number } {
    const s = this.s;
    const b = this.mv.laneBase[link] + lane;
    const start = s.bucketStart[b];
    const end = s.bucketStart[b + 1];
    // Hinken är sorterad fallande efter position.
    let lo = start;
    let hi = end;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.pos[s.order[mid]] > pos) lo = mid + 1;
      else hi = mid;
    }
    let leader = -1;
    for (let i = lo - 1; i >= start; i--) {
      if (s.order[i] !== self) {
        leader = s.order[i];
        break;
      }
    }
    let follower = -1;
    for (let i = lo; i < end; i++) {
      if (s.order[i] !== self) {
        follower = s.order[i];
        break;
      }
    }
    return { leader, follower };
  }

  /** IDM-acceleration för `v` med `leader` framför sig, -1 = fri väg. */
  private idmBetween(v: number, leader: number): number {
    if (v < 0) return 0;
    if (leader < 0) return this.idm(v, Infinity, 0);
    const s = this.s;
    const gap = s.pos[leader] - s.length[leader] - s.pos[v];
    return this.idm(v, gap, s.speed[leader]);
  }

  /**
   * Vilket körfält fordonet ska in i när det kommer ut på en ny länk.
   *
   * Riktig trafik sorterar sig i god tid: den som ska svänga av ligger redan i
   * rätt fil när avfarten kommer. Väljs filen bara efter var fordonet råkade
   * komma ut ur korsningen får det i stället upptäcka vid stopplinjen att det
   * står fel, och tvingas stanna och vänta på en lucka — mitt i vägen, med hela
   * kön bakom sig. Det är den inbromsningen som syns vid varje av- och påfart.
   *
   * `preferred` är filen svängrörelsen mynnar i. Den behålls om den duger.
   */
  private entryLane(v: number, link: number, preferred: number): number {
    const lanes = this.linkLanes(link);
    const want = this.routeNext(v, link);
    const start = Math.min(preferred, lanes - 1);
    if (want < 0 || this.laneServes(link, start, want)) {
      return this.freeLaneNear(link, start, v);
    }
    // Sök utåt från den fil rörelsen mynnar i, så bytet blir så litet som möjligt.
    for (let d = 1; d < lanes; d++) {
      for (const cand of [start - d, start + d]) {
        if (cand < 0 || cand >= lanes) continue;
        if (!this.laneServes(link, cand, want)) continue;
        if (this.laneRoom(link, cand)) return cand;
      }
    }
    return this.freeLaneNear(link, start, v);
  }

  /** Närmaste körfält med plats, räknat från ett önskat fält. */
  private freeLaneNear(link: number, preferred: number, v: number): number {
    const lanes = this.linkLanes(link);
    const start = Math.min(Math.max(preferred, 0), lanes - 1);
    if (this.laneRoom(link, start)) return start;
    for (let d = 1; d < lanes; d++) {
      for (const cand of [start - d, start + d]) {
        if (cand >= 0 && cand < lanes && this.laneRoom(link, cand)) return cand;
      }
    }
    void v;
    return start;
  }

  /** Leder körfältet till den gren fordonet ska ta? */
  private laneServes(link: number, lane: number, want: number): boolean {
    if (want < 0) return true;
    const mv = this.mv;
    const b = mv.laneBase[link] + lane;
    for (let k = mv.laneConnStart[b]; k < mv.laneConnStart[b + 1]; k++) {
      if (mv.connToLink[mv.laneConn[k]] === want) return true;
    }
    return false;
  }

  /** Närmaste körfält som leder rätt, eller -1. */
  private nearestServingLane(link: number, lane: number, want: number, lanes: number): number {
    for (let d = 1; d < lanes; d++) {
      if (lane - d >= 0 && this.laneServes(link, lane - d, want)) return lane - d;
      if (lane + d < lanes && this.laneServes(link, lane + d, want)) return lane + d;
    }
    return -1;
  }

  /**
   * Bokar en position i ett körfält under pågående tidssteg.
   *
   * Hinkarna uppdateras först vid nästa sortering, så två fordon som byter fil
   * samtidigt ser båda samma lediga lucka utan den här bokningen.
   */
  private claimSlot(bucket: number, pos: number, length: number): boolean {
    let list = this.claimed.get(bucket);
    if (!list) this.claimed.set(bucket, (list = []));
    const need = length + this.config.minGap;
    for (const p of list) if (Math.abs(p - pos) < need) return false;
    list.push(pos);
    return true;
  }

  /** Säkerhetskontroll: finns lucka framför och bakom i målfilen? */
  private canChangeTo(v: number, link: number, toLane: number, urgent: boolean): boolean {
    const s = this.s;
    const b = this.mv.laneBase[link] + toLane;
    const start = s.bucketStart[b];
    const end = s.bucketStart[b + 1];
    const p = s.pos[v];
    const minFront = urgent ? 2 : this.config.minGap + s.speed[v] * 0.5;

    // Hinken är sorterad fallande — binärsök till första fordon bakom oss.
    let lo = start;
    let hi = end;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.pos[s.order[mid]] > p) lo = mid + 1;
      else hi = mid;
    }

    if (lo > start) {
      const lead = s.order[lo - 1];
      if (s.pos[lead] - s.length[lead] - p < minFront) return false;
    }
    if (lo < end) {
      const follow = s.order[lo];
      const gap = p - s.length[v] - s.pos[follow];
      if (gap < (urgent ? 1 : this.config.minGap)) return false;
      // Skulle den bakomvarande behöva nödbromsa blir bytet inte av.
      const dv = s.speed[follow] - s.speed[v];
      if (dv > 0 && (dv * dv) / (2 * Math.max(gap, 0.5)) > SAFE_DECEL) return false;
    }
    return true;
  }

  // --- Integration och överföring --------------------------------------------------

  private integrate(dt: number): void {
    const s = this.s;
    for (let i = 0; i < s.orderCount; i++) {
      const v = s.order[i];
      const vc = VEHICLE_CLASSES[s.type[v]];
      // Begränsa inbromsningen till vad däcken klarar; IDM kan annars ge extremvärden.
      const a = Math.max(-9, Math.min(s.accel[v], vc.accel));
      const before = s.speed[v];
      let speed = before + a * dt;
      if (speed < 0) speed = 0;
      s.speed[v] = speed;
      const moved = ((before + speed) / 2) * dt;
      s.pos[v] += moved;
      s.distance[v] += moved;

      if (speed < 0.5) {
        if (before >= 0.5) s.stops[v]++;
        s.waited[v] += dt;
      } else {
        s.waited[v] = 0;
        s.dwell[v] = 0;
      }
      // Fördröjning = skillnaden mot att ha kört i önskad hastighet.
      s.delay[v] += dt * Math.max(0, 1 - speed / s.desired[v]);
      // Släpp tillbaka sidoförskjutningen efter ett filbyte.
      if (s.lateral[v] !== 0) {
        const decay = Math.max(0, 1 - dt * 1.6);
        s.lateral[v] = Math.abs(s.lateral[v]) < 0.05 ? 0 : s.lateral[v] * decay;
      }
    }
  }

  /**
   * Löser upp fordon som hamnat ovanpå varandra.
   *
   * Filbyten, tvingade infarter och överföringar mellan modellerna kan i sällsynta
   * fall lägga två fordon på samma punkt. Bilföljningsmodellen har ingen väg ut ur
   * det läget — båda bromsar maximalt för varandra och blir stående för alltid —
   * så överlappet rättas här genom att det bakre fordonet skjuts tillbaka till
   * rätt avstånd. Det är en korrigering av ett fysiskt omöjligt tillstånd, inte en
   * del av trafikmodellen, och den ska normalt aldrig behöva göra något.
   */
  private separate(): void {
    const s = this.s;
    const mv = this.mv;
    for (let b = 0; b < mv.laneCount; b++) {
      const start = s.bucketStart[b];
      const end = s.bucketStart[b + 1];
      for (let i = start + 1; i < end; i++) {
        const lead = s.order[i - 1];
        const v = s.order[i];
        const limit = s.pos[lead] - s.length[lead];
        if (s.pos[v] > limit) {
          s.pos[v] = Math.max(0, limit);
          if (s.speed[v] > s.speed[lead]) s.speed[v] = s.speed[lead];
        }
      }
    }
  }

  private transfer(): void {
    const s = this.s;
    const mv = this.mv;

    for (let i = 0; i < s.orderCount; i++) {
      const v = s.order[i];

      if (s.state[v] === VState.Micro) {
        const link = s.link[v];
        const driveLen = mv.linkDriveLen[link];
        if (s.pos[v] < driveLen) continue;

        if (link === s.destLink[v]) {
          this.recordLinkExit(v, link);
          this.finishTrip(v);
          continue;
        }
        const conn = s.nextConn[v];
        if (conn < 0) {
          // Körfältet saknar utgående rörelser helt (avskuret i grunddatan).
          // Fordonet kan omöjligt komma vidare; det plockas bort och räknas.
          if (s.waited[v] > DEADLOCK_TIME) {
            this.lost++;
            s.release(v);
            continue;
          }
          s.pos[v] = driveLen;
          s.speed[v] = Math.min(s.speed[v], 1);
          continue;
        }
        this.recordLinkExit(v, link);
        const group = mv.connSignalGroup[conn];
        if (group >= 0) this.groupCount[group]++;

        s.state[v] = VState.OnConn;
        s.conn[v] = conn;
        s.pos[v] -= driveLen;
        s.link[v] = -1;
      } else if (s.state[v] === VState.OnConn) {
        const conn = s.conn[v];
        if (s.pos[v] < mv.connLength[conn]) continue;

        const toLink = mv.connToLink[conn];
        s.pos[v] -= mv.connLength[conn];
        s.conn[v] = -1;
        s.nextConn[v] = -1;
        s.wantLink[v] = -1;
        s.linkEnterTime[v] = this.time;
        // Stega fram i den planerade rutten om fordonet gick dit den pekade.
        const base = v * PATH_SLOT;
        if (s.pathPos[v] + 1 < s.pathLen[v] && s.pathPool[base + s.pathPos[v] + 1] === toLink) {
          s.pathPos[v]++;
        }
        s.desired[v] = this.desiredSpeed(v, toLink);

        if (toLink === s.destLink[v]) {
          this.finishTrip(v);
          continue;
        }
        // Beslutet att tvinga sig fram gäller tills hela korsningen är passerad.
        const forced = s.forcing[v] === 1;
        if (this.linkMicro[toLink] === 1) {
          const lane = this.entryLane(v, toLink, mv.connToLane[conn]);
          if (!this.laneRoom(toLink, lane, 0, forced)) {
            // Kön har vuxit tillbaka in i korsningen. Här är det ingen dödlägesventil
            // som ska öppnas — fordonet ryms fysiskt inte, och blir stående i
            // korsningen precis som en riktig bil hade blivit.
            s.pos[v] = mv.connLength[conn];
            s.speed[v] = 0;
            s.conn[v] = conn;
            s.nextConn[v] = -1;
            continue;
          }
          this.laneTake(toLink, lane, 0, s.length[v]);
          s.forcing[v] = 0;
          s.state[v] = VState.Micro;
          s.link[v] = toLink;
          s.lane[v] = lane;
        } else {
          s.forcing[v] = 0;
          this.enterMeso(v, toLink);
        }
      }
    }
  }

  private recordLinkExit(v: number, link: number): void {
    const s = this.s;
    this.linkExits[link] += 1;
    const travel = this.time - s.linkEnterTime[v];
    const freeTime = this.mv.linkDriveLen[link] / this.linkSpeed(link);
    this.stats.delay[link] += Math.max(0, travel - freeTime);

    const km = this.mv.linkDriveLen[link] / 1000;
    this.stats.vehKm[link] += km;
    const kmh = Math.max(4, (this.mv.linkDriveLen[link] / Math.max(travel, 0.1)) * 3.6);
    this.stats.co2[link] += km * this.co2PerKm(v, kmh);
  }

  /**
   * Utsläpp per kilometer som funktion av medelhastigheten. Kurvan följer formen i
   * HBEFA: högst vid krypkörning, lägst kring 60–70 km/h, uppåt igen i hög fart.
   */
  private co2PerKm(v: number, kmh: number): number {
    const base = VEHICLE_CLASSES[this.s.type[v]].co2Base;
    const shape = (0.62 + 9.5 / kmh + 0.00006 * kmh * kmh) / 1.02;
    return base * shape;
  }

  private finishTrip(v: number): void {
    const s = this.s;
    this.completed++;
    this.tripTimeSum += this.time - s.enterTime[v];
    this.tripDelaySum += s.delay[v];
    s.release(v);
  }

  // --- Fokusområde ----------------------------------------------------------------

  /**
   * Bestämmer var mikromodellen används. Länkar utanför körs meso, vilket är det
   * som gör hela tätorten möjlig att simulera samtidigt som det man tittar på
   * återges fordon för fordon.
   */
  setFocus(x: number, y: number, radius: number): void {
    const net = this.net;
    const r2 = radius * radius;
    let micro = 0;
    for (let l = 0; l < net.linkCount; l++) {
      const g = net.linkGeomStart[l];
      const e = net.linkGeomStart[l + 1] - 1;
      const mx = (net.geomX[g] + net.geomX[e]) / 2;
      const my = (net.geomY[g] + net.geomY[e]) / 2;
      const inside = (mx - x) ** 2 + (my - y) ** 2 <= r2;
      this.linkMicro[l] = inside ? 1 : 0;
      if (inside) micro++;
    }
    this.microLinkCount = micro;
  }

  /** Kör hela nätet mikroskopiskt — tyngre men exakt. */
  setFullMicro(): void {
    this.linkMicro.fill(1);
    this.microLinkCount = this.net.linkCount;
  }

  private microLinkCount: number;

  // --- Scenarioändringar -----------------------------------------------------------

  closeLink(link: number, closed: boolean): void {
    this.linkClosed[link] = closed ? 1 : 0;
    const rev = this.net.linkReverse[link];
    if (rev >= 0) this.linkClosed[rev] = closed ? 1 : 0;
    // Kostnaden görs oöverkomlig så ruttträden väljer bort länken vid nästa omräkning.
    this.updateTravelTimes();
    this.invalidateRoutes();
  }

  setLanes(link: number, lanes: number): void {
    this.laneOverride[link] = Math.max(1, Math.min(8, lanes));
    this.invalidateRoutes();
  }

  setSpeedLimit(link: number, kmh: number): void {
    this.speedOverride[link] = kmh > 0 ? kmh / 3.6 : 0;
    this.updateTravelTimes();
    this.invalidateRoutes();
  }

  private invalidateRoutes(): void {
    this.routes.setDestinations(this.demand.zones.map((z) => z.destAnchors));
  }

  /** Matar tillbaka uppmätta restider till ruttvalet. */
  private updateTravelTimes(): void {
    const net = this.net;
    for (let l = 0; l < net.linkCount; l++) {
      if (this.linkClosed[l]) {
        this.routes.linkTime[l] = 1e6;
        continue;
      }
      const free = this.mv.linkDriveLen[l] / this.linkSpeed(l);
      // En tom länk kostar fri restid. En länk med trafik kostar den uppmätta —
      // och står trafiken helt still måste den kosta mycket, inte falla tillbaka
      // på fri hastighet. Annars ser den värsta kön ut som den snabbaste vägen
      // och trafiken fortsätter söka sig rakt in i proppen.
      if (this.stats.vehicles[l] < 0.5) {
        this.routes.linkTime[l] = free;
        continue;
      }
      const observed = Math.max(this.stats.speed[l], this.linkSpeed(l) * 0.08);
      this.routes.linkTime[l] = Math.min(free * 12, this.mv.linkDriveLen[l] / observed);
    }
    for (let g = 0; g < this.signals.groupCount; g++) {
      const ctrl = this.signals.controllers[this.signals.groupCtrl[g]];
      if (!ctrl) continue;
      let cycle = 0;
      let green = 0;
      for (const p of ctrl.phases) {
        cycle += p.green + p.amber + p.allRed + 1;
        if (p.groups.includes(g)) green += p.green;
      }
      // Genomsnittlig väntetid vid jämn ankomst.
      this.routes.signalDelay[g] = cycle > 0 ? ((cycle - green) ** 2 / (2 * cycle)) : 10;
    }
  }

  // --- Statistik -------------------------------------------------------------------

  private updateStats(dt: number): void {
    const s = this.s;
    const st = this.stats;
    st.vehicles.fill(0);
    st.queue.fill(0);

    const sumSpeed = this.speedAccum;
    sumSpeed.fill(0);

    for (let v = 0; v < s.capacity; v++) {
      const state = s.state[v];
      if (state === VState.Micro) {
        const l = s.link[v];
        st.vehicles[l]++;
        sumSpeed[l] += s.speed[v];
        if (s.speed[v] < 1) st.queue[l]++;
      } else if (state === VState.Meso) {
        const l = s.link[v];
        st.vehicles[l]++;
        sumSpeed[l] += s.speed[v];
      }
    }

    // Exponentiell utjämning: momentanvärden hoppar för mycket för att visas direkt.
    const alpha = Math.min(1, dt / 25);
    for (let l = 0; l < this.net.linkCount; l++) {
      const n = st.vehicles[l];
      const mean = n > 0 ? sumSpeed[l] / n : this.linkSpeed(l);
      st.speed[l] += (mean - st.speed[l]) * alpha;
    }

    this.statWindow += dt;
    if (this.statWindow >= 30) {
      const perHour = 3600 / this.statWindow;
      for (let l = 0; l < this.net.linkCount; l++) {
        const flow = this.linkExits[l] * perHour;
        st.flow[l] += (flow - st.flow[l]) * 0.5;
        const byFlow = st.flow[l] / (this.net.linkCapacity[l] * this.linkLanes(l));
        const storage = (this.mv.linkDriveLen[l] / 1000) * JAM_DENSITY * this.linkLanes(l);
        const byOccupancy = st.vehicles[l] / Math.max(storage, 1);
        st.saturation[l] = Math.max(byFlow, byOccupancy);
      }
      for (let g = 0; g < this.signals.groupCount; g++) {
        this.groupFlow[g] = this.groupCount[g] * perHour;
      }
      this.groupCount.fill(0);
      this.linkExits.fill(0);
      this.statWindow = 0;
      this.updateTravelTimes();
    }
  }

  private speedAccum = new Float32Array(0);

  networkStats(): NetworkStats {
    const s = this.s;
    let speedSum = 0;
    let moving = 0;
    let delaySum = 0;
    let vehKm = 0;
    let co2 = 0;
    for (let v = 0; v < s.capacity; v++) {
      if (s.state[v] === VState.Pending) continue;
      speedSum += s.speed[v];
      moving++;
      delaySum += s.delay[v];
    }
    for (let l = 0; l < this.net.linkCount; l++) {
      vehKm += this.stats.vehKm[l];
      co2 += this.stats.co2[l];
    }
    return {
      time: this.time,
      hour: (this.time / 3600) % 24,
      active: s.count,
      completed: this.completed,
      meanTripTime: this.completed > 0 ? this.tripTimeSum / this.completed : 0,
      meanTripDelay: this.completed > 0 ? this.tripDelaySum / this.completed : 0,
      meanSpeed: moving > 0 ? speedSum / moving : 0,
      totalDelayHours: (delaySum + this.tripDelaySum) / 3600,
      vehKm,
      co2Tonnes: co2 / 1e6,
      blockedSpawns: this.blockedSpawns,
      lost: this.lost,
      microLinks: this.microLinkCount,
      spawnRate: this.currentDemand(),
    };
  }

  /** Länkar rangordnade efter hur mycket fördröjning de skapar. */
  bottlenecks(limit = 20): { link: number; delayHours: number; saturation: number; queue: number }[] {
    const out: { link: number; delayHours: number; saturation: number; queue: number }[] = [];
    for (let l = 0; l < this.net.linkCount; l++) {
      const d = this.stats.delay[l];
      if (d < 60) continue;
      out.push({
        link: l,
        delayHours: d / 3600,
        saturation: this.stats.saturation[l],
        queue: this.stats.queue[l],
      });
    }
    out.sort((a, b) => b.delayHours - a.delayHours);
    return out.slice(0, limit);
  }

  // --- Huvudsteg -------------------------------------------------------------------

  step(dt = this.config.dt): void {
    if (this.speedAccum.length !== this.net.linkCount) {
      this.speedAccum = new Float32Array(this.net.linkCount);
    }
    this.frame++;
    this.time += dt;

    stepSignals(this.signals, dt);
    // Sorteringen måste ligga före insläppet: annars placeras nya fordon utifrån
    // förra stegets körfältsinnehåll och kan hamna ovanpå varandra.
    this.s.sortBuckets(this.bucketOf);
    this.spawn(dt);
    this.stepMicro(dt);
    this.stepMeso(dt);
    this.updateStats(dt);

    // Fördela omräkningen jämnt över tiden istället för i skov: så många träd per
    // steg som krävs för att hinna igenom hela uppsättningen på rerouteCycle.
    this.rerouteBudget += (dt * this.routes.cachedCount) / Math.max(30, this.config.rerouteCycle);
    while (this.rerouteBudget >= 1) {
      this.rerouteBudget -= 1;
      if (!this.routes.refreshOne()) break;
    }
  }

  /**
   * Följer fordonets valda väg framåt och samlar den som en punktkedja.
   *
   * Vägen är inte lagrad någonstans — den framgår av ruttträdet, länk för länk —
   * så den byggs upp här när någon frågar. Det räcker gott: frågan kommer när en
   * användare klickat på en bil, inte i varje tidssteg.
   */
  routeAhead(v: number, maxLinks = 220): { points: Float32Array; metres: number } {
    const s = this.s;
    const pts: number[] = [];
    const pose = { x: 0, y: 0, heading: 0 };
    if (this.vehiclePose(v, pose)) pts.push(pose.x, pose.y);

    let link = s.state[v] === VState.OnConn ? this.mv.connToLink[s.conn[v]] : s.link[v];
    let metres = 0;
    const seen = new Set<number>();
    for (let step = 0; step < maxLinks && link >= 0; step++) {
      if (seen.has(link)) break;
      seen.add(link);
      const start = this.net.linkGeomStart[link];
      const end = this.net.linkGeomStart[link + 1];
      // På den länk fordonet redan står på ska linjen börja vid fordonet.
      // Ritas hela länken ut viker rutten först bakåt till gatans början och
      // sedan fram igen, vilket ser ut som en felaktig omväg.
      let from = start;
      if (step === 0 && s.state[v] !== VState.OnConn && link === s.link[v]) {
        const along = this.mv.linkStartOff[link] + s.pos[v];
        while (from < end - 1 && this.net.geomCum[from + 1] < along) from++;
        metres -= Math.min(s.pos[v], this.mv.linkDriveLen[link]);
      }
      for (let k = from; k < end; k++) pts.push(this.net.geomX[k], this.net.geomY[k]);
      metres += this.mv.linkDriveLen[link];
      if (link === s.destLink[v]) break;
      const next = this.routeNext(v, link);
      if (next === link || next < 0) break;
      link = next;
    }
    return { points: Float32Array.from(pts), metres };
  }

  /** Tömmer nätet på fordon och nollställer mätvärdena. */
  reset(): void {
    const s = this.s;
    for (let v = 0; v < s.capacity; v++) {
      if (s.state[v] !== VState.Pending) s.release(v);
    }
    s.orderCount = 0;
    this.mesoLoad.fill(0);
    this.mesoTokens.fill(0);
    this.completed = 0;
    this.lost = 0;
    this.blockedSpawns = 0;
    this.tripTimeSum = 0;
    this.tripDelaySum = 0;
    for (const field of Object.values(this.stats)) {
      if (field instanceof Float32Array) field.fill(0);
    }
    this.linkExits.fill(0);
  }

  /** Flyttar klockan. Sekunder sedan midnatt. */
  setTime(seconds: number): void {
    this.time = seconds;
    this.spawnCarry = 0;
  }

  /** Position och riktning för ett fordon, för renderingen. */
  vehiclePose(v: number, out: { x: number; y: number; heading: number }): boolean {
    const s = this.s;
    const state = s.state[v];
    if (state === VState.Micro) {
      const link = s.link[v];
      const lat = laneOffset(this.net, link, s.lane[v]) + s.lateral[v];
      posOnLink(this.net, link, this.mv.linkStartOff[link] + s.pos[v], lat, out);
      return true;
    }
    if (state === VState.OnConn) {
      posOnConn(this.mv, s.conn[v], s.pos[v], out);
      return true;
    }
    if (state === VState.Meso) {
      const link = s.link[v];
      const span = Math.max(0.1, s.mesoExit[v] - s.mesoEnter[v]);
      const t = Math.min(1, Math.max(0, (this.time - s.mesoEnter[v]) / span));
      const lat = laneOffset(this.net, link, 0);
      posOnLink(this.net, link, this.mv.linkStartOff[link] + t * this.mv.linkDriveLen[link], lat, out);
      return true;
    }
    return false;
  }
}
