/**
 * Ruttval.
 *
 * Istället för en A*-sökning per fordon byggs ett kortaste-väg-träd per målzon,
 * baklänges över länkgrafen. Ett fordon slår då upp nästa länk i O(1) — vilket är
 * det som gör 100 000 fordon möjligt. Träden räknas om löpande med uppmätta
 * restider, så köer får trafiken att söka sig till andra vägar precis som i
 * verkligheten (dynamisk nätutläggning).
 *
 * Kostnaden ligger på länken plus ett svängstraff, eftersom en vänstersväng över
 * mötande trafik i praktiken kostar mer än de meter den är lång.
 */

import { Turn } from '../osm/tags.ts';
import { NodeControl } from '../osm/tags.ts';
import type { RoadNetwork } from '../osm/network.ts';
import { YieldKind, type Movements } from './intersections.ts';

export interface RoutingOptions {
  /** Spridning i ruttval mellan förarklasser, som andel av kostnaden. */
  heterogeneity: number;
  /** Antal förarklasser med egna träd. */
  classes: number;
  /** Högsta antal träd i minnet innan de minst använda kastas. */
  treeCache: number;
  /**
   * Skalfaktor på hierarkimotståndet. Förare väljer inte enbart snabbaste väg —
   * de håller sig till det stora vägnätet även när en smitväg ser kortare ut.
   * 1,0 ger det motstånd som HIERARCHY_COST anger; 0 gör ruttvalet till ren
   * restidsminimering och lägger ut genomfartstrafik i bostadsgatorna.
   */
  localPenalty: number;
}

export const DEFAULT_ROUTING: RoutingOptions = {
  heterogeneity: 0.11,
  classes: 4,
  treeCache: 320,
  localPenalty: 1,
};

/**
 * Fast fördröjning i sekunder för en svängrörelse, utöver körsträckan.
 *
 * Grundkostnaden finns där även för att köra rakt fram: varje korsning kostar
 * inbromsning, uppmärksamhet och en viss risk att behöva stanna. Utan den ser en
 * väg genom tjugo små gatukorsningar lika billig ut som en led med fyra, och
 * modellen skickar genomfartstrafik rakt in i bostadsgatorna — vilket varken
 * stämmer med hur folk kör eller med vad gatorna klarar.
 */
export function turnPenalty(
  net: RoadNetwork,
  mv: Movements,
  conn: number,
  signalDelay: Float32Array | null,
): number {
  const node = mv.connNode[conn];
  const grenar =
    net.nodeInStart[node + 1] - net.nodeInStart[node] +
    net.nodeOutStart[node + 1] - net.nodeOutStart[node];
  let p = grenar > 2 ? 2.5 : 0;
  const turn = mv.connTurn[conn];
  if (turn === Turn.Left) p += 4;
  else if (turn === Turn.Right || turn === Turn.SlightRight) p += 1.5;
  else if (turn === Turn.Reverse) p += 15;

  const group = mv.connSignalGroup[conn];
  if (group >= 0) {
    p += signalDelay ? signalDelay[group] : 12;
  } else if (mv.connYield[conn] === YieldKind.Stop) {
    p += 6;
  } else if (mv.connYield[conn] === YieldKind.Give) {
    p += 3;
  }
  if (net.nodeControl[node] === NodeControl.Roundabout) p += 2;
  return p;
}

/**
 * Motstånd i sekunder per kilometer, per vägklass. Skillnaden mellan klasserna
 * är det som gör att trafiken samlas på huvudstråken i stället för att spridas
 * jämnt över hela gatunätet — utan den lägger modellen ut lika mycket trafik på
 * en villagata som på infartsleden bredvid.
 */
const HIERARCHY_COST = [0, 0, 0, 1, 4, 14, 35, 90, 55];

/**
 * Hur mycket varje förarklass avviker från den snabbaste vägen.
 *
 * De flesta kör den väg som faktiskt är snabbast, men långt ifrån alla: man kör
 * den väg man är van vid, den man tror är snabbare, eller den man tycker är
 * trevligare. Klass 0 tar alltid den snabbaste vägen, de mellersta avviker något
 * och den sista kör påtagligt annorlunda. Utan spridningen lägger sig all trafik
 * i exakt samma stråk och nätet får orealistiskt skarpa flödessprång.
 */
// Avvikelsen är måttlig med flit. Verkliga förare avviker några procent från den
// snabbaste vägen, inte tiotals — den som kör en halvtimme extra för vanans skull
// finns knappt. Sätts spridningen för högt sprids trafiken tunt över alla
// parallellgator i stället för att samlas på huvudstråken där den hör hemma.
const CLASS_SPREAD = [0, 0.4, 0.85, 1.6];

/** Andel av förarna i varje klass; summan är 1. */
export const DRIVER_MIX = [0.42, 0.28, 0.2, 0.1];

/**
 * Deterministiskt brus per (länk, förarklass). Gör att alla inte väljer exakt
 * samma väg, vilket annars ger orealistiskt skarpa flödessprång i nätet.
 */
function classNoise(link: number, cls: number): number {
  let h = (link * 2654435761 + cls * 40503) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 8) / 16777216 - 0.5; // [-0.5, 0.5)
}

export class RouteTrees {
  private readonly net: RoadNetwork;
  private readonly mv: Movements;
  private readonly opts: RoutingOptions;
  /** Bakåtgrannar: för varje länk, rörelserna som leder in i den. */
  private readonly inConnStart: Int32Array;
  private readonly inConn: Int32Array;

  /** nextLink per (mål, klass). Nyckel = dest * classes + class. */
  /**
   * Träden är dyra i minne (ett heltal per länk och mål), så bara de senast
   * använda behålls. Sedan fordonen planerar sin rutt en gång vid avfärd behövs
   * de bara vid avfärd och omplanering, och ett tak på ett par hundra räcker gott.
   */
  private readonly trees = new Map<number, Int32Array>();
  private readonly builtAt = new Map<number, number>();
  private clock = 0;
  /** Målens ankarlänkar, satta av demandmodellen. */
  private destLinks: Int32Array[] = [];

  /** Aktuell restid per länk, m/s-baserad; uppdateras av simuleringen. */
  readonly linkTime: Float32Array;
  /** Aktuell signalfördröjning per signalgrupp. */
  readonly signalDelay: Float32Array;

  private rebuildCursor = 0;
  private rebuildOrder: number[] = [];

  constructor(net: RoadNetwork, mv: Movements, signalGroups: number, opts = DEFAULT_ROUTING) {
    this.net = net;
    this.mv = mv;
    this.opts = opts;

    const counts = new Int32Array(net.linkCount + 1);
    for (let c = 0; c < mv.connCount; c++) counts[mv.connToLink[c] + 1]++;
    for (let i = 0; i < net.linkCount; i++) counts[i + 1] += counts[i];
    this.inConnStart = counts;
    this.inConn = new Int32Array(mv.connCount);
    const cursor = counts.slice();
    for (let c = 0; c < mv.connCount; c++) this.inConn[cursor[mv.connToLink[c]]++] = c;

    this.linkTime = new Float32Array(net.linkCount);
    for (let l = 0; l < net.linkCount; l++) {
      this.linkTime[l] = mv.linkDriveLen[l] / Math.max(net.linkSpeed[l], 1);
    }
    this.signalDelay = new Float32Array(signalGroups).fill(12);
  }

  setDestinations(destLinks: Int32Array[]): void {
    this.destLinks = destLinks;
    this.trees.clear();
    this.builtAt.clear();
  }

  get destCount(): number {
    return this.destLinks.length;
  }

  get classCount(): number {
    return this.opts.classes;
  }

  /** Antal träd som faktiskt används just nu — omräkningstakten skalas mot det. */
  get cachedCount(): number {
    return this.trees.size;
  }

  /** Träd för ett mål och en förarklass; byggs vid första behov. */
  tree(dest: number, cls: number): Int32Array | null {
    if (dest < 0 || dest >= this.destLinks.length) return null;
    const key = dest * this.opts.classes + cls;
    let t = this.trees.get(key);
    if (!t) {
      t = this.build(dest, cls);
      this.trees.set(key, t);
      this.evictOldest();
    }
    this.builtAt.set(key, ++this.clock);
    return t;
  }

  private evictOldest(): void {
    while (this.trees.size > this.opts.treeCache) {
      let oldest = -1;
      let oldestAt = Infinity;
      for (const [key, at] of this.builtAt) {
        if (at < oldestAt) {
          oldestAt = at;
          oldest = key;
        }
      }
      if (oldest < 0) break;
      this.trees.delete(oldest);
      this.builtAt.delete(oldest);
    }
  }

  /**
   * Räknar om ett träd i taget med aktuella restider. Anropas några gånger per
   * sekund av simuleringen — kön i nätet slår då igenom i ruttvalet gradvis
   * istället för att alla fordon byter väg samtidigt.
   */
  refreshOne(): boolean {
    if (this.trees.size === 0) return false;
    if (this.rebuildCursor >= this.rebuildOrder.length) {
      this.rebuildOrder = [...this.trees.keys()];
      this.rebuildCursor = 0;
    }
    const key = this.rebuildOrder[this.rebuildCursor++];
    if (!this.trees.has(key)) return true;
    const dest = Math.floor(key / this.opts.classes);
    const cls = key % this.opts.classes;
    this.trees.set(key, this.build(dest, cls));
    return true;
  }

  /** Länkkostnad i sekunder för en given förarklass. */
  private linkCost(link: number, cls: number): number {
    const base = this.linkTime[link];
    const spread = this.opts.heterogeneity * (CLASS_SPREAD[cls] ?? 1);
    const noise = 1 + spread * 2 * classNoise(link, cls);
    // Smitvägsmotstånd: lokalgator och angöringsvägar undviks som genomfart.
    const rate = HIERARCHY_COST[this.net.linkClass[link]] * this.opts.localPenalty;
    const local = rate * (this.mv.linkDriveLen[link] / 1000);
    return base * noise + local;
  }

  /**
   * Baklänges Dijkstra från målets ankarlänkar. Tillståndet är en länk, inte en
   * nod, så svängstraff kan läggas på rätt rörelse.
   */
  private build(dest: number, cls: number): Int32Array {
    const { net, mv } = this;
    const n = net.linkCount;
    const next = new Int32Array(n).fill(-1);
    const dist = new Float64Array(n).fill(Infinity);
    const heap = new MinHeap(Math.min(n, 1 << 16));

    for (const l of this.destLinks[dest]) {
      if (l < 0 || l >= n) continue;
      dist[l] = 0;
      next[l] = l; // målet självt
      heap.push(l, 0);
    }

    while (heap.size > 0) {
      const l = heap.pop();
      const d = heap.lastKey;
      if (d > dist[l]) continue;

      for (let k = this.inConnStart[l]; k < this.inConnStart[l + 1]; k++) {
        const conn = this.inConn[k];
        const prev = mv.connFromLink[conn];
        const cost =
          this.linkCost(prev, cls) + turnPenalty(net, mv, conn, this.signalDelay);
        const nd = d + cost;
        if (nd < dist[prev]) {
          dist[prev] = nd;
          next[prev] = l;
          heap.push(prev, nd);
        }
      }
    }
    return next;
  }
}

/** Binär heap med Float64-nycklar; snabbare än en generisk prioritetskö här. */
class MinHeap {
  private items: Int32Array;
  private keys: Float64Array;
  size = 0;
  lastKey = 0;

  constructor(capacity: number) {
    this.items = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
  }

  private grow(): void {
    const items = new Int32Array(this.items.length * 2);
    const keys = new Float64Array(this.keys.length * 2);
    items.set(this.items);
    keys.set(this.keys);
    this.items = items;
    this.keys = keys;
  }

  push(item: number, key: number): void {
    if (this.size === this.items.length) this.grow();
    let i = this.size++;
    this.items[i] = item;
    this.keys[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.items[0];
    this.lastKey = this.keys[0];
    this.size--;
    if (this.size > 0) {
      this.items[0] = this.items[this.size];
      this.keys[0] = this.keys[this.size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && this.keys[l] < this.keys[m]) m = l;
        if (r < this.size && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const ti = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = ti;
    const tk = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = tk;
  }
}
