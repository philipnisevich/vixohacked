// Small canvas widgets for the workspace. No dependencies.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return { w, h, dpr };
}

function niceStep(span, target = 4) {
  const raw = span / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function fmt(v, step) {
  const d = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return v.toFixed(d);
}

/** Scrolling time-series chart: several series over a time window (ms). */
export class Strip {
  constructor(canvas, { series, window = 10000, min = null, max = null, minSpan = 1, capacity = 30000, step = false }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.series = series;
    this.window = window;
    this.fixed = min !== null && max !== null ? [min, max] : null;
    this.floor = { min, max };
    this.minSpan = minSpan;
    this.step = step;
    this.cap = capacity;
    this.times = new Float64Array(capacity);
    this.vals = new Float32Array(capacity * series.length);
    this.head = 0;
    this.count = 0;
    this.view = null;
  }

  push(time, ...values) {
    const i = this.head;
    this.times[i] = time;
    for (let s = 0; s < this.series.length; s++) {
      const v = values[s];
      this.vals[i * this.series.length + s] = v === null || v === undefined ? NaN : v;
    }
    this.head = (i + 1) % this.cap;
    if (this.count < this.cap) this.count++;
  }

  clear() { this.head = 0; this.count = 0; this.view = null; }

  last(s = 0) {
    if (!this.count) return null;
    const i = (this.head - 1 + this.cap) % this.cap;
    return this.vals[i * this.series.length + s];
  }

  draw(now) {
    const { w, h, dpr } = fit(this.canvas);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const padL = 44 * dpr, padR = 8 * dpr, padT = 6 * dpr, padB = 16 * dpr;
    const pw = w - padL - padR, ph = h - padT - padB;
    const t0 = now - this.window;
    const n = this.series.length;

    // Visible points: walk back from newest.
    let start = this.count;
    for (let k = 0; k < this.count; k++) {
      const i = (this.head - 1 - k + this.cap) % this.cap;
      if (this.times[i] < t0) { start = k; break; }
    }
    const visible = Math.min(this.count, start + 1); // one point before the window for continuity

    let lo, hi;
    if (this.fixed) [lo, hi] = this.fixed;
    else {
      lo = Infinity; hi = -Infinity;
      for (let k = 0; k < visible; k++) {
        const i = (this.head - 1 - k + this.cap) % this.cap;
        for (let s = 0; s < n; s++) {
          if (this.series[s].hidden) continue;
          const v = this.vals[i * n + s];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (!isFinite(lo)) { lo = -this.minSpan / 2; hi = this.minSpan / 2; }
      if (this.floor.min !== null) lo = Math.min(lo, this.floor.min);
      if (this.floor.max !== null) hi = Math.max(hi, this.floor.max);
      const span = Math.max(this.minSpan, (hi - lo) * 1.15);
      const mid = (hi + lo) / 2;
      lo = mid - span / 2; hi = mid + span / 2;
      if (this.view) { // ease the axis so it does not jump
        lo = this.view[0] + (lo - this.view[0]) * (lo < this.view[0] ? 0.5 : 0.08);
        hi = this.view[1] + (hi - this.view[1]) * (hi > this.view[1] ? 0.5 : 0.08);
      }
      this.view = [lo, hi];
    }
    const X = (t) => padL + ((t - t0) / this.window) * pw;
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * ph;

    // Grid
    ctx.font = `${10 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = css('--muted');
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    const ys = niceStep(hi - lo);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = Math.ceil(lo / ys) * ys; v <= hi; v += ys) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(fmt(v, ys), padL - 6 * dpr, y);
    }
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = css('--grid-strong');
      const y = Math.round(Y(0)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    }
    const secs = this.window / 1000;
    const xs = niceStep(secs, 5);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.strokeStyle = css('--grid');
    for (let s = 0; s <= secs + 1e-9; s += xs) {
      const x = Math.round(X(now - s * 1000)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
      ctx.fillText(s === 0 ? 'now' : `-${s >= 60 ? (s / 60).toFixed(s % 60 ? 1 : 0) + 'm' : s + 's'}`, x, padT + ph + 3 * dpr);
    }

    // Series
    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT, pw, ph); ctx.clip();
    ctx.lineWidth = 1.5 * dpr;
    ctx.lineJoin = 'round';
    for (let s = 0; s < n; s++) {
      const ser = this.series[s];
      if (ser.hidden) continue;
      ctx.strokeStyle = ser.color;
      ctx.globalAlpha = ser.alpha ?? 1;
      ctx.beginPath();
      let pen = false, py = 0;
      for (let k = visible - 1; k >= 0; k--) {
        const i = (this.head - 1 - k + this.cap) % this.cap;
        const v = this.vals[i * n + s];
        if (Number.isNaN(v)) { pen = false; continue; }
        const x = X(this.times[i]), y = Y(v);
        if (!pen) { ctx.moveTo(x, y); pen = true; }
        else { if (this.step) ctx.lineTo(x, py); ctx.lineTo(x, y); }
        py = y;
      }
      if (this.step && pen) ctx.lineTo(X(now), py);
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

/** Waveform of the last few seconds of sound. */
export class Scope {
  constructor(canvas, { seconds = 3, rate = 16000 } = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.buf = new Float32Array(seconds * rate);
    this.head = 0;
  }
  push(samples) {
    for (let i = 0; i < samples.length; i++) { this.buf[this.head] = samples[i]; this.head = (this.head + 1) % this.buf.length; }
  }
  clear() { this.buf.fill(0); }
  draw() {
    const { w, h } = fit(this.canvas);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = css('--grid-strong');
    ctx.beginPath(); ctx.moveTo(0, h / 2 + 0.5); ctx.lineTo(w, h / 2 + 0.5); ctx.stroke();
    const per = this.buf.length / w;
    let peak = 0.02;
    for (let i = 0; i < this.buf.length; i++) peak = Math.max(peak, Math.abs(this.buf[i]));
    const gain = Math.min(20, 0.9 / peak); // auto-gain so quiet speech is visible
    ctx.fillStyle = css('--accent');
    for (let x = 0; x < w; x++) {
      let mn = 0, mx = 0;
      const a = Math.floor(x * per), b = Math.floor((x + 1) * per);
      for (let j = a; j < b; j++) {
        const v = this.buf[(this.head + j) % this.buf.length];
        if (v < mn) mn = v; if (v > mx) mx = v;
      }
      const y1 = h / 2 - mx * gain * h / 2, y2 = h / 2 - mn * gain * h / 2;
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    return gain;
  }
}

// Inferno-like colour map
const STOPS = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const f = i / 255 * (STOPS.length - 1), k = Math.min(STOPS.length - 2, Math.floor(f)), r = f - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = STOPS[k][c] + (STOPS[k + 1][c] - STOPS[k][c]) * r;
  }
  return lut;
})();

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Scrolling spectrogram, 0..8 kHz. */
export class Spectrogram {
  constructor(canvas, { size = 512, hop = 256, columns = 600 } = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.size = size; this.hop = hop;
    this.bins = size / 2;
    this.win = new Float32Array(size).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
    this.pending = new Float32Array(0);
    this.off = document.createElement('canvas');
    this.off.width = columns; this.off.height = this.bins;
    this.octx = this.off.getContext('2d');
    this.octx.fillStyle = '#000004'; this.octx.fillRect(0, 0, columns, this.bins);
    this.col = this.octx.createImageData(1, this.bins);
    this.re = new Float32Array(size); this.im = new Float32Array(size);
  }
  clear() { this.octx.fillStyle = '#000004'; this.octx.fillRect(0, 0, this.off.width, this.bins); this.pending = new Float32Array(0); }
  push(samples) {
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending); all.set(samples, this.pending.length);
    let o = 0;
    while (all.length - o >= this.size) {
      for (let i = 0; i < this.size; i++) { this.re[i] = all[o + i] * this.win[i]; this.im[i] = 0; }
      fft(this.re, this.im);
      const d = this.col.data;
      for (let b = 0; b < this.bins; b++) {
        const mag = Math.hypot(this.re[b], this.im[b]) / (this.size / 4);
        const db = 20 * Math.log10(mag + 1e-9);
        const v = Math.max(0, Math.min(255, Math.round((db + 95) / 85 * 255)));
        const y = this.bins - 1 - b, p = y * 4;
        d[p] = LUT[v * 3]; d[p + 1] = LUT[v * 3 + 1]; d[p + 2] = LUT[v * 3 + 2]; d[p + 3] = 255;
      }
      this.octx.drawImage(this.off, -1, 0);
      this.octx.putImageData(this.col, this.off.width - 1, 0);
      o += this.hop;
    }
    this.pending = all.slice(o);
  }
  draw() {
    const { w, h, dpr } = fit(this.canvas);
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.off, 0, 0, w, h);
    ctx.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textBaseline = 'middle';
    for (const k of [1, 2, 4, 6]) {
      const y = h - (k / 8) * h;
      ctx.fillRect(0, y, 6 * dpr, 1);
      ctx.fillText(`${k}k`, 9 * dpr, y);
    }
  }
}

/** Gesture lanes over the last minute. */
export class Timeline {
  constructor(canvas, kinds, colors, window = 60000) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.kinds = kinds; this.colors = colors; this.window = window;
    this.items = [];
  }
  push(time, kind, label) { this.items.push({ time, kind, label }); if (this.items.length > 500) this.items.shift(); }
  clear() { this.items = []; }
  draw(now) {
    const { w, h, dpr } = fit(this.canvas);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const padL = 82 * dpr, padR = 8 * dpr, lane = h / this.kinds.length;
    ctx.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'middle';
    this.kinds.forEach((k, i) => {
      const y = lane * i + lane / 2;
      ctx.fillStyle = css('--muted'); ctx.textAlign = 'right';
      ctx.fillText(k, padL - 8 * dpr, y);
      ctx.strokeStyle = css('--grid');
      ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + 0.5); ctx.lineTo(w - padR, Math.round(y) + 0.5); ctx.stroke();
    });
    const t0 = now - this.window;
    for (const it of this.items) {
      if (it.time < t0) continue;
      const i = this.kinds.indexOf(it.kind);
      if (i < 0) continue;
      const x = padL + (it.time - t0) / this.window * (w - padL - padR);
      const y = lane * i + lane / 2;
      const age = (now - it.time) / 1000;
      const r = (4 + Math.max(0, 6 * (1 - age))) * dpr;
      ctx.fillStyle = this.colors[it.kind];
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      if (it.label) { ctx.fillStyle = css('--text'); ctx.textAlign = 'center'; ctx.fillText(it.label, x, y - 11 * dpr); }
    }
  }
}

/** Draw the band as a 3D box, rotated by roll/pitch/yaw in degrees. */
export function drawBand(canvas, roll, pitch, yaw) {
  const { w, h, dpr } = fit(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const r = Math.PI / 180;
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(roll * r), Math.sin(roll * r), Math.cos(pitch * r), Math.sin(pitch * r), Math.cos(yaw * r), Math.sin(yaw * r)];
  // R = Rz(yaw) * Ry(pitch) * Rx(roll)
  const R = [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
    [-sp, cp * sr, cp * cr],
  ];
  const rot = (v) => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];
  // fixed camera: look from front-right, a little above
  const va = -35 * r, vb = 25 * r;
  const view = ([x, y, z]) => {
    const x1 = x * Math.cos(va) - y * Math.sin(va), y1 = x * Math.sin(va) + y * Math.cos(va);
    const y2 = y1 * Math.cos(vb) - z * Math.sin(vb), z2 = y1 * Math.sin(vb) + z * Math.cos(vb);
    return [x1, y2, z2]; // x right, y depth (away), z up
  };
  const S = Math.min(w, h) * 0.32;
  const proj = ([x, y, z]) => { const f = 4 / (4 + y); return [w / 2 + x * f * S, h / 2 - z * f * S, y]; };

  // ground ring
  ctx.strokeStyle = css('--grid');
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  for (let a = 0; a <= 64; a++) {
    const p = proj(view([Math.cos(a / 64 * 2 * Math.PI) * 1.4, Math.sin(a / 64 * 2 * Math.PI) * 1.4, -0.9]));
    a ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]);
  }
  ctx.stroke();

  const X = 1.0, Y = 0.55, Z = 0.18;
  const V = [[-X, -Y, -Z], [X, -Y, -Z], [X, Y, -Z], [-X, Y, -Z], [-X, -Y, Z], [X, -Y, Z], [X, Y, Z], [-X, Y, Z]].map((v) => view(rot(v)));
  const faces = [
    { i: [4, 5, 6, 7], n: [0, 0, 1], c: '--face-top' },
    { i: [0, 3, 2, 1], n: [0, 0, -1], c: '--face-side' },
    { i: [1, 2, 6, 5], n: [1, 0, 0], c: '--axis-x' },
    { i: [0, 4, 7, 3], n: [-1, 0, 0], c: '--face-side' },
    { i: [0, 1, 5, 4], n: [0, -1, 0], c: '--face-side' },
    { i: [3, 7, 6, 2], n: [0, 1, 0], c: '--face-side' },
  ];
  const light = [-0.3, -0.5, 0.8];
  const drawn = faces.map((f) => {
    const n = view(rot(f.n));
    const depth = f.i.reduce((s, k) => s + V[k][1], 0) / 4;
    return { ...f, nv: n, depth };
  }).filter((f) => f.nv[1] < 0.05).sort((a, b) => b.depth - a.depth);
  for (const f of drawn) {
    const shade = 0.55 + 0.45 * Math.max(0, f.nv[0] * light[0] + f.nv[1] * light[1] + f.nv[2] * light[2]);
    ctx.fillStyle = css(f.c);
    ctx.globalAlpha = 0.35 + 0.6 * shade;
    ctx.beginPath();
    f.i.forEach((k, j) => { const p = proj(V[k]); j ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css('--text'); ctx.lineWidth = 1 * dpr; ctx.stroke();
  }
  // LED dot on top face
  const led = proj(view(rot([0.55, 0, Z + 0.001])));
  ctx.fillStyle = css('--accent');
  ctx.beginPath(); ctx.arc(led[0], led[1], 4 * dpr, 0, Math.PI * 2); ctx.fill();

  // body axes
  const axes = [['x', [1.5, 0, 0], '--axis-x'], ['y', [0, 1.1, 0], '--axis-y'], ['z', [0, 0, 1.0], '--axis-z']];
  const o = proj(view(rot([0, 0, 0])));
  ctx.font = `bold ${11 * dpr}px ui-monospace, Menlo, monospace`;
  for (const [name, v, c] of axes) {
    const p = proj(view(rot(v)));
    ctx.strokeStyle = css(c); ctx.fillStyle = css(c); ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    ctx.fillText(name, p[0] + 4 * dpr, p[1]);
  }
}

/** Counts events and reports a rate per second over the last 2 seconds. */
export class Rate {
  constructor() { this.count = 0; this.stamps = []; this.last = 0; }
  hit(n = 1) { const now = performance.now(); this.count += n; this.last = Date.now(); this.stamps.push([now, n]); }
  get perSecond() {
    const now = performance.now();
    while (this.stamps.length && now - this.stamps[0][0] > 2000) this.stamps.shift();
    return this.stamps.reduce((s, x) => s + x[1], 0) / 2;
  }
}
