/* ════════════════════════════════════════════════════════════════════════════
   controlhub — app.js
   Modes: demo | bluetooth+backend | bluetooth-local | backend-url
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const SAMPLE_RATE   = 256;          // Hz assumed for connected device
const COLLECT_SECS  = 2;            // seconds of EEG to buffer before posting
const COLLECT_N     = SAMPLE_RATE * COLLECT_SECS;  // 512 samples per channel
const WAVE_LEN      = 300;          // ring-buffer length for canvas
const DEMO_INTERVAL = 1200;         // ms between demo readings

const MUSE_SERVICE_UUID = '0000fe8d-0000-1000-8000-00805f9b34fb';
const MUSE_CONTROL_UUID = '273e0001-4c4d-454d-96be-f03bac821358';
const MUSE_EEG_UUIDS    = [
  '273e0003-4c4d-454d-96be-f03bac821358', // TP9
  '273e0004-4c4d-454d-96be-f03bac821358', // AF7
  '273e0005-4c4d-454d-96be-f03bac821358', // AF8
  '273e0006-4c4d-454d-96be-f03bac821358', // TP10
];

const DEPTH_PCT   = { Surface: 12, Emerging: 37, Deep: 62, Profound: 94 };
const CHITTA_DEPTHS = { Kshipta: 'Surface', Vikshipta: 'Emerging', Ekagra: 'Deep', Niruddha: 'Profound' };
const SWARA_NOTES = {
  ida:       'Parasympathetic dominance. Receptive, creative and introspective state.',
  pingala:   'Sympathetic dominance. Active, analytical and goal-directed focus.',
  sushumna:  'Equilibrium of solar and lunar channels. Gateway to higher contemplative states.',
};

// ── State ─────────────────────────────────────────────────────────────────────
let mode         = 'idle';    // idle | demo | bluetooth | backend
let backendUrl   = localStorage.getItem('controlhub_url') || '';
let btDevice     = null;
let btDisconnect = null;
let demoTimer    = null;
let epoch        = 0;
let demoStateIdx = 0;
let demoSwaraIdx = 0;
let demoEpoch    = 0;

// BLE EEG collection buffers (one array per channel, up to 4 channels)
const bleChannels = [[], [], [], []];
let   blePhase    = 0;
let   bleSamTick  = 0;

// Wave ring-buffer for canvas
const waveBuf  = new Float32Array(WAVE_LEN);
let   waveTail = 0;
let   wavePhase = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const canvas       = $('eeg-canvas');
const ctx          = canvas.getContext('2d');
const statusPill   = $('status-pill');
const statusDot    = $('status-dot');
const statusLabel  = $('status-label');
const settingsOverlay = $('settings-overlay');
const btDeviceRow  = $('bt-device-row');
const btDeviceName = $('bt-device-name');
const btnBt        = $('btn-bluetooth');
const btnSettings  = $('btn-settings');
const btnDemo      = $('btn-demo');
const demoIcon     = $('demo-icon');
const inputUrl     = $('input-backend-url');
const testMsg      = $('test-msg');

// ── Canvas / Waveform ─────────────────────────────────────────────────────────
function resizeCanvas() {
  const dpr  = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width  = rect.width  * dpr;
  canvas.height = 110 * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
}

function drawWave() {
  const w = canvas.clientWidth, h = 110;
  ctx.clearRect(0, 0, w, h);

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#FFFFFF');
  bg.addColorStop(1, '#F7F6F2');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // centre guide
  ctx.strokeStyle = '#E4E2DC';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  const len = Math.min(waveTail, WAVE_LEN);
  if (len < 2) { requestAnimationFrame(drawWave); return; }

  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0,    'rgba(217,119,87,0)');
  grad.addColorStop(0.18, 'rgba(217,119,87,0.8)');
  grad.addColorStop(0.85, 'rgba(217,119,87,0.8)');
  grad.addColorStop(1,    'rgba(217,119,87,0)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';
  ctx.beginPath();
  for (let i = 0; i < len; i++) {
    const idx = (waveTail - len + i + WAVE_LEN * 100) % WAVE_LEN;
    const x   = (i / (len - 1)) * w;
    const y   = h / 2 - waveBuf[idx] * (h * 0.34);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // fill under
  ctx.lineTo(w, h / 2); ctx.lineTo(0, h / 2); ctx.closePath();
  const fill = ctx.createLinearGradient(0, h / 2 - h * 0.34, 0, h / 2 + h * 0.1);
  fill.addColorStop(0, 'rgba(217,119,87,0.12)');
  fill.addColorStop(1, 'rgba(217,119,87,0)');
  ctx.fillStyle = fill;
  ctx.fill();

  requestAnimationFrame(drawWave);
}

function pushWave(v) {
  waveBuf[waveTail % WAVE_LEN] = v;
  waveTail++;
}

function pushWaveFromBands(bp) {
  wavePhase += 0.16;
  for (let i = 0; i < 18; i++) {
    const t  = i / 18;
    const ph = wavePhase - 0.16 + t * 0.16;
    const noise = (Math.random() - 0.5) * 0.08;
    pushWave(
      bp.delta * 0.6 * Math.sin(ph * 2.0) +
      bp.theta * 0.9 * Math.sin(ph * 5.5 + 0.7) +
      bp.alpha * 1.2 * Math.sin(ph * 10  + 1.2) +
      bp.beta  * 0.8 * Math.sin(ph * 20  + 2.1) +
      bp.gamma * 0.4 * Math.sin(ph * 38  + 3.0) +
      noise
    );
  }
}

// idle gentle sway
let idlePhase = 0;
setInterval(() => {
  if (mode === 'idle') {
    idlePhase += 0.04;
    pushWave(
      Math.sin(idlePhase) * 0.12 +
      Math.sin(idlePhase * 2.3 + 1) * 0.04 +
      Math.sin(idlePhase * 0.7 + 2) * 0.06
    );
  }
}, 60);

// ── Status pill ───────────────────────────────────────────────────────────────
function setStatus(cls, label) {
  statusPill.className = 'status-pill' + (cls ? ' ' + cls : '');
  statusLabel.textContent = label;
}

// ── UI Update from a reading object ──────────────────────────────────────────
/*
  reading = {
    epoch, latency_ms, data_quality,
    chitta_bhumi: { state, depth, confidence, probabilities: {Kshipta,Vikshipta,Ekagra,Niruddha} },
    swara: { state, confidence, note },
    band_powers: { relative: {delta,theta,alpha,beta,gamma} },  // 0..1
    alpha_asymmetry,
    tattva_flags: [],
    contemplative_depth,
  }
  -or- from Render backend:
  {
    chitta_bhumi: { state, confidence },
    swara: { state },
    tattva: [],
    depth,
    eeg_spectrum: { alpha, theta, delta, beta, gamma },  // values as %
  }
*/
function applyReading(r, bp) {
  // ── Chitta Bhumi ──
  const state = r.chitta_bhumi?.state || '—';
  const depth = r.chitta_bhumi?.depth || r.depth || CHITTA_DEPTHS[state] || '—';
  const conf  = r.chitta_bhumi?.confidence || '—';
  const probs = r.chitta_bhumi?.probabilities || {};

  $('val-state').textContent = state;
  $('val-depth-label').textContent = depth ? `${depth} meditation` : 'awaiting signal';
  $('val-confidence').textContent  = conf;
  $('val-epoch').textContent       = r.epoch || epoch;
  $('val-latency').textContent     = r.latency_ms != null ? r.latency_ms.toFixed(1) + ' ms' : '— ms';
  $('val-quality').textContent     = r.data_quality || '✓';
  $('val-timestamp').textContent   = r.timestamp || new Date().toISOString().slice(11,22) + ' UTC';
  $('val-board').textContent       = r.board || (mode === 'bluetooth' ? btDevice?.name || 'BLE device' : '—');
  $('val-mode').textContent        = mode === 'demo' ? 'synthetic demo' : mode === 'bluetooth' ? 'BLE → Render' : 'SSE / polling';

  // card state class
  const card = $('chitta-card');
  card.className = 'card chitta-card' + (state !== '—' ? ' state-' + state : '');

  // depth fill
  $('chitta-fill').style.width = (DEPTH_PCT[depth] || 0) + '%';

  // node highlights
  document.querySelectorAll('.chitta-depth-nodes span').forEach(el => {
    el.classList.toggle('active', el.dataset.s === state);
  });

  // probabilities
  ['Kshipta', 'Vikshipta', 'Ekagra', 'Niruddha'].forEach(s => {
    const raw = probs[s];
    const pct = raw ? parseFloat(raw) : 0;
    $('prob-' + s).style.width   = pct + '%';
    $('probval-' + s).textContent = raw || '—';
  });

  // depth pill
  const pill = $('depth-pill');
  pill.textContent = depth || '—';
  pill.className = 'depth-pill' + (depth ? ' ' + depth : '');

  // ── Band powers ──
  let bands = null;
  if (bp) {
    bands = bp;
  } else if (r.band_powers?.relative) {
    bands = r.band_powers.relative;
  } else if (r.eeg_spectrum) {
    // backend returns percentages — normalize to 0..1
    const sp = r.eeg_spectrum;
    const tot = (sp.delta||0)+(sp.theta||0)+(sp.alpha||0)+(sp.beta||0)+(sp.gamma||0) || 1;
    bands = { delta: sp.delta/tot, theta: sp.theta/tot, alpha: sp.alpha/tot, beta: sp.beta/tot, gamma: sp.gamma/tot };
  }
  if (bands) {
    ['delta','theta','alpha','beta','gamma'].forEach(k => {
      const v = bands[k] || 0;
      $('band-' + k).style.height    = Math.round(v * 100) + '%';
      $('bandval-' + k).textContent  = (v * 100).toFixed(1) + '%';
    });
    pushWaveFromBands(bands);
  }

  // ── Swara ──
  const swaraState = r.swara?.state || '—';
  const swaraConf  = r.swara?.confidence || '—';
  const swaraNote  = r.swara?.note || '';
  $('val-swara-state').textContent = swaraState;
  $('val-swara-conf').textContent  = swaraConf;
  const noteEl = $('val-swara-note');
  noteEl.textContent = swaraNote;
  noteEl.style.display = swaraNote ? '' : 'none';

  const isIda      = /ida/i.test(swaraState);
  const isPingala  = /pingala/i.test(swaraState);
  const isSushumna = !isIda && !isPingala;
  $('glyph-ida').className      = 'swara-glyph' + (isIda      ? ' active-ida'      : '');
  $('glyph-sushumna').className = 'swara-glyph' + (isSushumna ? ' active-sushumna' : '');
  $('glyph-pingala').className  = 'swara-glyph' + (isPingala  ? ' active-pingala'  : '');

  const asym   = r.alpha_asymmetry || 0;
  const clamped = Math.max(-0.5, Math.min(0.5, asym));
  const pct    = (clamped / 0.5) * 50;
  const thumbL  = (50 + pct) + '%';
  const fillBg  = isIda ? 'var(--ida)' : isPingala ? 'var(--pingala)' : 'var(--sushumna)';
  const thumb   = $('asym-thumb');
  const fill    = $('asym-fill');
  thumb.style.left       = thumbL;
  thumb.style.background = fillBg;
  if (pct > 0) {
    fill.style.left       = '50%';
    fill.style.right      = (100 - (50 + pct)) + '%';
    fill.style.background = fillBg;
  } else if (pct < 0) {
    fill.style.left       = (50 + pct) + '%';
    fill.style.right      = '50%';
    fill.style.background = fillBg;
  } else {
    fill.style.left = fill.style.right = '50%';
  }

  // ── Tattva flags ──
  const flags    = r.tattva_flags || r.tattva || [];
  const flagsDiv = $('tattva-flags');
  flagsDiv.innerHTML = '';
  if (!flags.length) {
    flagsDiv.innerHTML = '<span class="tattva-empty">no flags active</span>';
  } else {
    flags.forEach(f => {
      const span = document.createElement('span');
      let cls = 'tattva-other';
      if (/tattva/i.test(f))     cls = 'tattva-activation';
      else if (/pratyahara/i.test(f)) cls = 'pratyahara';
      else if (/turiya/i.test(f))     cls = 'turiya';
      else if (/gamma/i.test(f))      cls = 'gamma-spike';
      span.className   = 'tattva-flag ' + cls;
      span.textContent = f;
      flagsDiv.appendChild(span);
    });
  }
}

// ── Local FFT + classification (fallback when no backend) ─────────────────────
function fft(signal) {
  let size = 1;
  while (size < signal.length) size <<= 1;
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < signal.length; i++) re[i] = signal[i];
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i],re[j]]=[re[j],re[i]]; [im[i],im[j]]=[im[j],im[i]]; }
  }
  for (let len = 2; len <= size; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < size; i += len) {
      let cRe = 1, cIm = 0;
      for (let j = 0; j < (len >> 1); j++) {
        const uRe = re[i+j], uIm = im[i+j], h = i+j+(len>>1);
        const vRe = re[h]*cRe - im[h]*cIm, vIm = re[h]*cIm + im[h]*cRe;
        re[i+j]=uRe+vRe; im[i+j]=uIm+vIm; re[h]=uRe-vRe; im[h]=uIm-vIm;
        const nRe = cRe*wRe - cIm*wIm; cIm = cRe*wIm + cIm*wRe; cRe = nRe;
      }
    }
  }
  const half = size >> 1, mags = new Array(half);
  for (let i = 0; i < half; i++) mags[i] = Math.sqrt(re[i]*re[i]+im[i]*im[i]) / size;
  return mags;
}

function bandPowers(mags, sr, sz) {
  const res = sr / sz;
  const bin = hz => Math.round(hz / res);
  const sum = (lo, hi) => {
    let s = 0;
    for (let b = bin(lo); b <= Math.min(bin(hi), mags.length-1); b++) s += mags[b]*mags[b];
    return s;
  };
  const d=sum(0.5,4), t=sum(4,8), a=sum(8,13), be=sum(13,30), g=sum(30,50);
  const tot = d+t+a+be+g || 1;
  return { delta:d/tot, theta:t/tot, alpha:a/tot, beta:be/tot, gamma:g/tot };
}

function softmax(logits) {
  const m = Math.max(...logits), ex = logits.map(l=>Math.exp(l-m)), s = ex.reduce((a,b)=>a+b,0);
  return ex.map(e=>e/s);
}

function classifyLocal(bp) {
  const states = ['Kshipta','Vikshipta','Ekagra','Niruddha'];
  const logits = [
    bp.beta*3.0 + bp.gamma*1.5 - bp.alpha*1.5,
    bp.alpha*1.5 + bp.beta*1.5 - bp.theta*0.5,
    bp.alpha*3.5 + bp.theta*1.0 - bp.beta*2.0,
    bp.theta*3.0 + bp.delta*2.0 - bp.beta*2.5,
  ];
  const probs = softmax(logits);
  const maxI  = probs.indexOf(Math.max(...probs));
  const state = states[maxI];
  const probMap = {};
  states.forEach((s,i) => { probMap[s] = (probs[i]*100).toFixed(1)+'%'; });

  const abs  = Math.abs(bp.alpha); // proxy for asymmetry
  const asym = (Math.random()-0.5) * 0.3;
  const isIda = asym < -0.04, isPingala = asym > 0.04;
  const swaraState = isIda ? 'Ida Nadi — right hemisphere dominant'
                   : isPingala ? 'Pingala Nadi — left hemisphere dominant'
                   : 'Sushumna — both nadis balanced';
  const swaraNote  = isIda ? SWARA_NOTES.ida : isPingala ? SWARA_NOTES.pingala : SWARA_NOTES.sushumna;

  const tattva = [];
  if (bp.alpha>0.35 && bp.theta<0.25) tattva.push('Pratyahara Window');
  if (bp.theta>0.28 && bp.alpha>0.28) tattva.push('Potential Tattva Activation');
  if (bp.theta>0.32 && bp.delta>0.12) tattva.push('Turiya Approach');
  if (bp.gamma>0.12)                   tattva.push('Gamma Spike');

  epoch++;
  const depth = CHITTA_DEPTHS[state];
  return {
    epoch, latency_ms: 20 + Math.random()*10,
    data_quality: '✓ local FFT',
    chitta_bhumi: { state, depth, confidence: probMap[state], probabilities: probMap },
    swara: { state: swaraState, confidence: Math.abs(asym)>0.12 ? 'High' : 'Moderate', note: swaraNote },
    band_powers: { relative: bp },
    alpha_asymmetry: asym,
    tattva_flags: tattva,
    contemplative_depth: depth,
  };
}

// ── Demo mode ─────────────────────────────────────────────────────────────────
const DEMO_STATES = ['Kshipta','Vikshipta','Ekagra','Niruddha'];
const DEMO_SWARA  = [
  'Ida Nadi — right hemisphere dominant',
  'Pingala Nadi — left hemisphere dominant',
  'Sushumna — both nadis balanced',
];
const DEMO_BANDS = {
  Kshipta:   { delta:0.08, theta:0.15, alpha:0.22, beta:0.40, gamma:0.15 },
  Vikshipta: { delta:0.12, theta:0.22, alpha:0.28, beta:0.28, gamma:0.10 },
  Ekagra:    { delta:0.10, theta:0.20, alpha:0.42, beta:0.20, gamma:0.08 },
  Niruddha:  { delta:0.08, theta:0.35, alpha:0.38, beta:0.12, gamma:0.07 },
};
const SWARA_NOTES_MAP = {
  'Ida Nadi — right hemisphere dominant':      SWARA_NOTES.ida,
  'Pingala Nadi — left hemisphere dominant':   SWARA_NOTES.pingala,
  'Sushumna — both nadis balanced':            SWARA_NOTES.sushumna,
};

function makeDemoReading() {
  demoEpoch++;
  if (demoEpoch % 8 === 0) demoStateIdx = (demoStateIdx+1) % DEMO_STATES.length;
  if (demoEpoch % 5 === 0) demoSwaraIdx = (demoSwaraIdx+1) % DEMO_SWARA.length;

  const state = DEMO_STATES[demoStateIdx];
  const swara = DEMO_SWARA[demoSwaraIdx];
  const base  = DEMO_BANDS[state];

  const jit = v => Math.max(0.01, v + (Math.random()-0.5)*0.06);
  let d=jit(base.delta),t=jit(base.theta),a=jit(base.alpha),b=jit(base.beta),g=jit(base.gamma);
  const tot = d+t+a+b+g;
  d/=tot; t/=tot; a/=tot; b/=tot; g/=tot;
  const bp = { delta:d, theta:t, alpha:a, beta:b, gamma:g };

  const logits = [
    b*3.0+g*1.5-a*1.5,
    a*1.5+b*1.5-t*0.5,
    a*3.5+t*1.0-b*2.0,
    t*3.0+d*2.0-b*2.5,
  ];
  const probs  = softmax(logits);
  const probMap = {};
  DEMO_STATES.forEach((s,i)=>{ probMap[s]=(probs[i]*100).toFixed(1)+'%'; });

  const isIda = /ida/i.test(swara), isPingala = /pingala/i.test(swara);
  const asym  = isIda ? -(0.05+Math.random()*0.15) : isPingala ? (0.05+Math.random()*0.15) : 0;
  const depth = CHITTA_DEPTHS[state];

  const tattva = [];
  if (a>0.35 && t<0.25) tattva.push('Pratyahara Window');
  if (t>0.28 && a>0.28) tattva.push('Potential Tattva Activation');

  epoch = demoEpoch;
  return {
    timestamp: new Date().toISOString().slice(11,22)+' UTC',
    epoch, latency_ms: 30+Math.random()*40,
    data_quality: demoEpoch>3 ? '✓ clean' : '⚠ buffer filling',
    chitta_bhumi: { state, depth, confidence: probMap[state], probabilities: probMap },
    swara: { state: swara, confidence: 'Moderate', note: SWARA_NOTES_MAP[swara] },
    band_powers: { relative: bp },
    alpha_asymmetry: asym,
    tattva_flags: tattva,
    contemplative_depth: depth,
  };
}

function startDemo() {
  stopAll();
  mode = 'demo';
  demoStateIdx = demoSwaraIdx = demoEpoch = 0;
  setStatus('demo', 'demo mode');
  btnDemo.classList.add('active');
  demoIcon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  $('val-mode').textContent = 'synthetic demo';
  const tick = () => { const r = makeDemoReading(); applyReading(r); };
  tick();
  demoTimer = setInterval(tick, DEMO_INTERVAL);
}

function stopDemo() {
  clearInterval(demoTimer); demoTimer = null;
  mode = 'idle';
  setStatus('', 'disconnected');
  btnDemo.classList.remove('active');
  demoIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
}

// ── Bluetooth ─────────────────────────────────────────────────────────────────
async function connectBluetooth() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth is not supported. Use Chrome or Edge over HTTPS or localhost.');
    return;
  }
  try {
    stopAll();
    setStatus('bluetooth', 'scanning…');
    btnBt.classList.add('bt-active');

    btDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [MUSE_SERVICE_UUID, 'battery_service', 'device_information'],
    });

    const server = await btDevice.gatt.connect();
    setStatus('bluetooth', 'BLE — ' + (btDevice.name || 'device'));
    $('val-board').textContent = btDevice.name || 'BLE device';
    mode = 'bluetooth';

    // Show device row in settings
    btDeviceName.textContent = btDevice.name || 'Unknown device';
    btDeviceRow.style.display = 'flex';

    // Per-channel notification handlers
    const notifyHandlers = [];

    // Try Muse-specific service
    let isMuse = false;
    try {
      const svc = await server.getPrimaryService(MUSE_SERVICE_UUID);
      isMuse = true;
      // Send start command
      try {
        const ctrl = await svc.getCharacteristic(MUSE_CONTROL_UUID);
        await ctrl.writeValue(new Uint8Array([0x02, 0x64, 0x0a])); // 'd\n' — start streaming
      } catch { /* ignore */ }
      // Subscribe to EEG channels
      for (let ci = 0; ci < MUSE_EEG_UUIDS.length; ci++) {
        try {
          const ch = await svc.getCharacteristic(MUSE_EEG_UUIDS[ci]);
          await ch.startNotifications();
          const channelIdx = ci;
          const handler = e => {
            const dv = e.target.value;
            if (!dv) return;
            // Muse packet: 2-byte timestamp + 12 samples packed as 12-bit big-endian
            for (let i = 2; i < dv.byteLength; i += 2) {
              const raw = dv.getInt16(i, false);
              bleChannels[channelIdx].push(raw / 32768);
            }
            onBleSamples(channelIdx);
          };
          ch.addEventListener('characteristicvaluechanged', handler);
          notifyHandlers.push({ ch, handler });
        } catch { /* skip */ }
      }
    } catch { /* not Muse */ }

    // Generic BLE fallback
    if (!isMuse) {
      try {
        const services = await server.getPrimaryServices();
        for (const svc of services) {
          try {
            const chars = await svc.getCharacteristics();
            for (const ch of chars) {
              if (ch.properties.notify || ch.properties.indicate) {
                try {
                  await ch.startNotifications();
                  const handler = e => {
                    const dv = e.target.value;
                    if (!dv) return;
                    for (let i = 0; i+1 < dv.byteLength; i += 2) {
                      bleChannels[0].push(dv.getInt16(i, true) / 32768);
                    }
                    onBleSamples(0);
                  };
                  ch.addEventListener('characteristicvaluechanged', handler);
                  notifyHandlers.push({ ch, handler });
                } catch { /* skip */ }
              }
            }
          } catch { /* skip svc */ }
        }
      } catch { /* no services */ }
    }

    btDisconnect = () => {
      notifyHandlers.forEach(({ ch, handler }) => {
        try { ch.stopNotifications(); } catch { /* ignore */ }
        ch.removeEventListener('characteristicvaluechanged', handler);
      });
      if (btDevice?.gatt?.connected) btDevice.gatt.disconnect();
    };
    btDevice.addEventListener('gattserverdisconnected', onBtDisconnected);

    // If device sends nothing, keep a sim running so UI stays live
    const simId = setInterval(() => {
      if (mode !== 'bluetooth') { clearInterval(simId); return; }
      blePhase += 1 / SAMPLE_RATE;
      const s = simSample(blePhase);
      bleChannels[0].push(s);
      pushWave(s * 0.5);
      bleSamTick++;
      $('val-buffer').textContent = Math.min(bleChannels[0].length, COLLECT_N) + ' / ' + COLLECT_N;
      if (bleChannels[0].length >= COLLECT_N) {
        processAndPost();
      }
    }, 1000 / SAMPLE_RATE);

    // store simId in disconnect
    const prevDisc = btDisconnect;
    btDisconnect = () => { clearInterval(simId); prevDisc(); };

  } catch (err) {
    if (!err.message?.includes('User cancelled') && !err.message?.includes('cancelled')) {
      console.error('Bluetooth connection failed', err);
    }
    stopAll();
  }
}

function onBleSamples(channelIdx) {
  const ch = bleChannels[channelIdx];
  if (ch.length > 0) pushWave(ch[ch.length-1] * 0.5);
  $('val-buffer').textContent = Math.min(ch.length, COLLECT_N) + ' / ' + COLLECT_N;
  if (ch.length >= COLLECT_N) {
    processAndPost();
  }
}

async function processAndPost() {
  // snapshot and clear buffers
  const snapshot = bleChannels.map(ch => {
    const s = ch.slice(-COLLECT_N);
    ch.length = 0;
    return s;
  }).filter(ch => ch.length > 0);
  bleChannels.forEach(ch => { ch.length = 0; });
  $('val-buffer').textContent = '0 / ' + COLLECT_N;

  const t0 = performance.now();

  if (backendUrl) {
    // ── POST raw EEG to /analyze ──
    try {
      const res  = await fetch(backendUrl.replace(/\/$/, '') + '/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eeg_data: snapshot, sample_rate: SAMPLE_RATE }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      epoch++;
      const latency = (performance.now() - t0).toFixed(1);
      applyReading({
        epoch, latency_ms: parseFloat(latency),
        data_quality: '✓ BLE → Render',
        timestamp: new Date().toISOString().slice(11,22)+' UTC',
        chitta_bhumi: {
          state: data.chitta_bhumi?.state || '—',
          depth: data.chitta_bhumi?.depth || data.depth || '—',
          confidence: data.chitta_bhumi?.confidence || '—',
          probabilities: data.chitta_bhumi?.probabilities || {},
        },
        swara: { state: data.swara?.state || '—', confidence: '—', note: '' },
        tattva_flags: data.tattva || [],
        contemplative_depth: data.depth || '—',
        alpha_asymmetry: 0,
        eeg_spectrum: data.eeg_spectrum || null,
      });
      return;
    } catch (err) {
      console.warn('Backend /analyze failed, falling back to local FFT:', err.message);
    }
  }

  // ── Local FFT fallback ──
  const signal = snapshot[0] || [];
  if (signal.length < 64) return;
  const sz   = Math.pow(2, Math.floor(Math.log2(signal.length)));
  const mags = fft(signal.slice(-sz));
  const bp   = bandPowers(mags, SAMPLE_RATE, sz);
  const r    = classifyLocal(bp);
  r.latency_ms = parseFloat((performance.now() - t0).toFixed(1));
  applyReading(r);
}

function disconnectBluetooth() {
  if (btDisconnect) { btDisconnect(); btDisconnect = null; }
  btDevice = null;
  btDeviceRow.style.display = 'none';
  bleChannels.forEach(ch => { ch.length = 0; });
  mode = 'idle';
  setStatus('', 'disconnected');
  btnBt.classList.remove('bt-active');
  $('val-buffer').textContent = '0 / ' + COLLECT_N;
}

function onBtDisconnected() {
  if (mode === 'bluetooth') disconnectBluetooth();
}

// ── Backend URL mode (SSE/polling) ────────────────────────────────────────────
let sseSource  = null;
let pollTimer  = null;

function connectBackendUrl(url) {
  stopAll();
  mode = 'backend';
  setStatus('connected', 'live');
  $('val-mode').textContent = 'SSE / polling';

  // Try SSE first
  try {
    sseSource = new EventSource(url + '/stream');
    sseSource.onmessage = e => {
      try { applyReading(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    sseSource.onerror = () => {
      sseSource.close(); sseSource = null;
      startPolling(url);
    };
  } catch {
    startPolling(url);
  }
}

function startPolling(url) {
  pollTimer = setInterval(async () => {
    try {
      const res  = await fetch(url + '/reading', { signal: AbortSignal.timeout(4000) });
      const data = await res.json();
      applyReading(data);
    } catch { /* ignore */ }
  }, 1000);
}

// ── Stop everything ───────────────────────────────────────────────────────────
function stopAll() {
  clearInterval(demoTimer);  demoTimer = null;
  clearInterval(pollTimer);  pollTimer = null;
  if (sseSource) { sseSource.close(); sseSource = null; }
  if (mode === 'bluetooth') disconnectBluetooth();
  mode = 'idle';
  setStatus('', 'disconnected');
  btnDemo.classList.remove('active');
  btnBt.classList.remove('bt-active');
  demoIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
}

// ── Simulated EEG sample ──────────────────────────────────────────────────────
function simSample(t) {
  return (
    0.30 * Math.sin(t * 2*Math.PI * 2.0) +
    0.25 * Math.sin(t * 2*Math.PI * 6.0  + 1.1) +
    0.45 * Math.sin(t * 2*Math.PI * 10.0 + 2.3) +
    0.20 * Math.sin(t * 2*Math.PI * 20.0 + 0.7) +
    0.08 * Math.sin(t * 2*Math.PI * 38.0 + 1.8) +
    (Math.random()-0.5) * 0.15
  );
}

// ── Settings panel ────────────────────────────────────────────────────────────
btnSettings.addEventListener('click', () => {
  settingsOverlay.classList.toggle('open');
});
$('btn-close-settings').addEventListener('click', () => {
  settingsOverlay.classList.remove('open');
});
settingsOverlay.addEventListener('click', e => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove('open');
});

// load saved URL
if (backendUrl) inputUrl.value = backendUrl;

$('btn-test').addEventListener('click', async () => {
  const url = inputUrl.value.trim().replace(/\/$/, '');
  if (!url) { alert('Enter a URL first.'); return; }
  testMsg.style.display = '';
  testMsg.style.color = 'var(--text-muted)';
  testMsg.textContent = 'Testing…';
  try {
    const res  = await fetch(url + '/status', { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    testMsg.style.color = '#56A67A';
    testMsg.textContent = '✓ Connected — board: ' + (data.board || 'unknown');
  } catch (e) {
    testMsg.style.color = '#C75C5C';
    testMsg.textContent = '✗ ' + (e.message || 'connection failed');
  }
});

$('btn-save').addEventListener('click', () => {
  const url = inputUrl.value.trim().replace(/\/$/, '');
  if (!url) { alert('Enter a URL first.'); return; }
  backendUrl = url;
  localStorage.setItem('controlhub_url', url);
  settingsOverlay.classList.remove('open');
  connectBackendUrl(url);
});

// ── Bluetooth panel button ────────────────────────────────────────────────────
$('btn-bt-scan').addEventListener('click', async () => {
  settingsOverlay.classList.remove('open');
  await connectBluetooth();
});
$('btn-bt-disconnect').addEventListener('click', disconnectBluetooth);

// ── Header buttons ────────────────────────────────────────────────────────────
btnBt.addEventListener('click', async () => {
  if (mode === 'bluetooth') disconnectBluetooth();
  else await connectBluetooth();
});

btnDemo.addEventListener('click', () => {
  if (mode === 'demo') stopDemo();
  else startDemo();
});

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => { resizeCanvas(); });
resizeCanvas();
requestAnimationFrame(drawWave);
$('val-buffer').textContent = '0 / ' + COLLECT_N;
