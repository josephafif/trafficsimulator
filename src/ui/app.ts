/**
 * Applikationsskalet: layout, kartinteraktion, kommunikation med simuleringstråden
 * och ritslingan.
 */

import { Camera } from '../render/camera.ts';
import { GlMap } from '../render/glmap.ts';
import { Overlay, type OverlayState } from '../render/overlay.ts';
import { TileLayer } from '../render/tiles.ts';
import { Projection } from '../core/geo.ts';
import { DEFAULT_CONFIG, type SimConfig } from '../sim/config.ts';
import {
  LinkMetric, VEHICLE_STRIDE,
  type FromWorker, type RenderNetwork, type RenderSignal, type ToWorker, type VehicleInfo,
} from '../sim/protocol.ts';
import type { NetworkStats } from '../sim/engine.ts';
import { buildPanels, manualFlows, type AppState, type Panels, type Ui } from './panels.ts';
import { button, clockText, downloadText, el, nf, nf1, selectField } from './dom.ts';
import { rampCss, Theme, THEME_ICON, THEME_LABEL } from './theme.ts';

/** Under den här bredden läggs sidopanelen i en draglåda ovanpå kartan. */
const NARROW = 860;
const isNarrow = (): boolean => window.innerWidth <= NARROW;

const CITIES = [
  { key: 'uppsala', label: 'Uppsala tätort' },
  { key: 'uppsala-centrum', label: 'Uppsala centrum' },
  { key: 'stockholm', label: 'Stockholms innerstad' },
  { key: 'goteborg', label: 'Göteborg centrum' },
  { key: 'malmo', label: 'Malmö' },
  { key: 'linkoping', label: 'Linköping' },
  { key: 'vasteras', label: 'Västerås' },
  { key: 'orebro', label: 'Örebro' },
];

const SPEEDS = [1, 2, 4, 8, 16, 32];

export class App {
  private worker: Worker;
  private cam = new Camera();
  private glCanvas: HTMLCanvasElement;
  private tileCanvas: HTMLCanvasElement = el('canvas', { class: 'map-tiles' }) as HTMLCanvasElement;
  private overlayCanvas: HTMLCanvasElement;
  private map: GlMap | null = null;
  private overlay: Overlay | null = null;
  private net: RenderNetwork | null = null;

  private config: SimConfig = { ...DEFAULT_CONFIG };
  private state: AppState = {
    metric: LinkMetric.Speed,
    showVehicles: true,
    showSignals: true,
    showLabels: true,
    showZones: false,
    showBottlenecks: true,
    autoFocus: true,
    fullMicro: false,
    selectedLink: -1,
    selectedSignal: -1,
    waveSignals: [],
    flowMode: false,
  };

  private signalPositions = new Float32Array(0);
  private signals: RenderSignal[] = [];
  private bottlenecks: OverlayState['bottlenecks'] = [];
  private measurePoints: { x: number; y: number }[] = [];
  /**
   * Fordonens läge och index, kopierat ur bildrutan innan bufferten lämnas
   * tillbaka. Behövs för att kunna träffa ett fordon med ett klick.
   */
  private picking = new Float32Array(0);
  private pickCount = 0;
  private trip: VehicleInfo | null = null;
  private playBtn: HTMLElement | null = null;
  private tiles: TileLayer | null = null;
  /** Flygbild som bakgrund. */
  satellite = false;
  /** Vilka verksamhetsgrupper kartan visar. */
  readonly placeKinds = new Set<number>();
  private flowPending: { x: number; y: number } | null = null;
  private hoverLink = -1;

  private playing = true;
  private speed = 4;
  private panels: Panels | null = null;
  private readonly theme = new Theme();
  private scrim: HTMLElement;
  private drawerOpen = false;

  private kpiRow: HTMLElement;
  private clockEl: HTMLElement;
  private statusEl: HTMLElement;
  private loaderEl: HTMLElement;
  private toastEl: HTMLElement;
  private legendEl: HTMLElement;
  private sidebar: HTMLElement;

  private focusTimer = 0;

  constructor(root: HTMLElement) {
    this.glCanvas = el('canvas', { class: 'map-gl' });
    this.overlayCanvas = el('canvas', { class: 'map-overlay' });
    this.kpiRow = el('div', { class: 'kpi-row' });
    this.clockEl = el('div', { class: 'clock', text: '--:--' });
    this.statusEl = el('div', { class: 'status', text: '' });
    this.loaderEl = el('div', { class: 'loader' }, [
      el('div', { class: 'loader-inner' }, [
        el('div', { class: 'spinner' }),
        el('div', { class: 'loader-text', text: 'Startar …' }),
      ]),
    ]);
    this.toastEl = el('div', { class: 'toast' });
    this.legendEl = el('div', { class: 'legend' });
    this.sidebar = el('aside', { class: 'sidebar' });
    this.scrim = el('div', { class: 'scrim', onclick: () => this.setDrawer(false) });

    root.append(
      this.buildTopbar(),
      this.scrim,
      el('main', { class: 'workspace' }, [
        this.sidebar,
        el('div', { class: 'map-wrap' }, [
          this.tileCanvas,
          this.glCanvas,
          this.overlayCanvas,
          this.legendEl,
          el('div', { class: 'kpi-panel' }, [this.kpiRow]),
          this.toastEl,
          this.loaderEl,
        ]),
      ]),
    );

    this.worker = new Worker(new URL('../sim/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e) => this.fail(e.message || 'Fel i simuleringstråden');

    this.theme.onChange((mapTheme) => {
      this.map?.setTheme(mapTheme);
      this.overlay?.setTheme(mapTheme);
      this.lastLegendMetric = -1;
      this.renderOnce();
    });

    this.bindMap();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.loadCity('uppsala');
    requestAnimationFrame(() => this.frame());
    // Handtag för felsökning från webbläsarkonsolen.
    (window as unknown as { trafik: App }).trafik = this;
  }

  // --- Skal --------------------------------------------------------------------------

  private buildTopbar(): HTMLElement {
    // Uppspelningen styrs av två skilda saker: om klockan går alls, och hur fort
    // den går. Att slå ihop dem i en knapp som stegar runt gör att man inte kan
    // pausa utan att också ändra farten.
    const playBtn = button('❚❚', () => this.setPlaying(!this.playing), 'play playing');
    this.playBtn = playBtn;

    const speedLabel = el('span', { class: 'speed-value', text: this.speed + '×' });
    const speedInput = el('input', {
      type: 'range',
      class: 'speed-range',
      min: '0',
      max: String(SPEEDS.length - 1),
      step: '1',
      value: String(SPEEDS.indexOf(this.speed)),
      title: 'Simuleringens hastighet',
      oninput: () => {
        this.speed = SPEEDS[Number(speedInput.value)];
        speedLabel.textContent = this.speed + '×';
        this.send({ type: 'run', playing: this.playing, speed: this.speed });
      },
    }) as HTMLInputElement;

    const citySelect = selectField('', CITIES.map((c) => ({ value: c.key, label: c.label })), 'uppsala',
      (key) => this.loadCity(key));
    citySelect.classList.add('city-select');
    void this.markAvailableCities(citySelect);

    const hourSelect = selectField(
      '',
      [
        { value: '5', label: '05 Natt' },
        { value: '7', label: '07 Morgonrusning' },
        { value: '10', label: '10 Förmiddag' },
        { value: '12', label: '12 Lunch' },
        { value: '14', label: '14 Eftermiddag' },
        { value: '16', label: '16 Eftermiddagsrusning' },
        { value: '19', label: '19 Kväll' },
        { value: '22', label: '22 Sen kväll' },
      ],
      '7',
      (v) => {
        this.send({ type: 'setHour', hour: Number(v) });
        this.notify('Fyller nätet med trafik för kl ' + v.padStart(2, '0') + ':00 …');
      },
    );
    hourSelect.classList.add('hour-select');

    const themeBtn = el('button', {
      class: 'btn ghost theme-btn',
      type: 'button',
      title: 'Färgtema: ' + THEME_LABEL[this.theme.current],
      text: THEME_ICON[this.theme.current],
      onclick: () => {
        const next = this.theme.cycle();
        themeBtn.textContent = THEME_ICON[next];
        themeBtn.title = 'Färgtema: ' + THEME_LABEL[next];
        this.notify('Färgtema: ' + THEME_LABEL[next].toLowerCase());
      },
    });

    const menuBtn = el('button', {
      class: 'menu-btn',
      type: 'button',
      'aria-label': 'Visa panelerna',
      text: '☰',
      onclick: () => this.setDrawer(!this.drawerOpen),
    });

    return el('header', { class: 'topbar' }, [
      menuBtn,
      el('div', { class: 'brand' }, [
        el('span', { class: 'brand-mark' }),
        el('div', {}, [
          el('span', { class: 'brand-name', text: 'Trafiksimulator' }),
          el('span', { class: 'brand-sub', text: 'mikrosimulering för stadsplanering' }),
        ]),
      ]),
      citySelect,
      hourSelect,
      el('div', { class: 'transport' }, [playBtn, speedInput, speedLabel, this.clockEl]),
      themeBtn,
      this.statusEl,
    ]);
  }

  /**
   * Märker upp vilka städer som faktiskt har hämtad kartdata.
   *
   * Listan är densamma överallt, men en publicerad version innehåller bara de
   * utsnitt som följde med bygget. Utan den här kontrollen ser det ut som att alla
   * städer går att välja, och den som provar möter ett felmeddelande om ett
   * kommando som bara går att köra lokalt.
   */
  private async markAvailableCities(field: HTMLElement): Promise<void> {
    const select = field.querySelector('select');
    if (!select) return;
    await Promise.all(
      CITIES.map(async (city) => {
        const option = select.querySelector<HTMLOptionElement>(`option[value="${city.key}"]`);
        if (!option) return;
        try {
          const res = await fetch('/data/' + city.key + '.json', { method: 'HEAD' });
          if (res.ok) return;
        } catch {
          // Nätverksfel behandlas som att staden saknas.
        }
        option.disabled = true;
        option.textContent = city.label + ' — ej hämtad';
      }),
    );
  }

  /** Öppnar eller stänger sidopanelen när den ligger som draglåda. */
  private setDrawer(open: boolean): void {
    this.drawerOpen = open;
    this.sidebar.classList.toggle('open', open);
    this.scrim.classList.toggle('open', open);
  }

  private buildLegend(): void {
    const etiketter = ['stopp', 'kraftigt nedsatt', 'nedsatt', 'nära fritt', 'fri framkomlighet'];
    const items: [string, string][] = rampCss(this.theme.map).map(
      (färg, i) => [färg, etiketter[i]] as [string, string],
    );
    const titles: Record<number, string> = {
      [LinkMetric.Speed]: 'Framkomlighet',
      [LinkMetric.Saturation]: 'Belastningsgrad V/C',
      [LinkMetric.Flow]: 'Flöde',
      [LinkMetric.Queue]: 'Kölängd',
      [LinkMetric.Delay]: 'Fördröjning',
      [LinkMetric.Class]: 'Vägklass',
    };
    this.legendEl.replaceChildren(
      el('span', { class: 'legend-title', text: titles[this.state.metric] ?? '' }),
      el('div', { class: 'legend-scale' }, items.map(([c, t]) =>
        el('span', { class: 'legend-item' }, [
          el('i', { style: 'background:' + c }),
          el('span', { text: t }),
        ]))),
    );
  }

  // --- Kommunikation ------------------------------------------------------------------

  private send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  private loadCity(key: string): void {
    this.loaderEl.classList.remove('hidden');
    this.setLoaderText('Läser in ' + key + ' …');
    this.net = null;
    this.map = null;
    this.overlay = null;
    this.state.selectedLink = -1;
    this.state.selectedSignal = -1;
    manualFlows.length = 0;
    // En telefon har varken minnet eller räknekraften för samma fordonspark som
    // en arbetsstation. Taket sätts vid start eftersom fordonspoolen allokeras då.
    const kärnor = navigator.hardwareConcurrency ?? 4;
    const maxVehicles = isNarrow() || kärnor <= 4 ? 20000 : 60000;
    this.send({ type: 'init', city: key, url: '/data/' + key + '.json', maxVehicles });
  }

  private onWorkerMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'progress':
        // Tom text betyder att arbetet är klart; överlägget ska då bort.
        // Utan det blir rutan kvar över kartan efter ett tidshopp.
        if (msg.text === '') this.loaderEl.classList.add('hidden');
        else this.setLoaderText(msg.text);
        break;
      case 'ready':
        this.onReady(msg.network, msg.demandTotal, msg.population);
        break;
      case 'frame': {
        // Bufferten skickas tillbaka till simuleringstråden direkt efter det här
        // blocket och blir då frånkopplad — fordonen måste alltså ligga i
        // GPU-bufferten innan dess, inte läsas om vid varje bildruta.
        this.map?.updateVehicles(new Float32Array(msg.buffer), msg.vehicleCount);
        this.capturePicking(new Float32Array(msg.buffer), msg.vehicleCount);
        this.bottlenecks = msg.bottlenecks;
        this.map?.updateMetric(msg.linkMetric);
        this.map?.updateSignals(this.signalPositions, msg.signalState);
        this.updateKpi(msg.stats);
        this.panels?.updateStats(msg.stats, msg.bottlenecks);
        // Skicka tillbaka bufferten så simuleringstråden kan fylla nästa bildruta.
        this.send({ type: 'returnBuffer', buffer: msg.buffer }, [msg.buffer]);
        break;
      }
      case 'linkInfo':
        this.panels?.updateLink(msg.info);
        this.panels?.openLink();
        break;
      case 'vehicleInfo':
        this.trip = msg.info;
        this.panels?.updateVehicle(msg.info);
        break;
      case 'signalUpdated':
        this.signals = msg.signals;
        this.panels?.updateSignals(msg.signals);
        break;
      case 'odCsv':
        downloadText('od-matris.csv', msg.csv);
        this.notify('OD-matrisen exporterad.');
        break;
      case 'odImported':
        this.notify(`Importerade ${msg.applied} relationer${msg.skipped ? `, ${msg.skipped} rader kunde inte tolkas` : ''}.`);
        break;
      case 'scenarios':
        this.panels?.updateScenarios(msg.list);
        break;
      case 'error':
        this.fail(msg.message);
        break;
    }
  }

  private onReady(net: RenderNetwork, demandTotal: number, population: number): void {
    this.net = net;
    this.signals = net.signals;
    this.signalPositions = new Float32Array(net.signals.length * 2);
    net.signals.forEach((s, i) => {
      this.signalPositions[i * 2] = s.x;
      this.signalPositions[i * 2 + 1] = s.y;
    });

    try {
      this.map = new GlMap(this.glCanvas, net, this.theme.map);
      this.tiles = new TileLayer(this.tileCanvas, new Projection(net.lat0, net.lon0));
      this.tiles.setOnLoad(() => {
        if (this.satellite) this.renderOnce();
      });
      this.overlay = new Overlay(this.overlayCanvas, net, this.theme.map);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }

    this.resize();
    this.cam.fit(net.bounds);
    // Börja inzoomad på stadskärnan — hela tätorten på en gång säger inte mycket.
    this.cam.zoomAt(this.cam.width / 2, this.cam.height / 2, 3.2);

    const ui: Ui = {
      send: (m) => this.send(m),
      net,
      signals: this.signals,
      config: this.config,
      state: this.state,
      demandTotal: Math.round(demandTotal),
      population: Math.round(population),
      focusOn: (x, y, scale) => {
        this.cam.x = x;
        this.cam.y = y;
        if (scale) this.cam.scale = scale;
        this.pushFocus();
        // På telefon ligger panelen över kartan — stäng den så man ser dit man zoomat.
        if (isNarrow()) this.setDrawer(false);
      },
      notify: (t) => this.notify(t),
      exportImage: () => this.exportImage(),
      clearTrip: () => this.clearTrip(),
      setSatellite: (on) => {
        this.satellite = on;
        this.map?.setBackdrop(on);
        this.tileCanvas.classList.toggle('on', on);
        this.renderOnce();
      },
      togglePlaceKind: (kind, on) => {
        if (on) this.placeKinds.add(kind);
        else this.placeKinds.delete(kind);
        this.renderOnce();
      },
      setHour: (hour) => {
        this.send({ type: 'setHour', hour });
        this.notify('Hoppar till klockan ' + String(hour).padStart(2, '0') + ':00');
      },
    };
    this.panels = buildPanels(ui);
    this.sidebar.replaceChildren(this.panels.root);

    this.buildLegend();
    this.send({ type: 'run', playing: this.playing, speed: this.speed });
    this.pushFocus();
    this.loaderEl.classList.add('hidden');
    this.statusEl.textContent = `${net.name} · ${nf.format(net.linkCount)} länkar · ${nf.format(net.signals.length)} signalanläggningar`;
  }

  // --- Kartinteraktion -----------------------------------------------------------------

  private bindMap(): void {
    const canvas = this.overlayCanvas;
    /** Alla nedtryckta fingrar/knappar, för att kunna skilja drag från nyp. */
    const pointers = new Map<number, { x: number; y: number }>();
    let dragging = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;
    let shiftDrag = false;
    let pinchDistance = 0;
    let pinchX = 0;
    let pinchY = 0;

    const centreOf = (): [number, number, number] => {
      let sx = 0;
      let sy = 0;
      const list = [...pointers.values()];
      for (const pt of list) {
        sx += pt.x;
        sy += pt.y;
      }
      const dx = list[0].x - list[1].x;
      const dy = list[0].y - list[1].y;
      return [sx / list.length, sy / list.length, Math.hypot(dx, dy)];
    };

    /** Pekarfångst är inte tillgänglig för alla pekartyper — den får inte fälla dragningen. */
    const capture = (id: number, on: boolean): void => {
      try {
        if (on) canvas.setPointerCapture(id);
        else canvas.releasePointerCapture(id);
      } catch {
        // Pekaren är inte aktiv; dragningen fungerar ändå via händelserna.
      }
    };

    canvas.addEventListener('pointerdown', (e) => {
      capture(e.pointerId, true);
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });

      if (pointers.size === 2) {
        // Nyp börjar: avbryt pågående drag så bilden inte hoppar.
        dragging = false;
        moved = true;
        const [cx, cy, d] = centreOf();
        pinchX = cx;
        pinchY = cy;
        pinchDistance = d;
        return;
      }
      if (pointers.size > 2) return;

      dragging = true;
      moved = false;
      shiftDrag = e.shiftKey;
      lastX = e.offsetX;
      lastY = e.offsetY;
      if (shiftDrag) {
        const [wx, wy] = this.cam.screenToWorld(e.offsetX, e.offsetY);
        this.measurePoints = [{ x: wx, y: wy }];
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });

      if (pointers.size >= 2) {
        const [cx, cy, d] = centreOf();
        if (pinchDistance > 0 && d > 0) {
          // Zooma kring nypets mittpunkt och följ med när den flyttar sig.
          this.cam.zoomAt(pinchX, pinchY, d / pinchDistance);
          this.cam.panByPixels(cx - pinchX, cy - pinchY);
          this.scheduleFocus();
        }
        pinchDistance = d;
        pinchX = cx;
        pinchY = cy;
        return;
      }

      if (dragging) {
        const dx = e.offsetX - lastX;
        const dy = e.offsetY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        lastX = e.offsetX;
        lastY = e.offsetY;
        if (shiftDrag) {
          const [wx, wy] = this.cam.screenToWorld(e.offsetX, e.offsetY);
          this.measurePoints[1] = { x: wx, y: wy };
        } else {
          this.cam.panByPixels(dx, dy);
          this.scheduleFocus();
        }
        return;
      }

      // Markering under pekaren är bara meningsfull med mus.
      if (e.pointerType !== 'mouse' || !this.overlay) return;
      const [wx, wy] = this.cam.screenToWorld(e.offsetX, e.offsetY);
      this.hoverLink = this.overlay.pickLink(this.cam, wx, wy);
      canvas.style.cursor = this.hoverLink >= 0 ? 'pointer' : 'grab';
    });

    const release = (e: PointerEvent): void => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDistance = 0;
      if (pointers.size > 0) return;

      capture(e.pointerId, false);
      const wasDragging = dragging;
      dragging = false;
      if (shiftDrag) {
        shiftDrag = false;
        return;
      }
      if (!wasDragging || moved || !this.overlay || !this.net) return;
      this.handleClick(e);
    };

    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDistance = 0;
      if (pointers.size === 0) dragging = false;
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0016);
      this.cam.zoomAt(e.offsetX, e.offsetY, factor);
      this.scheduleFocus();
    }, { passive: false });

    canvas.addEventListener('dblclick', () => {
      this.measurePoints = [];
    });

    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (e.key === ' ' && target.tagName !== 'INPUT' && target.tagName !== 'SELECT') {
        e.preventDefault();
        this.setPlaying(!this.playing);
      }
      if (e.key === 'Escape') {
        this.measurePoints = [];
        this.flowPending = null;
        this.state.selectedLink = -1;
        this.panels?.updateLink(null);
        this.clearTrip();
        this.setDrawer(false);
      }
    });
  }

  private handleClick(e: PointerEvent): void {
    const net = this.net!;
    const [wx, wy] = this.cam.screenToWorld(e.offsetX, e.offsetY);

    if (this.state.flowMode) {
      if (!this.flowPending) {
        this.flowPending = { x: wx, y: wy };
        this.notify('Startpunkt satt — klicka på målpunkten.');
      } else {
        const from = this.nearestZone(this.flowPending.x, this.flowPending.y);
        const to = this.nearestZone(wx, wy);
        if (from >= 0 && to >= 0 && from !== to) {
          const flow = {
            id: Date.now(),
            name: `${net.zones[from].name} → ${net.zones[to].name}`,
            fromZone: from, toZone: to, vehiclesPerHour: 400, active: true,
          };
          manualFlows.push(flow);
          this.send({ type: 'manualFlow', flow });
          this.notify('Flöde tillagt: ' + flow.name + ' (400 fordon/h).');
          this.state.showZones = true;
          this.panels?.refreshFlows();
        }
        this.flowPending = null;
      }
      return;
    }

    // Ett fordon under pekaren går före allt annat: det är det minsta målet och
    // därmed det som användaren måste ha siktat på.
    if (this.cam.scale > 0.08) {
      const veh = this.pickVehicle(wx, wy, (e.pointerType === 'mouse' ? 14 : 22) / this.cam.scale);
      if (veh >= 0) {
        this.send({ type: 'followVehicle', vehicle: veh });
        this.send({ type: 'inspectVehicle', vehicle: veh });
        this.panels?.openVehicle();
        return;
      }
    }

    // Signalanläggning i närheten går före gatuvalet — punkten är liten att träffa.
    const sig = this.nearestSignal(wx, wy, (e.pointerType === 'mouse' ? 26 : 34) / this.cam.scale);
    if (sig >= 0) {
      if (e.ctrlKey || e.metaKey) {
        const i = this.state.waveSignals.indexOf(sig);
        if (i >= 0) this.state.waveSignals.splice(i, 1);
        else this.state.waveSignals.push(sig);
        this.panels?.updateSignals(this.signals);
        this.notify(this.state.waveSignals.length + ' signaler valda för grön våg.');
      } else {
        this.state.selectedSignal = sig;
        this.panels?.openSignal(sig);
      }
      return;
    }

    const link = this.overlay!.pickLink(this.cam, wx, wy, e.pointerType === 'mouse' ? 12 : 22);
    this.state.selectedLink = link;
    if (link >= 0) this.send({ type: 'inspect', link });
    else this.panels?.updateLink(null);
  }

  /** Sparar läge och index för varje fordon medan bufferten fortfarande är vår. */
  private capturePicking(view: Float32Array, count: number): void {
    if (this.picking.length < count * 3) this.picking = new Float32Array(count * 3 + 3000);
    for (let i = 0; i < count; i++) {
      const o = i * VEHICLE_STRIDE;
      this.picking[i * 3] = view[o];
      this.picking[i * 3 + 1] = view[o + 1];
      this.picking[i * 3 + 2] = view[o + 4];
    }
    this.pickCount = count;
  }

  /** Fordonet närmast en punkt, eller -1. */
  private pickVehicle(wx: number, wy: number, tolerance: number): number {
    let best = -1;
    let bestD = tolerance * tolerance;
    for (let i = 0; i < this.pickCount; i++) {
      const dx = this.picking[i * 3] - wx;
      const dy = this.picking[i * 3 + 1] - wy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = this.picking[i * 3 + 2];
      }
    }
    return best;
  }

  /** Startar eller pausar klockan utan att röra hastigheten. */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (this.playBtn) {
      this.playBtn.textContent = playing ? '❚❚' : '▶';
      this.playBtn.classList.toggle('playing', playing);
      this.playBtn.title = playing ? 'Pausa' : 'Fortsätt';
    }
    this.send({ type: 'run', playing, speed: this.speed });
  }

  /** Slutar följa den valda bilen. */
  clearTrip(): void {
    this.trip = null;
    this.send({ type: 'followVehicle', vehicle: -1 });
    this.panels?.updateVehicle(null);
  }

  private nearestSignal(x: number, y: number, tolerance: number): number {
    let best = -1;
    let bestD = tolerance;
    this.signals.forEach((s) => {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    });
    return best;
  }

  private nearestZone(x: number, y: number): number {
    const zones = this.net?.zones ?? [];
    let best = -1;
    let bestD = Infinity;
    for (const z of zones) {
      const d = (z.x - x) ** 2 + (z.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = z.id;
      }
    }
    return best;
  }

  /** Mikroområdet flyttas när kameran stannat — annars byggs det om vid varje pixel. */
  private scheduleFocus(): void {
    window.clearTimeout(this.focusTimer);
    this.focusTimer = window.setTimeout(() => this.pushFocus(), 220);
  }

  private pushFocus(): void {
    if (!this.state.autoFocus || this.state.fullMicro) return;
    // Lite större än skärmen, så att köer strax utanför bilden också simuleras.
    const radius = Math.min(6000, Math.max(700, this.cam.viewRadius() * 1.35));
    this.send({ type: 'focus', x: this.cam.x, y: this.cam.y, radius, full: false });
  }

  /** Hur mycket av kartans nederkant som täcks av nyckeltalsremsan. */
  private kpiInset(): number {
    const panel = this.kpiRow.getBoundingClientRect();
    const map = this.glCanvas.getBoundingClientRect();
    if (panel.height === 0) return 0;
    return Math.max(0, Math.round(map.bottom - panel.top) + 8);
  }

  private resize(): void {
    const rect = this.glCanvas.parentElement!.getBoundingClientRect();
    const first = !(this.cam.scale > 0);
    this.cam.setViewport(rect.width, rect.height, window.devicePixelRatio || 1);
    // Fick fönstret sin storlek först nu måste kartan ramas in på nytt.
    if (first && this.net && this.cam.width > 0) {
      this.cam.fit(this.net.bounds);
      this.cam.zoomAt(this.cam.width / 2, this.cam.height / 2, 3.2);
      this.pushFocus();
    }
  }

  // --- Presentation ----------------------------------------------------------------------

  private updateKpi(stats: NetworkStats): void {
    this.clockEl.textContent = clockText(stats.hour);
    const cell = (label: string, value: string, tone = ''): HTMLElement =>
      el('div', { class: 'kpi ' + tone }, [
        el('span', { class: 'kpi-value', text: value }),
        el('span', { class: 'kpi-label', text: label }),
      ]);

    const speedKmh = stats.meanSpeed * 3.6;
    const delayShare = stats.meanTripTime > 0 ? stats.meanTripDelay / stats.meanTripTime : 0;
    this.kpiRow.replaceChildren(
      cell('fordon i nätet', nf.format(stats.active)),
      cell('medelhastighet', nf1.format(speedKmh) + ' km/h', speedKmh < 18 ? 'bad' : speedKmh < 28 ? 'warn' : 'good'),
      cell('restid per resa', nf1.format(stats.meanTripTime / 60) + ' min'),
      cell('varav kötid', Math.round(delayShare * 100) + ' %', delayShare > 0.35 ? 'bad' : delayShare > 0.2 ? 'warn' : 'good'),
      cell('förlorade fordonstimmar', nf1.format(stats.totalDelayHours)),
      cell('fordonskilometer', nf.format(stats.vehKm)),
      cell('CO₂', nf1.format(stats.co2Tonnes) + ' t'),
      cell('avslutade resor', nf.format(stats.completed)),
    );
  }

  /** Lägger ihop kartlagret och överlägget till en enda bild och laddar ner den. */
  private exportImage(): void {
    if (!this.map) return;
    this.renderOnce();
    const out = document.createElement('canvas');
    out.width = this.glCanvas.width;
    out.height = this.glCanvas.height;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(this.glCanvas, 0, 0);
    ctx.drawImage(this.overlayCanvas, 0, 0, out.width, out.height);
    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: 'trafiksimulering.png' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.notify('Kartbilden sparad.');
    }, 'image/png');
  }

  private setLoaderText(text: string): void {
    const node = this.loaderEl.querySelector('.loader-text');
    if (node) node.textContent = text;
  }

  private notify(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('visible');
    window.clearTimeout((this.toastEl as unknown as { _t?: number })._t);
    (this.toastEl as unknown as { _t?: number })._t = window.setTimeout(
      () => this.toastEl.classList.remove('visible'), 3600);
  }

  private fail(message: string): void {
    this.loaderEl.classList.remove('hidden');
    this.loaderEl.querySelector('.spinner')?.classList.add('error');
    this.setLoaderText(message);
  }

  // --- Ritslinga --------------------------------------------------------------------------

  private frame(): void {
    this.renderOnce();
    requestAnimationFrame(() => this.frame());
  }

  /** En bildruta. Publik så att den går att anropa från konsolen vid felsökning. */
  renderOnce(): void {
    {
      if (!this.map || !this.overlay || !this.net) return;
      const metricMode =
        this.state.metric === LinkMetric.Class ? 4
        : this.state.metric === LinkMetric.Saturation ? 2
        : this.state.metric === LinkMetric.Queue || this.state.metric === LinkMetric.Delay ? 3
        : 1;

      // Flygbilden ritas först, i sin egen yta bakom vägnätet.
      if (this.satellite && this.tiles) this.tiles.render(this.cam);

      this.map.render(this.cam, {
        mode: metricMode,
        showVehicles: this.state.showVehicles,
        showSignals: this.state.showSignals,
      });
      this.overlay.render(this.cam, {
        selectedLink: this.state.selectedLink,
        hoverLink: this.hoverLink,
        bottlenecks: this.bottlenecks,
        showBottlenecks: this.state.showBottlenecks,
        showZones: this.state.showZones,
        showLabels: this.state.showLabels,
        zones: this.net.zones,
        flows: manualFlows,
        focus: this.state.autoFocus && !this.state.fullMicro
          ? { x: this.cam.x, y: this.cam.y, radius: Math.min(6000, Math.max(700, this.cam.viewRadius() * 1.35)) }
          : null,
        measuring: this.measurePoints,
        bottomInset: this.kpiInset(),
        placeKinds: this.placeKinds,
        credit: this.satellite && this.tiles ? this.tiles.credit : '',
        trip: this.trip
          ? {
              route: this.trip.route,
              x: this.trip.x, y: this.trip.y,
              originX: this.trip.originX, originY: this.trip.originY,
              destX: this.trip.destX, destY: this.trip.destY,
            }
          : null,
      });
      this.buildLegendIfNeeded();
    }
  }

  private lastLegendMetric = -1;
  private buildLegendIfNeeded(): void {
    if (this.lastLegendMetric === this.state.metric) return;
    this.lastLegendMetric = this.state.metric;
    this.buildLegend();
  }
}
