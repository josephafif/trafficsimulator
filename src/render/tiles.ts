/**
 * Flygbild som bakgrund till vägnätet.
 *
 * Kaklen hämtas i Web Mercator, medan kartan i övrigt räknar i meter i ett lokalt
 * plan. Omräkningen sker per kakel: världskoordinat → lat/lon → kakelindex, och
 * tillbaka för att veta var kaklet ska ritas. Felet mellan projektionerna är
 * försumbart över ett stadsområde.
 *
 * Bilderna ritas i en egen 2D-yta bakom WebGL-lagret. Det är enklare än att föra
 * in dem i vägrenderingen, och antalet kakel på skärmen är litet nog att det inte
 * kostar något.
 */

import type { Camera } from './camera.ts';
import type { Projection } from '../core/geo.ts';

export interface TileSource {
  name: string;
  /** URL-mall med {z}/{x}/{y}. */
  url: string;
  attribution: string;
  maxZoom: number;
}

/**
 * Esri World Imagery. Fritt tillgänglig med angiven källhänvisning, som ritas
 * ut i kartans hörn när lagret är på.
 */
export const SATELLITE: TileSource = {
  name: 'Flygbild',
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Flygbild: Esri, Maxar, Earthstar Geographics',
  maxZoom: 19,
};

const TILE_SIZE = 256;
/** Fler kakel än så i minnet ger ingen nytta men kostar. */
const CACHE_LIMIT = 400;

export class TileLayer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly proj: Projection;
  private readonly cache = new Map<string, HTMLImageElement>();
  private readonly failed = new Set<string>();
  private source: TileSource = SATELLITE;
  private onLoad: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, proj: Projection) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D saknas');
    this.ctx = ctx;
    this.proj = proj;
  }

  /** Anropas när ett kakel laddats klart, så bilden kan ritas om. */
  setOnLoad(fn: () => void): void {
    this.onLoad = fn;
  }

  get credit(): string {
    return this.source.attribution;
  }

  clear(cam: Camera): void {
    const canvas = this.ctx.canvas;
    const w = Math.round(cam.width * cam.dpr);
    const h = Math.round(cam.height * cam.dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  render(cam: Camera): void {
    this.clear(cam);
    const ctx = this.ctx;
    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);

    const view = cam.viewBounds(0);
    const north = this.proj.lat(view.maxY);
    const south = this.proj.lat(view.minY);
    const west = this.proj.lon(view.minX);
    const east = this.proj.lon(view.maxX);

    const z = this.zoomFor(cam, (north + south) / 2);
    const n = 2 ** z;
    const x0 = Math.max(0, Math.floor(lonToTile(west, n)));
    const x1 = Math.min(n - 1, Math.floor(lonToTile(east, n)));
    const y0 = Math.max(0, Math.floor(latToTile(north, n)));
    const y1 = Math.min(n - 1, Math.floor(latToTile(south, n)));

    // Ett halvt bildpunktsöverlapp döljer sömmarna mellan kaklen.
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const img = this.tile(z, tx, ty);
        if (!img || !img.complete || img.naturalWidth === 0) continue;
        const [ax, ay] = cam.worldToScreen(
          this.proj.x(tileToLon(tx, n)),
          this.proj.y(tileToLat(ty, n)),
        );
        const [bx, by] = cam.worldToScreen(
          this.proj.x(tileToLon(tx + 1, n)),
          this.proj.y(tileToLat(ty + 1, n)),
        );
        ctx.drawImage(img, ax - 0.5, ay - 0.5, bx - ax + 1, by - ay + 1);
      }
    }
  }

  /** Kakelnivå som ger ungefär en bildpunkt per bildpunkt. */
  private zoomFor(cam: Camera, lat: number): number {
    const metresPerPixel = 1 / cam.scale;
    const equator = 156543.03392 * Math.cos((lat * Math.PI) / 180);
    const z = Math.log2(equator / metresPerPixel / (TILE_SIZE / 256));
    return Math.max(2, Math.min(this.source.maxZoom, Math.round(z)));
  }

  private tile(z: number, x: number, y: number): HTMLImageElement | null {
    const key = z + '/' + x + '/' + y;
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (this.failed.has(key)) return null;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => this.onLoad();
    img.onerror = () => {
      this.cache.delete(key);
      this.failed.add(key);
    };
    img.src = this.source.url
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));

    this.cache.set(key, img);
    if (this.cache.size > CACHE_LIMIT) {
      // Map bevarar insättningsordningen, så den äldsta ligger först.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return img;
  }
}

const lonToTile = (lon: number, n: number): number => ((lon + 180) / 360) * n;

function latToTile(lat: number, n: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
}

const tileToLon = (x: number, n: number): number => (x / n) * 360 - 180;

function tileToLat(y: number, n: number): number {
  const r = Math.PI * (1 - (2 * y) / n);
  return (180 / Math.PI) * Math.atan(Math.sinh(r));
}
