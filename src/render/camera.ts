/** Ortografisk kamera över planet i meter. */
export class Camera {
  /** Mittpunkt i världskoordinater (meter). */
  x = 0;
  y = 0;
  /** Bildpunkter per meter. */
  scale = 0.05;
  width = 1;
  height = 1;
  dpr = 1;

  minScale = 0.005;
  maxScale = 8;

  /**
   * Området som väntar på att kunna ramas in.
   *
   * Sidan kan laddas i ett fönster som ännu inte har någon storlek — en dold
   * flik, eller en ruta som inte hunnit få layout. Räknas kameran ut då blir
   * skalan noll och alla koordinater NaN, och kartan återhämtar sig aldrig ens
   * när fönstret får sin storlek. Inramningen sparas därför tills det finns en
   * yta att rama in mot.
   */
  private pending: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  private pendingMargin = 1.06;

  setViewport(width: number, height: number, dpr: number): void {
    const hadSize = this.width > 0 && this.height > 0;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    if (!hadSize && width > 0 && height > 0 && this.pending) {
      const bounds = this.pending;
      this.pending = null;
      this.fit(bounds, this.pendingMargin);
    }
  }

  /** Passar in ett område med marginal. */
  fit(bounds: { minX: number; minY: number; maxX: number; maxY: number }, margin = 1.06): void {
    this.x = (bounds.minX + bounds.maxX) / 2;
    this.y = (bounds.minY + bounds.maxY) / 2;
    if (this.width <= 0 || this.height <= 0) {
      this.pending = { ...bounds };
      this.pendingMargin = margin;
      return;
    }
    const sx = this.width / Math.max(1, (bounds.maxX - bounds.minX) * margin);
    const sy = this.height / Math.max(1, (bounds.maxY - bounds.minY) * margin);
    this.scale = Math.min(sx, sy);
    this.minScale = this.scale * 0.5;
  }

  worldToScreen(wx: number, wy: number): [number, number] {
    return [
      (wx - this.x) * this.scale + this.width / 2,
      this.height / 2 - (wy - this.y) * this.scale,
    ];
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [
      (sx - this.width / 2) / this.scale + this.x,
      this.y - (sy - this.height / 2) / this.scale,
    ];
  }

  panByPixels(dx: number, dy: number): void {
    this.x -= dx / this.scale;
    this.y += dy / this.scale;
  }

  /** Zoomar kring en punkt på skärmen så att punkten står stilla. */
  zoomAt(sx: number, sy: number, factor: number): void {
    // Utan giltig skala finns ingen omräkning mellan skärm och värld att göra.
    if (!(this.scale > 0) || !Number.isFinite(factor)) return;
    const [wx, wy] = this.screenToWorld(sx, sy);
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    const [nx, ny] = this.screenToWorld(sx, sy);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    this.x += wx - nx;
    this.y += wy - ny;
  }

  /** Synligt område i världskoordinater. */
  viewBounds(pad = 0): { minX: number; minY: number; maxX: number; maxY: number } {
    const hw = this.width / 2 / this.scale + pad;
    const hh = this.height / 2 / this.scale + pad;
    return { minX: this.x - hw, minY: this.y - hh, maxX: this.x + hw, maxY: this.y + hh };
  }

  /** Radie i meter som täcker skärmen — används för mikroområdets storlek. */
  viewRadius(): number {
    return Math.hypot(this.width, this.height) / 2 / this.scale;
  }
}
