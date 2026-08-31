/** Små byggstenar för gränssnittet. Inget ramverk — panelerna är få och statiska. */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export interface SectionHandle {
  root: HTMLElement;
  body: HTMLElement;
  setBadge(text: string): void;
  open(): void;
}

export function section(title: string, opts: { open?: boolean; badge?: string } = {}): SectionHandle {
  const body = el('div', { class: 'panel-body' });
  const badge = el('span', { class: 'panel-badge', text: opts.badge ?? '' });
  const chevron = el('span', { class: 'panel-chevron', text: '›' });
  const head = el('button', { class: 'panel-head', type: 'button' }, [
    el('span', { class: 'panel-title', text: title }),
    badge,
    chevron,
  ]);
  const root = el('section', { class: 'panel' }, [head, body]);
  const setOpen = (v: boolean): void => {
    root.classList.toggle('open', v);
  };
  head.addEventListener('click', () => setOpen(!root.classList.contains('open')));
  setOpen(opts.open ?? false);
  return {
    root,
    body,
    setBadge: (text) => (badge.textContent = text),
    open: () => setOpen(true),
  };
}

export interface SliderOptions {
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  hint?: string;
  format?: (v: number) => string;
  onChange: (value: number) => void;
}

export function slider(label: string, opts: SliderOptions): HTMLElement {
  const fmt = opts.format ?? ((v: number) => String(v));
  const readout = el('span', { class: 'field-value', text: fmt(opts.value) + (opts.unit ?? '') });
  const input = el('input', {
    type: 'range',
    min: opts.min,
    max: opts.max,
    step: opts.step,
    value: opts.value,
    oninput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      readout.textContent = fmt(v) + (opts.unit ?? '');
      opts.onChange(v);
    },
  });
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-head' }, [el('span', { text: label }), readout]),
    input,
    opts.hint ? el('span', { class: 'field-hint', text: opts.hint }) : null,
  ]);
}

export function numberField(
  label: string,
  value: number,
  onChange: (v: number) => void,
  opts: { min?: number; max?: number; step?: number; unit?: string; hint?: string } = {},
): HTMLElement {
  const input = el('input', {
    class: 'num',
    type: 'number',
    value,
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 1,
    onchange: (e: Event) => onChange(Number((e.target as HTMLInputElement).value)),
  });
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-head' }, [el('span', { text: label }), opts.unit ? el('span', { class: 'field-value', text: opts.unit }) : null]),
    input,
    opts.hint ? el('span', { class: 'field-hint', text: opts.hint }) : null,
  ]);
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void, hint?: string): HTMLElement {
  const input = el('input', {
    type: 'checkbox',
    checked: value,
    onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
  });
  return el('label', { class: 'switch' }, [
    input,
    el('span', { class: 'switch-track' }, [el('span', { class: 'switch-knob' })]),
    el('span', { class: 'switch-label' }, [
      el('span', { text: label }),
      hint ? el('span', { class: 'field-hint', text: hint }) : null,
    ]),
  ]);
}

export function selectField<T extends string | number>(
  label: string,
  options: { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
): HTMLElement {
  const select = el('select', {
    class: 'select',
    onchange: (e: Event) => {
      const raw = (e.target as HTMLSelectElement).value;
      const match = options.find((o) => String(o.value) === raw);
      if (match) onChange(match.value);
    },
  }, options.map((o) => el('option', { value: String(o.value), selected: o.value === value, text: o.label })));
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-head' }, [el('span', { text: label })]),
    select,
  ]);
}

export function button(label: string, onClick: () => void, variant = ''): HTMLButtonElement {
  return el('button', { class: 'btn ' + variant, type: 'button', onclick: onClick, text: label });
}

export function row(...children: (Node | null)[]): HTMLElement {
  return el('div', { class: 'row' }, children);
}

export function stat(label: string, value: string, tone = ''): HTMLElement {
  return el('div', { class: 'stat ' + tone }, [
    el('span', { class: 'stat-value', text: value }),
    el('span', { class: 'stat-label', text: label }),
  ]);
}

export function note(text: string): HTMLElement {
  return el('p', { class: 'note', text });
}

/** Svenska tusentalsavgränsare i hela gränssnittet. */
export const nf = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 });
export const nf1 = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 });

export function clockText(hour: number): string {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour % 1) * 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
