const BAND_LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

const FLAT = {
  bass: 0, bassFreq: 90, treble: 0, clarity: 0,
  eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  width: 100, reverb: 0, echo: 0, compressor: 0
};

const DEFAULTS = {
  ...FLAT,
  preset: 'clean',
  bass: 45, clarity: 10, treble: 1,
  volume: 100, subsonic: true, limiter: true
};

const PRESETS = [
  { id: 'flat', name: 'Flat', values: {} },
  { id: 'clean', name: 'Clean', values: { bass: 45, bassFreq: 90, treble: 1, clarity: 10 } },
  { id: 'deep', name: 'Deep', values: { bass: 80, bassFreq: 60, eq: [3, 3, 2, 0, 0, 0, 0, 0, 0, 0] } },
  { id: 'punch', name: 'Punch', values: { bass: 55, bassFreq: 110, clarity: 20, compressor: 30, eq: [0, 1, 2, 1, 0, 0, 1, 1, 0, 0] } },
  { id: 'vocal', name: 'Vocal', values: { bass: 8, bassFreq: 100, treble: 2, clarity: 55, eq: [-2, -2, -1, 0, 1, 2, 2, 1, 0, 0] } },
  { id: 'bright', name: 'Bright', values: { bass: 12, treble: 5, clarity: 25, eq: [0, 0, 0, 0, 0, 0, 1, 2, 3, 3] } },
  { id: 'cinema', name: 'Cinema', values: { bass: 50, bassFreq: 80, clarity: 15, width: 150, reverb: 18, compressor: 25 } },
  { id: 'night', name: 'Night', values: { bass: 25, bassFreq: 100, clarity: 10, compressor: 70 } }
];

const SOUND = [
  { key: 'bass', label: 'Bass boost', min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
  { key: 'bassFreq', label: 'Bass frequency', min: 40, max: 200, step: 1, fmt: (v) => `${v} Hz` },
  { key: 'treble', label: 'Treble', min: -10, max: 10, step: 0.5, bipolar: true, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` },
  { key: 'clarity', label: 'Vocal clarity', min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
  { key: 'volume', label: 'Volume', min: 0, max: 200, step: 1, fmt: (v) => `${v}%` }
];

const FX = [
  { key: 'width', label: 'Stereo width', min: 0, max: 200, step: 1, fmt: (v) => (v === 0 ? 'Mono' : `${v}%`) },
  { key: 'reverb', label: 'Reverb', min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
  { key: 'echo', label: 'Echo', min: 0, max: 100, step: 1, fmt: (v) => `${v}%` },
  { key: 'compressor', label: 'Compressor', min: 0, max: 100, step: 1, fmt: (v) => `${v}%` }
];

const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const msg = (m) => chrome.runtime.sendMessage(m);

const state = {
  settings: structuredClone(DEFAULTS),
  tab: null,
  supported: false,
  active: false
};

const controls = {};   // key -> { set(value) }
const eqControls = [];

/* Slider */

function createSlider({ min, max, step = 1, value, def, bipolar = false, vertical = false, label, onInput }) {
  const el = document.createElement('div');
  el.className = `sl ${vertical ? 'v' : 'h'}`;
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-valuemin', min);
  el.setAttribute('aria-valuemax', max);
  if (vertical) el.setAttribute('aria-orientation', 'vertical');
  el.innerHTML = '<div class="rail"><i class="fill"></i><i class="thumb"></i></div>';
  const rail = $('.rail', el);

  const snap = (v) => clamp(Math.round((v - min) / step) * step + min, min, max);

  function render(v) {
    value = v;
    const p = (v - min) / (max - min);
    const zero = bipolar ? (0 - min) / (max - min) : 0;
    el.style.setProperty('--p', p);
    el.style.setProperty('--a', Math.min(p, zero));
    el.style.setProperty('--b', Math.max(p, zero));
    el.setAttribute('aria-valuenow', v);
  }

  function commit(v) {
    v = snap(v);
    if (v === value) return;
    render(v);
    onInput(v);
  }

  function fromPointer(e) {
    const r = rail.getBoundingClientRect();
    const p = vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    commit(min + clamp(p, 0, 1) * (max - min));
  }

  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    el.focus();
    fromPointer(e);
  });
  el.addEventListener('pointermove', (e) => {
    if (el.hasPointerCapture(e.pointerId)) fromPointer(e);
  });
  el.addEventListener('dblclick', () => commit(def));
  el.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 10 : 1;
    const moves = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    if (e.key in moves) commit(value + moves[e.key] * step * big);
    else if (e.key === 'Home') commit(min);
    else if (e.key === 'End') commit(max);
    else return;
    e.preventDefault();
  });

  render(snap(value));
  return { el, set: (v) => render(snap(v)) };
}

/* Settings sync */

let saveTimer = 0;
let pushQueued = false;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ settings: state.settings }), 200);
}

function push() {
  persist();
  if (pushQueued) return;
  pushQueued = true;
  requestAnimationFrame(() => {
    pushQueued = false;
    if (state.active) msg({ target: 'offscreen', type: 'apply', settings: state.settings }).catch(() => {});
  });
}

function markCustom() {
  if (state.settings.preset === 'custom') return;
  state.settings.preset = 'custom';
  renderPresets();
}

/* Build UI */

function buildRows(container, defs) {
  for (const d of defs) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div class="row-h"><span class="lbl">${d.label}</span><output></output></div>`;
    const out = $('output', row);
    const show = (v) => { out.textContent = d.fmt(v); };
    const slider = createSlider({
      ...d,
      value: state.settings[d.key],
      def: DEFAULTS[d.key],
      onInput(v) {
        state.settings[d.key] = v;
        show(v);
        if (d.key !== 'volume') markCustom();
        push();
      }
    });
    row.append(slider.el);
    container.append(row);
    show(state.settings[d.key]);
    controls[d.key] = { set(v) { slider.set(v); show(v); } };
  }
}

function buildSwitch(container, key, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sw';
  b.innerHTML = `<span>${label}</span><span class="knob"></span>`;
  b.setAttribute('aria-pressed', state.settings[key]);
  b.addEventListener('click', () => {
    state.settings[key] = !state.settings[key];
    b.setAttribute('aria-pressed', state.settings[key]);
    push();
  });
  container.append(b);
  controls[key] = { set(v) { b.setAttribute('aria-pressed', v); } };
}

function buildEq() {
  const wrap = $('#eq-bands');
  BAND_LABELS.forEach((hz, i) => {
    const band = document.createElement('div');
    band.className = 'eq-band';
    band.innerHTML = '<output></output>';
    const out = $('output', band);
    const show = (v) => { out.textContent = v > 0 ? `+${v}` : `${v}`; };
    const slider = createSlider({
      min: -12, max: 12, step: 1, bipolar: true, vertical: true,
      value: state.settings.eq[i], def: 0, label: `${hz} Hz`,
      onInput(v) {
        state.settings.eq[i] = v;
        show(v);
        markCustom();
        push();
      }
    });
    band.append(slider.el);
    band.insertAdjacentHTML('beforeend', `<span class="hz">${hz}</span>`);
    wrap.append(band);
    show(state.settings.eq[i]);
    eqControls.push({ set(v) { slider.set(v); show(v); } });
  });

  $('#eq-reset').addEventListener('click', () => {
    state.settings.eq = FLAT.eq.slice();
    eqControls.forEach((c) => c.set(0));
    markCustom();
    push();
  });
}

function renderPresets() {
  const wrap = $('#presets');
  wrap.querySelectorAll('.chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', chip.dataset.id === state.settings.preset);
  });
}

function buildPresets() {
  const wrap = $('#presets');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.id = p.id;
    b.textContent = p.name;
    b.addEventListener('click', () => applyPreset(p));
    wrap.append(b);
  }
  renderPresets();
}

function applyPreset(p) {
  Object.assign(state.settings, structuredClone(FLAT), structuredClone(p.values), { preset: p.id });
  for (const key of Object.keys(controls)) controls[key].set(state.settings[key]);
  eqControls.forEach((c, i) => c.set(state.settings.eq[i]));
  renderPresets();
  push();
}

function buildTabs() {
  const tabs = document.querySelectorAll('.tabs button');
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabs.forEach((t) => {
        const on = t === btn;
        t.setAttribute('aria-selected', on);
        $(`#tab-${t.dataset.tab}`).hidden = !on;
      });
    });
  });
}

/* Power and status */

function renderStatus(error) {
  const sub = $('#sub');
  const power = $('#power');
  power.setAttribute('aria-pressed', state.active);
  power.disabled = !state.supported;
  power.title = state.active ? 'Disable on this tab' : 'Enable on this tab';
  sub.classList.toggle('error', Boolean(error));

  if (error) sub.textContent = error;
  else if (!state.supported) sub.textContent = 'Not available on this page';
  else {
    let host = '';
    try { host = new URL(state.tab.url).hostname; } catch { /* file or unknown */ }
    sub.textContent = `${state.active ? 'Active' : 'Off'}${host ? ` on ${host}` : ''}`;
  }
}

async function togglePower() {
  if (!state.supported) return;
  try {
    if (state.active) {
      await msg({ target: 'offscreen', type: 'stop', tabId: state.tab.id });
      state.active = false;
    } else {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: state.tab.id });
      const res = await msg({ target: 'background', type: 'start', tabId: state.tab.id, streamId, settings: state.settings });
      if (!res?.ok) throw new Error(res?.error || 'Could not start audio capture');
      state.active = true;
    }
    renderStatus();
  } catch (e) {
    renderStatus(String(e.message || e).slice(0, 60));
  }
}

async function init() {
  const stored = await chrome.storage.local.get('settings');
  if (stored.settings) {
    state.settings = { ...structuredClone(DEFAULTS), ...stored.settings };
    state.settings.eq = DEFAULTS.eq.map((_, i) => Number(stored.settings.eq?.[i]) || 0);
  }

  buildPresets();
  buildRows($('#tab-sound'), SOUND);
  const sw1 = document.createElement('div');
  sw1.className = 'switches';
  buildSwitch(sw1, 'subsonic', 'Subsonic filter');
  buildSwitch(sw1, 'limiter', 'Peak limiter');
  $('#tab-sound').append(sw1);
  buildEq();
  buildRows($('#tab-fx'), FX);
  buildTabs();
  $('#power').addEventListener('click', togglePower);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  state.supported = Boolean(tab?.id && /^(https?|file):/.test(tab.url || ''));
  if (state.supported) {
    try {
      const res = await msg({ target: 'offscreen', type: 'status', tabId: tab.id });
      state.active = Boolean(res?.active);
    } catch {
      state.active = false;
    }
  }
  renderStatus();
  startViz();
}

/* Spectrum */

function startViz() {
  const canvas = $('#viz');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.scale(dpr, dpr);

  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const accent = color('--accent');
  const dim = color('--surface-2');
  const cap = color('--text');
  const muted = color('--muted');

  const N = 40;
  const PAD = 10;
  const GAP = 2;
  const SEG_H = 3;
  const SEG_GAP = 2;
  const AXIS = 16;
  const pitch = SEG_H + SEG_GAP;
  const rows = Math.floor((h - AXIS - 8 + SEG_GAP) / pitch);
  const base = h - AXIS;
  const bw = (w - PAD * 2 - GAP * (N - 1)) / N;
  const barX = (i) => PAD + i * (bw + GAP);
  const rowY = (r) => base - (r + 1) * pitch + SEG_GAP;

  const target = new Float32Array(N);
  const level = new Float32Array(N);
  const peak = new Float32Array(N);
  const hold = new Float32Array(N);

  // Same log scale the engine uses for its bars: 30 Hz to 16 kHz
  const ticks = [[60, '60'], [250, '250'], [1000, '1k'], [4000, '4k'], [12000, '12k']].map(([f, text]) => ({
    text,
    x: PAD + (Math.log(f / 30) / Math.log(16000 / 30)) * (w - PAD * 2)
  }));

  async function poll() {
    if (state.active) {
      try {
        const res = await msg({ target: 'offscreen', type: 'spectrum', tabId: state.tab.id });
        if (res?.bins) {
          // Tilt the top end up a little so highs read as clearly as lows
          res.bins.forEach((b, i) => { target[i] = Math.min(1, (b / 255) * (1 + (i / N) * 0.35)); });
        }
      } catch { /* engine not ready */ }
      setTimeout(poll, 33);
    } else {
      target.fill(0);
      setTimeout(poll, 250);
    }
  }
  poll();

  let last = performance.now();
  function draw(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, w, h);

    // Unlit grid
    ctx.fillStyle = dim;
    for (let i = 0; i < N; i++) {
      for (let r = 0; r < rows; r++) ctx.fillRect(barX(i), rowY(r), bw, SEG_H);
    }

    // Lit segments: fast attack, slower release, top segment fades in
    ctx.fillStyle = accent;
    for (let i = 0; i < N; i++) {
      const rate = target[i] > level[i] ? 28 : 9;
      level[i] += (target[i] - level[i]) * Math.min(1, dt * rate);
      const lit = Math.pow(level[i], 1.25) * rows;
      const full = Math.floor(lit);
      for (let r = 0; r < full; r++) ctx.fillRect(barX(i), rowY(r), bw, SEG_H);
      const frac = lit - full;
      if (full < rows && frac > 0.05) {
        ctx.globalAlpha = frac;
        ctx.fillRect(barX(i), rowY(full), bw, SEG_H);
        ctx.globalAlpha = 1;
      }

      if (lit >= peak[i]) {
        peak[i] = lit;
        hold[i] = 0.45;
      } else if (hold[i] > 0) {
        hold[i] -= dt;
      } else {
        peak[i] = Math.max(0, peak[i] - dt * rows * 0.9);
      }
    }

    // Peak-hold caps
    ctx.fillStyle = cap;
    for (let i = 0; i < N; i++) {
      const r = Math.min(rows - 1, Math.floor(peak[i]));
      if (peak[i] >= 1) ctx.fillRect(barX(i), rowY(r), bw, SEG_H);
    }

    ctx.fillStyle = muted;
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of ticks) ctx.fillText(t.text, t.x, h - AXIS / 2 + 1);

    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

init();
