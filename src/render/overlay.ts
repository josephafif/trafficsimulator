/**
 * 2D-lagret ovanpå kartan: gatunamn, markeringar, zoner, flaskhalsnålar och skalstock.
 *
 * Text och markörer ritas här istället för i WebGL — det är få objekt, och Canvas2D
 * ger både typografi och träffsäkra former utan att kosta något i praktiken.
 */

import type { Camera } from './camera.ts';
import type { Bottleneck, RenderNetwork, RenderZone } from '../sim/protocol.ts';
import type { MapTheme } from '../ui/theme.ts';

export interface OverlayState {
  selectedLink: number;
  hoverLink: number;
  bottlenecks: Bottleneck[];
  showBottlenecks: boolean;
  showZones: boolean;
  showLabels: boolean;
  zones: RenderZone[];
  flows: { fromZone: number; toZone: number; vehiclesPerHour: number; active: boolean }[];
  focus: { x: number; y: number; radius: number } | null;
  measuring: { x: number; y: number }[];
  /** Bildpunkter längst ner som täcks av gränssnittet, t.ex. nyckeltalsremsan. */
  bottomInset: number;
  /** Vilka verksamhetsgrupper som ska visas; tom uppsättning döljer lagret. */
  placeKinds: Set<number>;
  /** Källhänvisning för bakgrundsbilden; tom sträng döljer den. */
  credit: string;
  /** Den valda bilens resa: vald väg, start och mål. */
  trip: {
    route: Float32Array;
    x: number; y: number;
    originX: number; originY: number;
    destX: number; destY: number;
  } | null;
}

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private net: RenderNetwork;
  private theme: MapTheme;

  constructor(canvas: HTMLCanvasElement, net: RenderNetwork, theme: MapTheme) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D saknas');
    this.ctx = ctx;
    this.net = net;
    this.theme = theme;
  }

  setTheme(theme: MapTheme): void {
    this.theme = theme;
  }

  render(cam: Camera, state: OverlayState): void {
    const ctx = this.ctx;
    const canvas = ctx.canvas;
    const w = Math.round(cam.width * cam.dpr);
    const h = Math.round(cam.height * cam.dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
    ctx.clearRect(0, 0, cam.width, cam.height);

    this.taken.length = 0;
    if (state.focus) this.drawFocus(cam, state.focus);
    if (state.showZones) this.drawZones(cam, state);
    if (state.hoverLink >= 0 && state.hoverLink !== state.selectedLink) {
      this.drawLink(cam, state.hoverLink, this.theme.hover, 2);
    }
    if (state.selectedLink >= 0) this.drawLink(cam, state.selectedLink, this.theme.selection, 3);
    if (state.showBottlenecks) this.drawBottlenecks(cam, state.bottlenecks);
    if (state.placeKinds.size > 0) this.drawPlaces(cam, state.placeKinds);
    if (state.showLabels) this.drawLabels(cam);
    if (state.trip) this.drawTrip(cam, state.trip);
    if (state.measuring.length > 0) this.drawMeasure(cam, state.measuring);
    this.drawScaleBar(cam, state.bottomInset);
    if (state.credit) this.drawCredit(cam, state.credit, state.bottomInset);
  }

  private drawFocus(cam: Camera, focus: { x: number; y: number; radius: number }): void {
    const ctx = this.ctx;
    const [sx, sy] = cam.worldToScreen(focus.x, focus.y);
    const r = focus.radius * cam.scale;
    if (r < 20 || r > 6000) return;
    ctx.save();
    ctx.strokeStyle = this.theme.focusRing;
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private linkPath(cam: Camera, link: number): void {
    const ctx = this.ctx;
    const net = this.net;
    const s = net.linkGeomStart[link];
    const e = net.linkGeomStart[link + 1];
    ctx.beginPath();
    for (let k = s; k < e; k++) {
      const [x, y] = cam.worldToScreen(net.geomX[k], net.geomY[k]);
      if (k === s) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  private drawLink(cam: Camera, link: number, color: string, extra: number): void {
    const ctx = this.ctx;
    const net = this.net;
    const width = Math.max(3, net.linkLanes[link] * net.linkLaneWidth[link] * cam.scale) + extra;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.linkPath(cam, link);
    ctx.stroke();
    ctx.restore();
  }

  private drawBottlenecks(cam: Camera, list: Bottleneck[]): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < Math.min(list.length, 10); i++) {
      const b = list[i];
      const [x, y] = cam.worldToScreen(b.x, b.y);
      if (x < -30 || y < -30 || x > cam.width + 30 || y > cam.height + 30) continue;
      const r = 11;
      ctx.beginPath();
      ctx.arc(x, y - r * 1.4, r, 0, Math.PI * 2);
      ctx.fillStyle = i < 3 ? '#e11d48' : '#f59e0b';
      ctx.globalAlpha = 0.92;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = this.theme.pinText;
      ctx.fillText(String(i + 1), x, y - r * 1.4 + 0.5);
    }
    ctx.restore();
  }

  private drawZones(cam: Camera, state: OverlayState): void {
    const ctx = this.ctx;
    const zones = state.zones;
    if (zones.length === 0) return;
    let maxP = 1;
    for (const z of zones) maxP = Math.max(maxP, z.production + z.attraction);

    ctx.save();
    for (const z of zones) {
      const [x, y] = cam.worldToScreen(z.x, z.y);
      if (x < -40 || y < -40 || x > cam.width + 40 || y > cam.height + 40) continue;
      const r = 4 + 22 * Math.sqrt((z.production + z.attraction) / maxP);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = z.external ? this.theme.zoneExternalFill : this.theme.zoneFill;
      ctx.fill();
      ctx.strokeStyle = z.external ? this.theme.zoneExternalEdge : this.theme.zoneEdge;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // Handritade flöden som pilar mellan zonernas mittpunkter.
    for (const f of state.flows) {
      if (!f.active) continue;
      const a = zones[f.fromZone];
      const b = zones[f.toZone];
      if (!a || !b) continue;
      const [x1, y1] = cam.worldToScreen(a.x, a.y);
      const [x2, y2] = cam.worldToScreen(b.x, b.y);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = 'rgba(250,204,21,0.8)';
      ctx.lineWidth = Math.max(1.5, Math.min(9, f.vehiclesPerHour / 220));
      ctx.stroke();
      const ang = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - 12 * Math.cos(ang - 0.4), y2 - 12 * Math.sin(ang - 0.4));
      ctx.lineTo(x2 - 12 * Math.cos(ang + 0.4), y2 - 12 * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fillStyle = 'rgba(250,204,21,0.9)';
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Namngivna målpunkter: handel, arbetsplatser, skolor, vård.
   *
   * Bara de som är stora nog för den aktuella skalan ritas, och symbolen växer
   * med hur mycket trafik platsen drar. Det gör att en galleria syns långt ut
   * medan en skola dyker upp först när man zoomat in — kartan blir läsbar i
   * stället för övertäckt av etiketter.
   */
  /** Upptagna etikettytor denna bildruta; delas mellan platser och gatunamn. */
  private taken: { x: number; y: number; w: number; h: number }[] = [];

  private fits(x: number, y: number, w: number, h: number, cam: Camera): boolean {
    if (x - w / 2 < 4 || x + w / 2 > cam.width - 4 || y < 10 || y > cam.height - 10) return false;
    for (const q of this.taken) {
      if (Math.abs(q.x - x) < (q.w + w) / 2 && Math.abs(q.y - y) < (q.h + h) / 2) return false;
    }
    this.taken.push({ x, y, w, h });
    return true;
  }

  private drawPlaces(cam: Camera, kinds: Set<number>): void {
    const ctx = this.ctx;
    const places = this.net.places;
    if (!places || places.length === 0) return;
    const view = cam.viewBounds(80);
    // Ju mer utzoomad, desto större måste platsen vara för att ta plats.
    const threshold = 260 / Math.max(cam.scale, 0.02);

    ctx.save();
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const p of places) {
      if (!kinds.has(p.kind)) continue;
      if (p.pull < threshold) continue;
      if (p.x < view.minX || p.x > view.maxX || p.y < view.minY || p.y > view.maxY) continue;
      const [x, y] = cam.worldToScreen(p.x, p.y);

      const r = Math.max(3.5, Math.min(11, 3 + Math.sqrt(p.pull) / 14));
      const showName = cam.scale > 0.09 && p.pull > threshold * 1.6;
      const w = showName ? ctx.measureText(p.name).width + 10 : r * 2 + 4;
      if (!this.fits(x, y + (showName ? r + 8 : 0), w, showName ? 26 : r * 2 + 4, cam)) continue;

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = this.theme.placeColors[p.kind] ?? this.theme.placeColors[5];
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = this.theme.placeHalo;
      ctx.stroke();

      if (showName) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = this.theme.placeHalo;
        ctx.strokeText(p.name, x, y + r + 8);
        ctx.fillStyle = this.theme.placeText;
        ctx.fillText(p.name, x, y + r + 8);
      }
    }
    ctx.restore();
  }

  /** Gatunamn längs de större stråken, ett per namn och skärm. */
  private drawLabels(cam: Camera): void {
    if (cam.scale < 0.05) return;
    const ctx = this.ctx;
    const net = this.net;
    const view = cam.viewBounds(50);
    const placed: { x: number; y: number }[] = [];
    const seen = new Set<string>();
    const maxClass = cam.scale > 0.35 ? 6 : cam.scale > 0.14 ? 5 : 4;

    ctx.save();
    ctx.font = '500 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let l = 0; l < net.linkCount && placed.length < 90; l++) {
      if (net.linkClass[l] > maxClass) continue;
      const nameId = net.linkNameId[l];
      if (nameId === 0) continue;
      const name = net.names[nameId];
      if (seen.has(name)) continue;

      const s = net.linkGeomStart[l];
      const e = net.linkGeomStart[l + 1];
      const m = (s + e) >> 1;
      const wx = net.geomX[m];
      const wy = net.geomY[m];
      if (wx < view.minX || wx > view.maxX || wy < view.minY || wy > view.maxY) continue;
      // Bara på sträckor som är långa nog att bära texten.
      if (net.geomCum[e - 1] * cam.scale < 60) continue;

      const [x, y] = cam.worldToScreen(wx, wy);
      // Ett namn som sticker utanför bilden blir avhugget och läses inte ändå,
      // och det får inte heller lägga sig ovanpå en plats-etikett.
      if (!this.fits(x, y, ctx.measureText(name).width + 12, 16, cam)) continue;
      let clash = false;
      for (const p of placed) {
        if (Math.abs(p.x - x) < 90 && Math.abs(p.y - y) < 22) {
          clash = true;
          break;
        }
      }
      if (clash) continue;

      seen.add(name);
      placed.push({ x, y });
      ctx.lineWidth = 3;
      ctx.strokeStyle = this.theme.labelHalo;
      ctx.strokeText(name, x, y);
      ctx.fillStyle = this.theme.label;
      ctx.fillText(name, x, y);
    }
    ctx.restore();
  }

  /**
   * Den valda bilens resa: vägen framåt, var den startade och vart den ska.
   *
   * Vägen ritas ovanpå kartan i stället för i WebGL-lagret därför att det bara
   * gäller ett fordon i taget — och för att en streckad linje med markörer är
   * enklare att få läsbar i Canvas2D.
   */
  private drawTrip(cam: Camera, trip: NonNullable<OverlayState['trip']>): void {
    const ctx = this.ctx;
    ctx.save();

    if (trip.route.length >= 4) {
      ctx.beginPath();
      for (let i = 0; i < trip.route.length; i += 2) {
        const [x, y] = cam.worldToScreen(trip.route[i], trip.route[i + 1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = this.theme.tripHalo;
      ctx.lineWidth = 7;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.strokeStyle = this.theme.trip;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    const marker = (wx: number, wy: number, fill: string, label: string): void => {
      const [x, y] = cam.worldToScreen(wx, wy);
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = this.theme.labelHalo;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = this.theme.pinText;
      ctx.font = '700 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x, y + 0.5);
    };
    marker(trip.originX, trip.originY, this.theme.tripOrigin, 'A');
    marker(trip.destX, trip.destY, this.theme.tripDest, 'B');

    // Ring runt själva bilen så den går att följa i myllret.
    const [cx, cy] = cam.worldToScreen(trip.x, trip.y);
    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, Math.PI * 2);
    ctx.strokeStyle = this.theme.trip;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  }

  private drawMeasure(cam: Camera, pts: { x: number; y: number }[]): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = this.theme.measure;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    let total = 0;
    pts.forEach((p, i) => {
      const [x, y] = cam.worldToScreen(p.x, p.y);
      if (i === 0) ctx.moveTo(x, y);
      else {
        ctx.lineTo(x, y);
        total += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
      }
    });
    ctx.stroke();
    ctx.setLineDash([]);
    if (pts.length > 1) {
      const last = pts[pts.length - 1];
      const [x, y] = cam.worldToScreen(last.x, last.y);
      const text = total >= 1000 ? (total / 1000).toFixed(2) + ' km' : total.toFixed(0) + ' m';
      ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = this.theme.measureBg;
      const tw = ctx.measureText(text).width + 12;
      ctx.fillRect(x + 8, y - 22, tw, 18);
      ctx.fillStyle = this.theme.measure;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + 14, y - 13);
    }
    ctx.restore();
  }

  /** Källhänvisning till bakgrundsbilden — ett villkor för att få använda den. */
  private drawCredit(cam: Camera, text: string, bottomInset: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const x = cam.width - 10;
    const y = cam.height - 6 - bottomInset;
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.theme.labelHalo;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = this.theme.scaleBar;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  private drawScaleBar(cam: Camera, bottomInset: number): void {
    const ctx = this.ctx;
    const targetPx = 120;
    const meters = targetPx / cam.scale;
    const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    let best = steps[0];
    for (const s of steps) if (Math.abs(s - meters) < Math.abs(best - meters)) best = s;
    const px = best * cam.scale;

    const x = 16;
    const y = cam.height - 22 - bottomInset;
    ctx.save();
    ctx.strokeStyle = this.theme.scaleBar;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.lineTo(x + px, y - 5);
    ctx.stroke();
    ctx.font = '500 11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = this.theme.scaleBar;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(best >= 1000 ? best / 1000 + ' km' : best + ' m', x + 4, y - 8);
    ctx.restore();
  }

  /** Närmaste länk till en världspunkt, eller -1. `tolerancePx` är träffytans radie. */
  pickLink(cam: Camera, wx: number, wy: number, tolerancePx = 12): number {
    const net = this.net;
    const tolerance = Math.max(tolerancePx / cam.scale, 6);
    let best = -1;
    let bestD = tolerance;
    const view = cam.viewBounds(tolerance);

    for (let l = 0; l < net.linkCount; l++) {
      const s = net.linkGeomStart[l];
      const e = net.linkGeomStart[l + 1];
      if (net.geomX[s] < view.minX && net.geomX[e - 1] < view.minX) continue;
      if (net.geomX[s] > view.maxX && net.geomX[e - 1] > view.maxX) continue;
      for (let k = s; k < e - 1; k++) {
        const d = pointSegmentDistance(wx, wy, net.geomX[k], net.geomY[k], net.geomX[k + 1], net.geomY[k + 1]);
        if (d < bestD) {
          bestD = d;
          best = l;
        }
      }
    }
    return best;
  }
}

function pointSegmentDistance(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
