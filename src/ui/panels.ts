/**
 * Sidopanelerna. Varje panel äger en del av verktyget: vy, vald gata, signaler,
 * trafikregler, efterfrågan, flaskhalsar och scenariojämförelse.
 */

import {
  button, clockText, downloadText, el, nf, nf1, note, numberField, row, section, selectField,
  slider, stat, toggle, type SectionHandle, chip, chipRow,} from './dom.ts';
import {
  LinkMetric,
  type Bottleneck, type LinkInfo, type RenderNetwork, type RenderSignal,
  type ScenarioSummary, type ToWorker, type VehicleInfo,
} from '../sim/protocol.ts';
import type { NetworkStats } from '../sim/engine.ts';
import { SignalMode, type Phase } from '../net/signals.ts';
import type { SimConfig } from '../sim/config.ts';

export interface AppState {
  metric: LinkMetric;
  showVehicles: boolean;
  showSignals: boolean;
  showLabels: boolean;
  /** Rita vägnätet. Går att släcka för att se enbart trafiken över en flygbild. */
  showRoads: boolean;
  showZones: boolean;
  showBottlenecks: boolean;
  autoFocus: boolean;
  fullMicro: boolean;
  selectedLink: number;
  selectedSignal: number;
  waveSignals: number[];
  flowMode: boolean;
}

export interface Ui {
  send(msg: ToWorker): void;
  /** Sparar kartan som PNG — underlag till utredningar och presentationer. */
  exportImage(): void;
  net: RenderNetwork;
  signals: RenderSignal[];
  config: SimConfig;
  state: AppState;
  demandTotal: number;
  /** Uppskattad folkmängd, ur bebyggelsen. */
  population: number;
  focusOn(x: number, y: number, scale?: number): void;
  notify(text: string): void;
  /** Slutar följa den valda bilen. */
  clearTrip(): void;
  /** Visar eller döljer en verksamhetsgrupp på kartan. */
  togglePlaceKind(kind: number, on: boolean): void;
  /** Lägger en flygbild under vägnätet. */
  setSatellite(on: boolean): void;
  /** Hoppar till ett klockslag och fyller nätet med trafik för den tiden. */
  setHour(hour: number): void;
}

export interface Panels {
  root: HTMLElement;
  updateLink(info: LinkInfo | null): void;
  updateVehicle(info: VehicleInfo | null): void;
  openVehicle(): void;
  updateSignals(signals: RenderSignal[]): void;
  updateStats(stats: NetworkStats, bottlenecks: Bottleneck[]): void;
  updateScenarios(list: ScenarioSummary[]): void;
  openSignal(id: number): void;
  openLink(): void;
  refreshFlows(): void;
}

export function buildPanels(ui: Ui): Panels {
  const viewPanel = section('Vy och lager', { open: true });
  const vehiclePanel = section('Valt fordon');
  const linkPanel = section('Vald gata');
  const signalPanel = section('Trafiksignaler');
  const rulesPanel = section('Trafikregler och förare');
  const demandPanel = section('Trafikefterfrågan');
  const bottleneckPanel = section('Flaskhalsar', { open: true });
  const scenarioPanel = section('Scenariojämförelse');

  buildViewPanel(ui, viewPanel);
  const vehicleUi = buildVehiclePanel(ui, vehiclePanel);
  const linkUi = buildLinkPanel(ui, linkPanel);
  const signalUi = buildSignalPanel(ui, signalPanel);
  buildRulesPanel(ui, rulesPanel);
  const demandUi = buildDemandPanel(ui, demandPanel);
  const bottleneckUi = buildBottleneckPanel(ui, bottleneckPanel);
  const scenarioUi = buildScenarioPanel(ui, scenarioPanel);

  const root = el('div', { class: 'panels' }, [
    viewPanel.root, vehiclePanel.root, linkPanel.root, signalPanel.root, rulesPanel.root,
    demandPanel.root, bottleneckPanel.root, scenarioPanel.root,
  ]);

  return {
    root,
    updateLink: (info) => {
      linkUi.update(info);
      linkPanel.setBadge(info ? info.name : '');
    },
    updateVehicle: (info) => {
      vehicleUi.update(info);
      vehiclePanel.setBadge(info ? info.typeName : '');
    },
    openVehicle: () => vehiclePanel.open(),
    updateSignals: (signals) => signalUi.update(signals),
    updateStats: (stats, bottlenecks) => {
      bottleneckUi.update(bottlenecks);
      demandUi.update(stats);
      bottleneckPanel.setBadge(bottlenecks.length ? String(bottlenecks.length) : '');
    },
    updateScenarios: (list) => scenarioUi.update(list),
    refreshFlows: () => demandUi.refreshFlows(),
    openSignal: (id) => {
      signalUi.select(id);
      signalPanel.open();
    },
    openLink: () => linkPanel.open(),
  };
}

// --- Vy ---------------------------------------------------------------------------

const METRIC_OPTIONS: { value: LinkMetric; label: string }[] = [
  { value: LinkMetric.Speed, label: 'Framkomlighet (andel av skyltad hastighet)' },
  { value: LinkMetric.Saturation, label: 'Belastningsgrad V/C' },
  { value: LinkMetric.Flow, label: 'Flöde, fordon per timme' },
  { value: LinkMetric.Queue, label: 'Kölängd' },
  { value: LinkMetric.Delay, label: 'Ackumulerad fördröjning' },
  { value: LinkMetric.Class, label: 'Vägklass' },
];

function buildViewPanel(ui: Ui, panel: SectionHandle): void {
  panel.body.append(
    selectField('Färglägg vägnätet efter', METRIC_OPTIONS, ui.state.metric, (v) => {
      ui.state.metric = v;
      ui.send({ type: 'metric', metric: v });
    }),
    toggle('Visa fordon', ui.state.showVehicles, (v) => (ui.state.showVehicles = v)),
    toggle('Visa signaler', ui.state.showSignals, (v) => (ui.state.showSignals = v)),
    toggle('Visa gatunamn', ui.state.showLabels, (v) => (ui.state.showLabels = v)),
    toggle('Flygbild som bakgrund', false, (v) => ui.setSatellite(v)),
    toggle('Visa vägnät', ui.state.showRoads, (v) => (ui.state.showRoads = v)),
    el('h4', { class: 'group-title', text: 'Målpunkter på kartan' }),
    chipRow(...PLACE_KINDS.map((k) => chip(k.label, false, (v) => ui.togglePlaceKind(k.kind, v)))),
    note('Prickens storlek följer hur mycket trafik platsen drar till sig.'),
    toggle('Visa flaskhalsnålar', ui.state.showBottlenecks, (v) => (ui.state.showBottlenecks = v)),
    toggle('Visa trafikzoner', ui.state.showZones, (v) => (ui.state.showZones = v),
      'Där resorna börjar och slutar.'),
    el('hr', { class: 'sep' }),
    toggle('Detaljerad simulering följer kartan', ui.state.autoFocus, (v) => {
      ui.state.autoFocus = v;
      if (!v && ui.state.fullMicro) ui.send({ type: 'focus', x: 0, y: 0, radius: 0, full: true });
    }, 'Fordon för fordon där du tittar, flöden i resten.'),
    toggle('Kör hela nätet fordon för fordon', ui.state.fullMicro, (v) => {
      ui.state.fullMicro = v;
      if (v) ui.send({ type: 'focus', x: 0, y: 0, radius: 0, full: true });
    }, 'Exakt men mycket tyngre.'),
    el('hr', { class: 'sep' }),
    row(button('Spara kartbild (PNG)', () => ui.exportImage(), 'ghost')),
    note('Skift + dra mäter avstånd. Klicka på en gata för att välja den.'),
  );
}

/** Verksamhetsgrupperna som går att visa på kartan. */
const PLACE_KINDS: { kind: number; label: string }[] = [
  { kind: 0, label: 'Handel' },
  { kind: 3, label: 'Utbildning' },
  { kind: 4, label: 'Vård' },
  { kind: 1, label: 'Kontor' },
  { kind: 2, label: 'Industri' },
  { kind: 5, label: 'Övrigt' },
];

// --- Valt fordon --------------------------------------------------------------------

/**
 * Den valda bilens resa.
 *
 * Att kunna följa ett enskilt fordon är inte bara en finess: det är det snabbaste
 * sättet att se om trafikmönstret är rimligt. Kommer bilarna på en villagata
 * någonstans ifrån, eller är de påhittade? Går genomfarten verkligen genom
 * staden? Frågorna besvaras med ett klick.
 */
function buildVehiclePanel(ui: Ui, panel: SectionHandle): {
  update(info: VehicleInfo | null): void;
} {
  const empty = note('Inget fordon valt. Zooma in och klicka på en bil för att se varifrån den kommer och vart den ska.');
  const body = el('div');
  panel.body.append(empty, body);

  return {
    update(info) {
      empty.style.display = info ? 'none' : '';
      if (!info) {
        body.replaceChildren();
        return;
      }
      const minuter = (s: number): string => nf1.format(s / 60) + ' min';
      const km = (m: number): string =>
        m >= 1000 ? nf1.format(m / 1000) + ' km' : nf.format(m) + ' m';
      const kvar = info.remaining > 0 ? km(info.remaining) : 'okänt';
      const andel = info.elapsed > 0 ? info.delaySeconds / info.elapsed : 0;

      body.replaceChildren(
        el('div', { class: 'link-head' }, [
          el('h3', { text: info.typeName }),
          el('span', { class: 'chip', text: info.detailed ? 'fordon för fordon' : 'flödesmodell' }),
        ]),
        el('div', { class: 'trip' }, [
          el('div', { class: 'trip-leg' }, [
            el('span', { class: 'trip-dot from', text: 'A' }),
            el('div', {}, [
              el('span', { class: 'trip-place', text: info.originName }),
              el('span', { class: 'trip-kind', text: info.originCharacter || 'startpunkt' }),
            ]),
          ]),
          el('div', { class: 'trip-line' }),
          el('div', { class: 'trip-leg' }, [
            el('span', { class: 'trip-dot to', text: 'B' }),
            el('div', {}, [
              el('span', { class: 'trip-place', text: info.destName }),
              el('span', { class: 'trip-kind', text: info.destCharacter || 'målpunkt' }),
            ]),
          ]),
        ]),
        el('div', { class: 'stats' }, [
          stat('kör på', info.onStreet),
          stat('hastighet', nf.format(info.speedKmh) + ' km/h'),
          stat('restid', minuter(info.elapsed)),
          stat('kört', km(info.travelled)),
          stat('kvar', kvar),
          stat('kötid', minuter(info.delaySeconds), andel > 0.4 ? 'bad' : andel > 0.2 ? 'warn' : 'good'),
          stat('stopp', String(info.stops)),
          stat('gatutyp', info.streetClass),
        ]),
        row(
          button('Följ i kartan', () => ui.focusOn(info.x, info.y, 1.2)),
          button('Sluta följa', () => ui.clearTrip(), 'ghost'),
        ),
        note('Den blå linjen visar bilens valda väg. A är där resan började, B är målet.'),
      );
    },
  };
}

// --- Vald gata ---------------------------------------------------------------------

function buildLinkPanel(ui: Ui, panel: SectionHandle): { update(info: LinkInfo | null): void } {
  const empty = note('Ingen gata vald. Klicka på en gata i kartan.');
  const body = el('div');
  panel.body.append(empty, body);

  return {
    update(info) {
      empty.style.display = info ? 'none' : '';
      body.replaceChildren();
      if (!info) return;

      body.append(
        el('div', { class: 'link-head' }, [
          el('h3', { text: info.name }),
          el('span', { class: 'chip', text: info.className }),
        ]),
        el('div', { class: 'stats' }, [
          stat('körfält', String(info.lanes)),
          stat('skyltat', info.speedKmh + ' km/h'),
          stat('längd', nf.format(info.lengthM) + ' m'),
          stat('flöde', nf.format(info.flow) + '/h'),
          stat('V/C', nf1.format(info.saturation * 100) + ' %', info.saturation > 0.9 ? 'bad' : info.saturation > 0.7 ? 'warn' : 'good'),
          stat('uppmätt', nf.format(info.meanSpeedKmh) + ' km/h',
            info.meanSpeedKmh < info.speedKmh * 0.4 ? 'bad' : info.meanSpeedKmh < info.speedKmh * 0.75 ? 'warn' : 'good'),
          stat('kö', nf.format(info.queue) + ' fordon'),
          stat('fördröjning', nf1.format(info.delayHours) + ' fh'),
        ]),
        el('hr', { class: 'sep' }),
        numberField('Antal körfält', info.lanes, (v) => {
          ui.send({ type: 'setLanes', link: info.link, lanes: v });
          if (info.reverse >= 0) ui.send({ type: 'setLanes', link: info.reverse, lanes: v });
        }, { min: 1, max: 6, hint: 'Ändras åt båda hållen om gatan är dubbelriktad.' }),
        numberField('Hastighetsgräns', info.speedKmh, (v) => {
          ui.send({ type: 'setSpeed', link: info.link, kmh: v });
          if (info.reverse >= 0) ui.send({ type: 'setSpeed', link: info.reverse, kmh: v });
        }, { min: 5, max: 120, step: 5, unit: 'km/h' }),
        row(
          button(info.closed ? 'Öppna gatan igen' : 'Stäng av gatan', () => {
            ui.send({ type: 'closeLink', link: info.link, closed: !info.closed });
          }, info.closed ? 'ghost' : 'danger'),
        ),
        note(info.closed
          ? 'Gatan är avstängd. Trafiken söker nya vägar allteftersom ruttvalen räknas om.'
          : 'Avstängningen gäller båda riktningarna och slår igenom i ruttvalet inom någon minut simulerad tid.'),
      );
    },
  };
}

// --- Signaler -----------------------------------------------------------------------

function buildSignalPanel(ui: Ui, panel: SectionHandle): {
  update(signals: RenderSignal[]): void;
  select(id: number): void;
} {
  let signals = ui.signals;
  let selected = -1;
  const editor = el('div');
  const waveBox = el('div', { class: 'wave-box' });
  let waveSpeed = 40;

  const renderWave = (): void => {
    waveBox.replaceChildren(
      el('div', { class: 'field-head' }, [
        el('span', { text: 'Grön våg' }),
        el('span', { class: 'field-value', text: ui.state.waveSignals.length + ' valda' }),
      ]),
      note('Ctrl-klicka signaler längs ett stråk i ordning, ange önskad hastighet och skapa vågen.'),
      slider('Progressionshastighet', {
        min: 20, max: 80, step: 5, value: waveSpeed, unit: ' km/h',
        onChange: (v) => (waveSpeed = v),
      }),
      row(
        button('Skapa grön våg', () => {
          if (ui.state.waveSignals.length < 2) {
            ui.notify('Välj minst två signaler längs stråket med ctrl-klick.');
            return;
          }
          ui.send({ type: 'greenWave', ids: [...ui.state.waveSignals], speedKmh: waveSpeed });
          ui.notify('Grön våg satt för ' + ui.state.waveSignals.length + ' anläggningar.');
        }),
        button('Rensa val', () => {
          ui.state.waveSignals = [];
          renderWave();
        }, 'ghost'),
      ),
    );
  };

  const renderEditor = (): void => {
    editor.replaceChildren();
    const sig = signals.find((s) => s.id === selected);
    if (!sig) {
      editor.append(note('Ingen signalanläggning vald. Klicka på en signalpunkt i kartan.'));
      return;
    }

    const phases = sig.phases.map((p) => ({ ...p, groups: [...p.groups] }));
    const push = (): void => {
      ui.send({
        type: 'signalPlan', id: sig.id, phases,
        offset: sig.offset, mode: sig.mode, gapOut: sig.gapOut,
      });
    };

    const cycleReadout = el('span', { class: 'field-value' });
    const refreshCycle = (): void => {
      const total = phases.reduce((s, p) => s + p.green + p.amber + p.allRed + 1, 0);
      cycleReadout.textContent = Math.round(total) + ' s cykeltid';
    };
    refreshCycle();

    editor.append(
      el('div', { class: 'link-head' }, [
        el('h3', { text: sig.name }),
        el('span', { class: 'chip', text: phases.length + ' faser' }),
      ]),
      el('div', { class: 'field-head' }, [el('span', { text: 'Anläggning' }), cycleReadout]),
      selectField('Styrsätt', [
        { value: SignalMode.Fixed, label: 'Fast tidsstyrning' },
        { value: SignalMode.Actuated, label: 'Trafikstyrd (detektorer)' },
      ], sig.mode, (v) => {
        sig.mode = v;
        push();
      }),
      slider('Förskjutning mot nätets klocka', {
        min: 0, max: 120, step: 1, value: Math.round(sig.offset), unit: ' s',
        hint: 'Grunden för samordning mellan korsningar.',
        onChange: (v) => {
          sig.offset = v;
          push();
        },
      }),
      slider('Luckkrav för att avsluta grönt', {
        min: 1, max: 8, step: 0.5, value: sig.gapOut, unit: ' s',
        hint: 'Gäller trafikstyrning: grönt släpps när luckan blir så här stor.',
        onChange: (v) => {
          sig.gapOut = v;
          push();
        },
      }),
      el('hr', { class: 'sep' }),
    );

    phases.forEach((phase: Phase, i: number) => {
      editor.append(
        el('div', { class: 'phase' }, [
          el('div', { class: 'phase-head' }, [
            el('span', { class: 'phase-dot' }),
            el('span', { text: 'Fas ' + (i + 1) }),
            el('span', { class: 'field-value', text: phase.groups.length + ' signalgrupper' }),
          ]),
          slider('Grönt', {
            min: 5, max: 90, step: 1, value: Math.round(phase.green), unit: ' s',
            onChange: (v) => {
              phase.green = v;
              refreshCycle();
              push();
            },
          }),
          slider('Gult', {
            min: 2, max: 6, step: 0.5, value: phase.amber, unit: ' s',
            onChange: (v) => {
              phase.amber = v;
              refreshCycle();
              push();
            },
          }),
          slider('Rött mellan faser', {
            min: 0, max: 6, step: 0.5, value: phase.allRed, unit: ' s',
            hint: i === phases.length - 1 ? 'Utrymningstid innan nästa fas släpps fram.' : undefined,
            onChange: (v) => {
              phase.allRed = v;
              refreshCycle();
              push();
            },
          }),
        ]),
      );
    });
  };

  panel.body.append(
    row(
      button('Optimera alla signaler', () => {
        ui.send({ type: 'signalOptimise', ids: [] });
        ui.notify('Signaltiderna omfördelade efter uppmätta flöden (Websters metod).');
      }),
    ),
    note('Optimeringen använder de flöden simuleringen mätt upp hittills — låt den köra en stund först.'),
    el('hr', { class: 'sep' }),
    waveBox,
    el('hr', { class: 'sep' }),
    editor,
  );
  renderWave();
  renderEditor();

  return {
    update(next) {
      signals = next;
      ui.signals = next;
      renderEditor();
      renderWave();
    },
    select(id) {
      selected = id;
      renderEditor();
      renderWave();
    },
  };
}

// --- Trafikregler --------------------------------------------------------------------

function buildRulesPanel(ui: Ui, panel: SectionHandle): void {
  const c = ui.config;
  const set = <K extends keyof SimConfig>(key: K, value: SimConfig[K]): void => {
    (c as unknown as Record<string, unknown>)[key as string] = value;
    ui.send({ type: 'config', patch: { [key]: value } as Partial<SimConfig> });
  };

  panel.body.append(
    el('h4', { class: 'group-title', text: 'Förarbeteende' }),
    slider('Önskad tidslucka', {
      min: 0.6, max: 2.5, step: 0.1, value: c.timeHeadway, unit: ' s',
      hint: 'Kortare lucka ger högre kapacitet men känsligare trafik.',
      format: (v) => v.toFixed(1),
      onChange: (v) => set('timeHeadway', v),
    }),
    slider('Minsta avstånd i kö', {
      min: 1, max: 5, step: 0.25, value: c.minGap, unit: ' m',
      format: (v) => v.toFixed(2),
      onChange: (v) => set('minGap', v),
    }),
    slider('Hastighetsefterlevnad', {
      min: 0.85, max: 1.2, step: 0.01, value: c.speedCompliance,
      hint: '1,00 = kör precis skyltad hastighet.',
      format: (v) => v.toFixed(2),
      onChange: (v) => set('speedCompliance', v),
    }),
    slider('Spridning mellan förare', {
      min: 0, max: 0.3, step: 0.01, value: c.speedVariation,
      format: (v) => Math.round(v * 100) + ' %',
      onChange: (v) => set('speedVariation', v),
    }),
    slider('Otålighet', {
      min: 0, max: 0.2, step: 0.01, value: c.impatience,
      hint: 'Hur snabbt en väntande förare börjar acceptera mindre luckor.',
      format: (v) => v.toFixed(2),
      onChange: (v) => set('impatience', v),
    }),

    el('h4', { class: 'group-title', text: 'Väjningsregler' }),
    slider('Kritisk lucka vid väjningsplikt', {
      min: 3, max: 9, step: 0.25, value: c.giveWayGap, unit: ' s',
      format: (v) => v.toFixed(2),
      onChange: (v) => set('giveWayGap', v),
    }),
    slider('Vänstersväng mot mötande', {
      min: 3, max: 9, step: 0.25, value: c.leftTurnGap, unit: ' s',
      format: (v) => v.toFixed(2),
      onChange: (v) => set('leftTurnGap', v),
    }),
    slider('Infart i cirkulationsplats', {
      min: 2, max: 7, step: 0.25, value: c.roundaboutGap, unit: ' s',
      format: (v) => v.toFixed(2),
      onChange: (v) => set('roundaboutGap', v),
    }),
    slider('Stopptid vid stopplikt', {
      min: 0, max: 4, step: 0.25, value: c.stopSignDwell, unit: ' s',
      format: (v) => v.toFixed(2),
      onChange: (v) => set('stopSignDwell', v),
    }),
    slider('Andel som kör på gult', {
      min: 0, max: 0.7, step: 0.05, value: c.amberRunning,
      format: (v) => Math.round(v * 100) + ' %',
      onChange: (v) => set('amberRunning', v),
    }),
    toggle('Förbud mot att blockera korsning', c.blockingRule, (v) => set('blockingRule', v),
      'Avstängt låter fordon köra in i korsningar de inte kan lämna — då sprider sig köerna snabbt.'),
    slider('Hastighetsgränser överlag', {
      min: -30, max: 30, step: 5, value: c.speedLimitDelta, unit: ' km/h',
      hint: 'Höjer eller sänker alla skyltade hastigheter på en gång.',
      onChange: (v) => set('speedLimitDelta', v),
    }),

    el('h4', { class: 'group-title', text: 'Fordonsmix' }),
    slider('Lastbilar', {
      min: 0, max: 0.3, step: 0.01, value: c.truckShare,
      format: (v) => Math.round(v * 100) + ' %',
      onChange: (v) => set('truckShare', v),
    }),
    slider('Bussar', {
      min: 0, max: 0.1, step: 0.005, value: c.busShare,
      format: (v) => (v * 100).toFixed(1) + ' %',
      onChange: (v) => set('busShare', v),
    }),
    slider('Skåpbilar', {
      min: 0, max: 0.3, step: 0.01, value: c.vanShare,
      format: (v) => Math.round(v * 100) + ' %',
      onChange: (v) => set('vanShare', v),
    }),
  );
}

// --- Efterfrågan ----------------------------------------------------------------------

function buildDemandPanel(ui: Ui, panel: SectionHandle): {
  update(stats: NetworkStats): void;
  refreshFlows(): void;
} {
  const c = ui.config;
  const liveRow = el('div', { class: 'stats' });
  const flowList = el('div', { class: 'flow-list' });

  const renderFlows = (): void => {
    flowList.replaceChildren();
    if (manualFlows.length === 0) {
      flowList.append(note('Inga egna flöden. Slå på "Rita eget flöde" och klicka på två punkter i kartan.'));
      return;
    }
    manualFlows.forEach((f) => {
      flowList.append(
        el('div', { class: 'flow-item' }, [
          el('span', { class: 'flow-name', text: f.name }),
          el('input', {
            class: 'num small', type: 'number', value: f.vehiclesPerHour, min: 0, step: 50,
            onchange: (e: Event) => {
              f.vehiclesPerHour = Number((e.target as HTMLInputElement).value);
              ui.send({ type: 'manualFlow', flow: f });
            },
          }),
          el('span', { class: 'field-hint', text: 'f/h' }),
          button('✕', () => {
            const i = manualFlows.indexOf(f);
            if (i >= 0) manualFlows.splice(i, 1);
            ui.send({ type: 'removeFlow', id: f.id });
            renderFlows();
          }, 'ghost tiny'),
        ]),
      );
    });
  };

  panel.body.append(
    liveRow,
    el('hr', { class: 'sep' }),
    note(`Efterfrågan är räknad ur bebyggelsen: ${nf.format(ui.population)} invånare i ` +
      'byggnadernas våningsyta, resor per invånare, en bilandel som sjunker med tätheten, ' +
      'och ledtrafik skattad ur infarternas kapacitet. Jämför folkmängden med den verkliga ' +
      'för att se om nivån är rimlig.'),
    numberField('Resor per dygn', Math.round(ui.demandTotal), (v) => {
      ui.demandTotal = v;
      ui.send({ type: 'demand', patch: { totalTrips: v } });
    }, { min: 1000, step: 5000, hint: 'Uppskattat ur markanvändningen. Ersätt med kommunens siffra om du har den.' }),
    slider('Skala hela efterfrågan', {
      min: 0.2, max: 2.5, step: 0.05, value: c.demandScale,
      hint: 'Testa framtida trafikökning: 1,25 = 25 % mer trafik.',
      format: (v) => v.toFixed(2) + '×',
      onChange: (v) => {
        c.demandScale = v;
        ui.send({ type: 'config', patch: { demandScale: v } });
      },
    }),
    el('hr', { class: 'sep' }),
    el('h4', { class: 'group-title', text: 'Egna flöden' }),
    toggle('Rita eget flöde', ui.state.flowMode, (v) => {
      ui.state.flowMode = v;
      ui.notify(v ? 'Klicka på startpunkt och sedan målpunkt i kartan.' : 'Ritläget avstängt.');
    }),
    flowList,
    el('hr', { class: 'sep' }),
    el('h4', { class: 'group-title', text: 'OD-matris' }),
    note('Importera kommunens resmatris som CSV: från,till,fordon_per_dygn — antingen zonnamn eller koordinater (lat,lon,lat,lon,antal).'),
    row(
      el('label', { class: 'btn ghost file-btn' }, [
        'Importera CSV',
        el('input', {
          type: 'file', accept: '.csv,.txt', hidden: true,
          onchange: (e: Event) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            void file.text().then((csv) => ui.send({ type: 'importOd', csv }));
          },
        }),
      ]),
      button('Exportera CSV', () => ui.send({ type: 'exportOd' }), 'ghost'),
    ),
  );
  renderFlows();

  return {
    refreshFlows: renderFlows,
    update(stats) {
      liveRow.replaceChildren(
        stat('klockan', clockText(stats.hour)),
        stat('efterfrågan nu', nf.format(stats.spawnRate) + '/h'),
        stat('fordon i nätet', nf.format(stats.active)),
        // Fordon som inte fick plats i nätet respektive som saknade väg vidare
        // hör till modellens ärlighet — de ska synas, inte döljas.
        stats.blockedSpawns + stats.lost > 0
          ? stat('ej insläppta / utan väg', nf.format(stats.blockedSpawns) + ' / ' + nf.format(stats.lost),
              stats.lost > 50 ? 'warn' : '')
          : stat('avslutade resor', nf.format(stats.completed)),
      );
    },
  };
}

/** Handritade flöden lever i modulen så panelen och kartan ser samma lista. */
export const manualFlows: { id: number; name: string; fromZone: number; toZone: number; vehiclesPerHour: number; active: boolean }[] = [];

// --- Flaskhalsar -----------------------------------------------------------------------

function buildBottleneckPanel(ui: Ui, panel: SectionHandle): { update(list: Bottleneck[]): void } {
  const list = el('div', { class: 'bottleneck-list' });
  panel.body.append(
    note('Rangordnat efter hur många fordonstimmar som går förlorade på sträckan. Klicka för att zooma dit.'),
    list,
  );
  return {
    update(items) {
      list.replaceChildren();
      if (items.length === 0) {
        list.append(note('Inga betydande fördröjningar uppmätta ännu.'));
        return;
      }
      items.slice(0, 12).forEach((b, i) => {
        const ratio = b.freeSpeedKmh > 0 ? b.meanSpeedKmh / b.freeSpeedKmh : 1;
        const tone = ratio < 0.35 ? 'bad' : ratio < 0.65 ? 'warn' : 'good';
        list.append(
          el('button', {
            class: 'bottleneck ' + tone, type: 'button',
            onclick: () => {
              ui.focusOn(b.x, b.y, 0.25);
              ui.state.selectedLink = b.link;
              ui.send({ type: 'inspect', link: b.link });
            },
          }, [
            el('span', { class: 'rank', text: String(i + 1) }),
            el('span', { class: 'bn-main' }, [
              el('span', { class: 'bn-name', text: b.name }),
              el('span', { class: 'bn-sub', text: `${b.className} · ${nf.format(b.meanSpeedKmh)} av ${nf.format(b.freeSpeedKmh)} km/h · kö ${nf.format(b.queue)}` }),
            ]),
            el('span', { class: 'bn-value', text: nf1.format(b.delayHours) + ' fh' }),
          ]),
        );
      });
    },
  };
}

// --- Scenarier ---------------------------------------------------------------------------

function buildScenarioPanel(ui: Ui, panel: SectionHandle): { update(list: ScenarioSummary[]): void } {
  const table = el('div', { class: 'scenario-table' });
  panel.body.append(
    note('Spara ett mätvärde när simuleringen fått stabilisera sig, gör din ändring, låt den gå lika länge och spara igen. Skillnaden är effekten av åtgärden.'),
    row(
      button('Spara mätpunkt', () => ui.send({ type: 'snapshot' })),
      button('Starta om simuleringen', () => ui.send({ type: 'reset' }), 'ghost'),
    ),
    table,
  );

  return {
    update(list) {
      table.replaceChildren();
      if (list.length === 0) return;
      const base = list[0];
      list.forEach((s, i) => {
        const delta = (a: number, b: number): string => {
          if (i === 0) return '—';
          const d = ((a - b) / Math.max(Math.abs(b), 1e-6)) * 100;
          return (d >= 0 ? '+' : '') + nf1.format(d) + ' %';
        };
        table.append(
          el('div', { class: 'scenario-row' }, [
            el('div', { class: 'scenario-name', text: s.name + ' · ' + nf.format(s.simMinutes) + ' min' }),
            el('div', { class: 'scenario-metrics' }, [
              metricCell('medelhastighet', nf1.format(s.stats.meanSpeed * 3.6) + ' km/h', delta(s.stats.meanSpeed, base.stats.meanSpeed), true),
              metricCell('fördröjning', nf1.format(s.stats.totalDelayHours) + ' fh', delta(s.stats.totalDelayHours, base.stats.totalDelayHours), false),
              metricCell('restid/resa', nf1.format(s.stats.meanTripTime / 60) + ' min', delta(s.stats.meanTripTime, base.stats.meanTripTime), false),
              metricCell('CO₂', nf1.format(s.stats.co2Tonnes) + ' t', delta(s.stats.co2Tonnes, base.stats.co2Tonnes), false),
            ]),
          ]),
        );
      });
    },
  };
}

function metricCell(label: string, value: string, delta: string, higherIsBetter: boolean): HTMLElement {
  let tone = '';
  if (delta !== '—') {
    const positive = delta.startsWith('+');
    tone = positive === higherIsBetter ? 'good' : 'bad';
  }
  return el('div', { class: 'scenario-metric' }, [
    el('span', { class: 'sm-label', text: label }),
    el('span', { class: 'sm-value', text: value }),
    el('span', { class: 'sm-delta ' + tone, text: delta }),
  ]);
}

export { downloadText };
