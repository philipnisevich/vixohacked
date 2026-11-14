import { Band, BandAudio, SimTransport, oggPackets, canDecodeAudio, EVENT_KINDS } from '../vexo-open-kit/js/src/index.js';
import { Strip, Scope, Spectrogram, Timeline, Rate, drawBand } from './charts.js';

const BAND = 9;                       // our band number, from the bag: Vexo-HACK-09. Never another.

const $ = (id) => document.getElementById(id);
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const C = { x: cssVar('--axis-x'), y: cssVar('--axis-y'), z: cssVar('--axis-z'), m: cssVar('--mag'), a: cssVar('--accent'), w: cssVar('--warn') };

// ---------- charts ----------
const charts = {
  accel: new Strip($('cAccel'), { series: [{ label: 'ax', color: C.x }, { label: 'ay', color: C.y }, { label: 'az', color: C.z }, { label: '|a|', color: C.m, alpha: 0.55 }], minSpan: 1.2 }),
  gyro: new Strip($('cGyro'), { series: [{ label: 'gx', color: C.x }, { label: 'gy', color: C.y }, { label: 'gz', color: C.z }], minSpan: 60 }),
  mic: new Strip($('cMic'), { series: [{ label: 'rms', color: C.a }, { label: 'peak', color: C.w, alpha: 0.6 }], window: 20000, minSpan: 20, max: 0, capacity: 5000 }),
  act: new Strip($('cAct'), { series: [{ label: 'cadence', color: C.a }, { label: 'motion×100', color: C.z, alpha: 0.7 }], window: 300000, minSpan: 20, min: 0, capacity: 5000 }),
  steps: new Strip($('cSteps'), { series: [{ label: 'steps', color: C.a }], window: 300000, minSpan: 10, min: 0, step: true, capacity: 5000 }),
  bat: new Strip($('cBat'), { series: [{ label: '%', color: C.a }], window: 600000, minSpan: 5, capacity: 2000, step: true }),
  rssi: new Strip($('cRssi'), { series: [{ label: 'rssi', color: C.z }], window: 120000, minSpan: 10, capacity: 5000 }),
  temp: new Strip($('cTemp'), { series: [{ label: '°C', color: C.w }], window: 300000, minSpan: 1, capacity: 5000 }),
};
const spec = new Spectrogram($('cSpec'));
const scope = new Scope($('cScope'));
const GESTURES = Object.values(EVENT_KINDS);   // tap, double-tap, free-fall, tilt, orientation, motion-start, motion-stop
const GCOL = { tap: C.a, 'double-tap': '#7ef0d0', 'free-fall': cssVar('--bad'), tilt: C.w, orientation: C.z, 'motion-start': C.y, 'motion-stop': cssVar('--muted') };
const timeline = new Timeline($('cGest'), GESTURES, GCOL);

// legends with click-to-hide
for (const el of document.querySelectorAll('.legend[data-chart]')) {
  const chart = charts[el.dataset.chart];
  chart.series.forEach((s) => {
    const span = document.createElement('span');
    const i = document.createElement('i'); i.style.background = s.color;
    span.append(i, s.label);
    span.onclick = () => { s.hidden = !s.hidden; span.classList.toggle('off', s.hidden); chart.view = null; };
    el.append(span);
  });
}

// gesture chips
const chips = {};
for (const k of GESTURES) {
  const c = document.createElement('span'); c.className = 'chip';
  const dot = document.createElement('i'); dot.style.background = GCOL[k];
  const n = document.createElement('b'); n.textContent = '0';
  c.append(dot, k, n);
  $('gestChips').append(c);
  chips[k] = { el: c, n, count: 0 };
}

// stream health table
const STREAMS = ['motion', 'event', 'activity', 'mic-level', 'audio', 'battery', 'temperature', 'link', 'notice'];
const rates = {};
for (const s of STREAMS) {
  rates[s] = new Rate();
  const tr = document.createElement('tr'); tr.id = `h-${s}`; tr.className = 'idle';
  for (const v of [s, '–', '0', '–']) { const td = document.createElement('td'); td.textContent = v; tr.append(td); }
  $('health').append(tr);
}

// ---------- state ----------
let band = null;
let paused = false;
let sound = null;           // BandAudio for spectrogram / scope
let player = null;          // { ctx, next } for "play through speakers"
let firstSteps = null;
let lostSamples = 0, lastN = null;
let lastState = null;
let micMode = 'off';
const ori = { roll: 0, pitch: 0, yaw: 0, lastT: null, init: false };
const rec = { on: false, started: 0, data: null };

// ---------- helpers ----------
function status(text, kind = '') {
  $('status').textContent = text;
  $('statusDot').className = `dot ${kind}`;
}
function log(kind, text, cls = '') {
  const li = document.createElement('li');
  const t = document.createElement('time'); t.textContent = new Date().toLocaleTimeString();
  const k = document.createElement('span'); k.className = `k ${cls}`; k.textContent = kind;
  const v = document.createElement('span'); v.textContent = text;
  li.append(t, k, v);
  const ol = $('log'); ol.prepend(li);
  while (ol.children.length > 300) ol.lastChild.remove();
}
function fail(e) { log('error', e.message || String(e), 'err'); status(e.message || String(e), band ? 'on' : ''); }
async function safe(fn) { try { return await fn(); } catch (e) { fail(e); } }
function record(stream, obj) { if (rec.on) (rec.data[stream] ||= []).push(obj); }
const fx = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '–' : (v >= 0 ? ' ' : '') + v.toFixed(d));

function setConnectedUI(on) {
  for (const id of ['btnBle', 'btnUsb', 'btnSim']) $(id).disabled = on;
  $('btnOff').disabled = !on;
}

// ---------- connect ----------
async function connect(kind) {
  if (band) return;
  setConnectedUI(true);
  status(kind === 'sim' ? 'Starting the pretend band…' : kind === 'serial' ? 'Pick "Vexo Open band" in the list…' : 'Pick Vexo-HACK-09 in the list… (double-tap the band first)', 'wait');
  try {
    let opts = { autoReconnect: true };
    if (kind === 'serial') opts.transport = 'serial';
    if (kind === 'sim') {
      let audioPackets = null;
      try {
        const bytes = new Uint8Array(await (await fetch('../vexo-open-kit/dashboard/speech/sample-speech.opus')).arrayBuffer());
        audioPackets = oggPackets(bytes);
      } catch { /* no voice: the pretend band sends silence */ }
      opts.transport = new SimTransport(BAND, { audioPackets });
    }
    band = await Band.connect(BAND, opts);
  } catch (e) {
    band = null; setConnectedUI(false); fail(e); status(e.message);
    return;
  }
  resetData();
  wire(band);
  await showInfo();
  await safe(() => band.setMotion({ accelRange: +$('selRange').value, gyroRange: +$('selGyro').value }));
  await safe(() => band.setEvents({ kinds: ['tap', 'double-tap', 'free-fall', 'tilt', 'orientation', 'motion'], tapThreshold: +$('tapTh').value }));
  await safe(() => band.configure({
    motion: +$('selRate').value, sensors: $('selSensors').value,
    events: true, activity: true, battery: true, temperature: 1,
    ...(band.transportKind === 'serial' ? {} : { link: 1 }),
  }));
  await applyMic();
  $('iRate').textContent = `${band.streams.motion}/s`;
  status(`Connected to ${band.name} over ${band.transportKind === 'ble' ? 'Bluetooth' : band.transportKind === 'serial' ? 'USB' : 'the pretend band'}.`, 'on');
  log('connect', `${band.name} via ${band.transportKind}`);
}

async function showInfo() {
  const i = band.info;
  $('iLink').textContent = band.transportKind;
  $('iFw').textContent = `${i.firmware} (protocol ${i.protocol})`;
  $('iFeat').textContent = (i.features || []).join(' ') || 'none';
  $('iClock').textContent = band.clock;
  // rate options from what this link can carry
  const lim = await band.motionLimits();
  const sens = $('selSensors').value;
  const max = lim[sens] ?? lim.both;
  const sel = $('selRate'); const want = +sel.value || 100;
  sel.textContent = '';
  for (const r of lim.rates) {
    const o = document.createElement('option'); o.value = r; o.textContent = `${r}/s`;
    if (r > max) { o.disabled = true; o.textContent += ' (too fast)'; }
    sel.append(o);
  }
  sel.value = String(Math.min(want, max));
}

async function disconnect() {
  if (!band) return;
  const b = band;
  await safe(() => b.disconnect());
}

function resetData() {
  for (const c of Object.values(charts)) c.clear();
  spec.clear(); scope.clear(); timeline.clear();
  firstSteps = null; lostSamples = 0; lastN = null; lastState = null;
  Object.assign(ori, { roll: 0, pitch: 0, yaw: 0, lastT: null, init: false });
  for (const k of GESTURES) { chips[k].count = 0; chips[k].n.textContent = '0'; }
  $('iLost').textContent = '0';
}

// ---------- data handlers ----------
function wire(b) {
  b.on('motion', (m) => {
    rates.motion.hit();
    const t = m.time ?? Date.now();
    if (m.n !== null && m.n !== undefined) {
      if (lastN !== null && m.n > lastN + 1) { lostSamples += m.n - lastN - 1; $('iLost').textContent = String(lostSamples); }
      lastN = m.n;
    }
    if (m.ax !== null) charts.accel.push(t, m.ax, m.ay, m.az, Math.hypot(m.ax, m.ay, m.az));
    if (m.gx !== null) charts.gyro.push(t, m.gx, m.gy, m.gz);
    fuse(m);
    record('motion', [t, m.t, m.n, m.ax, m.ay, m.az, m.gx, m.gy, m.gz]);
  });

  b.on('event', (e) => {
    rates.event.hit();
    const t = e.time ?? Date.now();
    timeline.push(t, e.kind, e.kind === 'orientation' ? e.face : '');
    const c = chips[e.kind];
    if (c) {
      c.n.textContent = String(++c.count);
      c.el.classList.add('flash'); setTimeout(() => c.el.classList.remove('flash'), 60);
    }
    log(e.kind, e.kind === 'orientation' ? `face ${e.face}` : `arg ${e.arg}`);
    record('event', { time: t, t: e.t, kind: e.kind, arg: e.arg, face: e.face ?? null });
  });

  b.on('activity', (a) => {
    rates.activity.hit();
    const t = a.time ?? Date.now();
    if (firstSteps === null) firstSteps = a.steps;
    const since = a.steps - firstSteps;
    charts.act.push(t, a.cadence, a.motion * 100);
    charts.steps.push(t, since);
    $('aSteps').textContent = since.toLocaleString();
    $('aTotal').textContent = a.steps.toLocaleString();
    $('aCad').textContent = String(a.cadence);
    const st = $('aState'); st.textContent = a.state; st.className = `pill ${a.state}`;
    if (a.state !== lastState) { if (lastState !== null) log('activity', `${lastState} → ${a.state}`); lastState = a.state; }
    record('activity', { time: t, t: a.t, steps: a.steps, cadence: a.cadence, state: a.state, motion: a.motion });
  });

  b.on('mic-level', (l) => {
    rates['mic-level'].hit();
    const t = l.time ?? Date.now();
    charts.mic.push(t, -l.rmsDb, -l.peakDb);
    record('micLevel', { time: t, t: l.t, rmsDb: l.rmsDb, peakDb: l.peakDb });
  });

  b.on('audio', (a) => {
    rates.audio.hit();
    if (sound) sound.push(a);
  });

  b.on('battery', (x) => {
    rates.battery.hit();
    const t = x.time ?? Date.now();
    charts.bat.push(t, x.percent);
    $('batPct').textContent = `${x.percent}%`;
    $('batFill').style.width = `${x.percent}%`;
    $('batFill').style.background = x.percent < 15 ? cssVar('--bad') : x.percent < 35 ? cssVar('--warn') : cssVar('--accent');
    $('batMv').textContent = String(x.millivolts);
    $('batState').textContent = x.state;
    log('battery', `${x.percent}% ${x.millivolts} mV ${x.state}`);
    record('battery', { time: t, ...x });
  });

  b.on('temperature', (x) => {
    rates.temperature.hit();
    const t = x.time ?? Date.now();
    charts.temp.push(t, x.celsius);
    $('tempV').textContent = `${x.celsius.toFixed(1)} °C`;
    record('temperature', { time: t, t: x.t, celsius: x.celsius });
  });

  b.on('link', (x) => {
    rates.link.hit();
    const t = x.time ?? Date.now();
    charts.rssi.push(t, x.rssi);
    $('sigV').textContent = x.rssi === null ? 'no reading' : `${x.rssi} dBm · ${x.phy ?? ''}`;
    record('link', { time: t, t: x.t, rssi: x.rssi, txPower: x.txPower, phy: x.phy });
  });

  b.on('notice', (n) => { rates.notice.hit(); log('notice', `${n.kind} ${n.arg ?? ''}`, n.kind.includes('battery') ? 'err' : ''); record('notice', n); });

  b.on('stream-taken', (x) => {
    $('banner').hidden = false; $('bannerText').textContent = x.message; $('bannerBtn').hidden = false;
    log('stream-taken', x.message, 'err');
  });
  b.on('reconnecting', (x) => { status(`Link lost (${x.reason}). Reconnecting for up to ${x.seconds} s…`, 'wait'); log('reconnecting', x.reason); });
  b.on('reconnected', (x) => {
    status(`Reconnected to ${b.name} after ${x.attempts} attempt(s).`, 'on');
    log('reconnected', `${x.attempts} attempts, ${x.seconds}s${x.failed?.length ? `, refused: ${x.failed.join(',')}` : ''}`);
    if (sound) sound.restart();
    lastN = null; ori.lastT = null;
  });
  b.on('disconnect', (x) => {
    log('disconnect', x.reason + (x.reconnect ? ` (${x.reconnect})` : ''));
    status(`Disconnected (${x.reason}). Double-tap the band and connect again.`);
    stopSound();
    band = null; setConnectedUI(false);
    micMode = 'off'; $('selMic').value = 'off'; updateMicNote();
  });
}

// complementary filter: gyro short term, gravity long term
function fuse(m) {
  const dt = ori.lastT === null ? 0 : Math.min(0.1, Math.max(0, (m.t - ori.lastT) / 1000));
  ori.lastT = m.t;
  if (m.gx !== null && dt > 0) { ori.roll += m.gx * dt; ori.pitch += m.gy * dt; ori.yaw += m.gz * dt; }
  if (m.ax !== null) {
    const ar = Math.atan2(m.ay, m.az) * 180 / Math.PI;
    const ap = Math.atan2(-m.ax, Math.hypot(m.ay, m.az)) * 180 / Math.PI;
    const g = Math.hypot(m.ax, m.ay, m.az);
    const k = !ori.init || m.gx === null ? 1 : Math.abs(g - 1) < 0.25 ? 0.03 : 0.003;
    const d = ((ar - ori.roll + 540) % 360) - 180;
    ori.roll += d * k;
    ori.pitch += (ap - ori.pitch) * k;
    ori.init = true;
  }
  ori.roll = ((ori.roll + 540) % 360) - 180;
  ori.yaw = ((ori.yaw + 540) % 360) - 180;
}

// ---------- microphone ----------
function updateMicNote() {
  const n = $('micNote');
  if (micMode === 'off') { n.className = 'note'; n.textContent = 'Microphone is off. Turning it on lights the band solid blue and locks the LED. Tell the people near you first.'; }
  else { n.className = 'note live'; n.textContent = `● Microphone ON (${micMode === 'audio' ? 'loudness + sound' : 'loudness only'}): the band shows solid blue. Sound stays on this computer; nothing is sent anywhere.`; }
  const locked = micMode !== 'off';
  for (const id of ['ledSet', 'ledOff', 'ledId']) $(id).disabled = locked || !band;
  $('ledNote').textContent = locked ? 'The LED is locked while the microphone is on.' : '';
}

async function applyMic() {
  if (!band) return;
  const mode = $('selMic').value;
  if (mode === 'audio') {
    if (!(await canDecodeAudio())) { fail(new Error('This browser cannot decode the band sound. Use Chrome or Edge.')); $('selMic').value = micMode; return; }
    if (!sound) {
      sound = new BandAudio((samples) => {
        spec.push(samples); scope.push(samples);
        if (player) play(samples);
      }, { onError: fail });
    }
  } else stopSound();
  try {
    await band.configure({ micLevel: mode === 'off' ? false : 0.04, audio: mode === 'audio' });
    if (mode !== micMode) log('mic', mode === 'off' ? 'off' : `on: ${mode}`);
    micMode = mode;
    const both = band.streams.motion > 208 && $('selSensors').value === 'both';
    if (mode === 'audio' && band.transportKind === 'ble' && both) log('warning', 'With sound on over Bluetooth, keep motion at 208/s (both sensors) or the link may drop samples.', 'err');
  } catch (e) { fail(e); $('selMic').value = micMode; }
  updateMicNote();
}

function stopSound() { if (sound) { sound.close(); sound = null; } }

function play(samples) {
  const { ctx } = player;
  const buf = ctx.createBuffer(1, samples.length, 16000);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
  player.next = Math.max(player.next, ctx.currentTime + 0.08);
  src.start(player.next);
  player.next += buf.duration;
}

// ---------- recording ----------
function toggleRec() {
  if (!rec.on) {
    rec.on = true; rec.started = Date.now(); rec.data = { band: band?.name ?? `band ${BAND}`, started: new Date().toISOString(), motionColumns: ['time', 't', 'n', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'] };
    $('btnRec').textContent = '■ Stop'; $('btnRec').classList.add('rec'); $('btnSave').disabled = true;
    log('record', 'started');
  } else {
    rec.on = false; rec.data.stopped = new Date().toISOString();
    $('btnRec').textContent = '● Record'; $('btnRec').classList.remove('rec'); $('btnSave').disabled = false;
    log('record', `stopped, ${(rec.data.motion || []).length} motion samples`);
  }
}
function save() {
  if (!rec.data) return;
  const stamp = new Date(rec.started).toISOString().replace(/[:.]/g, '-');
  download(`band09-${stamp}.json`, JSON.stringify(rec.data));
  const rows = [rec.data.motionColumns.join(','), ...(rec.data.motion || []).map((r) => r.join(','))];
  download(`band09-${stamp}-motion.csv`, rows.join('\n'));
}
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- render loop ----------
function frame() {
  requestAnimationFrame(frame);
  // health table updates even while paused
  for (const s of STREAMS) {
    const r = rates[s], tr = $(`h-${s}`);
    const age = r.last ? (Date.now() - r.last) / 1000 : null;
    tr.className = age !== null && age < 3 ? 'live' : 'idle';
    tr.children[1].textContent = r.perSecond.toFixed(s === 'motion' || s === 'audio' ? 0 : 1);
    tr.children[2].textContent = r.count.toLocaleString();
    tr.children[3].textContent = age === null ? '–' : age < 1 ? 'now' : `${age.toFixed(0)}s`;
  }
  if (rec.on) $('iRec').textContent = `${((Date.now() - rec.started) / 1000).toFixed(0)} s`;
  else $('iRec').textContent = rec.data ? 'stopped (save it)' : 'off';
  if (paused) return;
  const now = Date.now();
  for (const c of Object.values(charts)) c.draw(now);
  timeline.draw(now);
  spec.draw();
  const gain = scope.draw();
  $('scopeGain').textContent = micMode === 'audio' ? `(auto gain ×${gain.toFixed(1)})` : '';
  drawBand($('cOri'), ori.roll, ori.pitch, ori.yaw);
  $('rOri').innerHTML = '';
  $('rOri').append(...['roll', 'pitch', 'yaw'].map((k) => { const s = document.createElement('span'); s.textContent = `${k} ${fx(ori[k], 0)}°`; return s; }));
  const a = charts.accel, g = charts.gyro;
  $('rAccel').textContent = `ax ${fx(a.last(0))}  ay ${fx(a.last(1))}  az ${fx(a.last(2))}  |a| ${fx(a.last(3))} g`;
  $('rGyro').textContent = `gx ${fx(g.last(0), 1)}  gy ${fx(g.last(1), 1)}  gz ${fx(g.last(2), 1)} °/s`;
}
requestAnimationFrame(frame);

// ---------- controls ----------
$('btnBle').onclick = () => connect('ble');
$('btnUsb').onclick = () => connect('serial');
$('btnSim').onclick = () => connect('sim');
$('btnOff').onclick = disconnect;
$('btnPause').onclick = () => { paused = !paused; $('btnPause').textContent = paused ? 'Resume' : 'Pause'; };
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); $('btnPause').click(); } });
$('btnRec').onclick = toggleRec;
$('btnSave').onclick = save;
$('btnZero').onclick = () => { ori.yaw = 0; };
$('btnClearLog').onclick = () => { $('log').textContent = ''; };
$('bannerBtn').onclick = () => safe(async () => { await band.takeBack(); $('banner').hidden = true; log('take-back', 'streams restarted'); });

$('selWin').onchange = () => { charts.accel.window = charts.gyro.window = +$('selWin').value; };
$('selRate').onchange = () => band && safe(async () => { await band.configure({ motion: +$('selRate').value }); $('iRate').textContent = `${band.streams.motion}/s`; lastN = null; });
$('selSensors').onchange = () => band && safe(async () => { await band.configure({ sensors: $('selSensors').value }); await showInfo(); await band.configure({ motion: +$('selRate').value }); $('iRate').textContent = `${band.streams.motion}/s`; lastN = null; });
$('selRange').onchange = () => band && safe(() => band.setMotion({ accelRange: +$('selRange').value }));
$('selGyro').onchange = () => band && safe(() => band.setMotion({ gyroRange: +$('selGyro').value }));
$('tapTh').oninput = () => { $('tapThV').textContent = (+$('tapTh').value).toFixed(1); };
$('tapTh').onchange = () => band && safe(() => band.setEvents({ tapThreshold: +$('tapTh').value }));
$('selMic').onchange = applyMic;
$('micGain').oninput = () => { const v = +$('micGain').value; $('micGainV').textContent = (v > 0 ? '+' : '') + v; };
$('micGain').onchange = () => band && safe(() => band.setMicGain(+$('micGain').value));
$('chkListen').onchange = (e) => {
  if (e.target.checked) { player = { ctx: new AudioContext(), next: 0 }; }
  else if (player) { player.ctx.close(); player = null; }
};

$('ledSet').onclick = () => band && safe(() => band.setLed($('ledColor').value, { pattern: $('ledPattern').value, brightness: +$('ledBright').value, period: +$('ledPeriod').value }));
$('ledOff').onclick = () => band && safe(() => band.ledOff());
$('ledId').onclick = () => band && safe(() => band.identify());
updateMicNote();
