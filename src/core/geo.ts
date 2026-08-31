/**
 * Lokal planprojektion. För ett stadsområde (<30 km) räcker en ekvirektangulär
 * projektion runt områdets mittpunkt — felet är under 0,1 % vilket är långt under
 * OSM-geometrins egen osäkerhet, och vi slipper Mercators skalförvrängning som
 * annars gör att avstånd i meter inte stämmer.
 */

export const EARTH_M_PER_DEG_LAT = 110574;

export class Projection {
  readonly lat0: number;
  readonly lon0: number;
  readonly mPerDegLon: number;

  constructor(lat0: number, lon0: number) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  }

  static fromBbox(bbox: [number, number, number, number]): Projection {
    const [s, w, n, e] = bbox;
    return new Projection((s + n) / 2, (w + e) / 2);
  }

  /** lon/lat -> meter öster/norr om origo. */
  x(lon: number): number {
    return (lon - this.lon0) * this.mPerDegLon;
  }
  y(lat: number): number {
    return (lat - this.lat0) * EARTH_M_PER_DEG_LAT;
  }

  lon(x: number): number {
    return this.lon0 + x / this.mPerDegLon;
  }
  lat(y: number): number {
    return this.lat0 + y / EARTH_M_PER_DEG_LAT;
  }
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function growBounds(b: Bounds, x: number, y: number): void {
  if (x < b.minX) b.minX = x;
  if (y < b.minY) b.minY = y;
  if (x > b.maxX) b.maxX = x;
  if (y > b.maxY) b.maxY = y;
}

export function boundsContain(b: Bounds, x: number, y: number): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.hypot(dx, dy);
}

/** Vinkelskillnad normaliserad till (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Enkelt uniformt rutnät för punktsökning (närmaste länk, klick-träff, zon-tilldelning).
 * Snabbare än ett quadtree för våra jämnt fördelade vägnät och trivialt att bygga om.
 */
export class SpatialGrid {
  readonly cell: number;
  readonly minX: number;
  readonly minY: number;
  readonly cols: number;
  readonly rows: number;
  private readonly starts: Int32Array;
  private readonly items: Int32Array;

  constructor(bounds: Bounds, cellSize: number, count: number, xs: Float64Array, ys: Float64Array) {
    this.cell = cellSize;
    this.minX = bounds.minX;
    this.minY = bounds.minY;
    this.cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSize) + 1);
    this.rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cellSize) + 1);

    const ncells = this.cols * this.rows;
    const counts = new Int32Array(ncells + 1);
    const cellOf = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const c = this.cellIndex(xs[i], ys[i]);
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < ncells; c++) counts[c + 1] += counts[c];
    this.starts = counts;
    this.items = new Int32Array(count);
    const cursor = counts.slice();
    for (let i = 0; i < count; i++) this.items[cursor[cellOf[i]]++] = i;
  }

  private cellIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
    return cy * this.cols + cx;
  }

  /** Anropar fn för varje objekt inom radie r från (x,y). Kan ge några falska träffar utanför r. */
  forEachNear(x: number, y: number, r: number, fn: (index: number) => void): void {
    const c0 = Math.max(0, Math.floor((x - r - this.minX) / this.cell));
    const c1 = Math.min(this.cols - 1, Math.floor((x + r - this.minX) / this.cell));
    const r0 = Math.max(0, Math.floor((y - r - this.minY) / this.cell));
    const r1 = Math.min(this.rows - 1, Math.floor((y + r - this.minY) / this.cell));
    for (let cy = r0; cy <= r1; cy++) {
      const base = cy * this.cols;
      for (let cx = c0; cx <= c1; cx++) {
        const c = base + cx;
        const end = this.starts[c + 1];
        for (let k = this.starts[c]; k < end; k++) fn(this.items[k]);
      }
    }
  }
}
