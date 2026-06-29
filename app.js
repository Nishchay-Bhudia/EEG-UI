/**
 * controlhub — EEG frontend
 * Connects to a Python EEG backend running on Render via SSE or polling.
 * Falls back to demo mode when no backend is configured.
 */

'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const statusPill   = $('statusPill');
const statusDot    = $('statusDot');
const statusLabel  = $('statusLabel');
const settingsBtn  = $('settingsBtn');
const settingsOverlay = $('settingsOverlay');
const settingsClose   = $('settingsClose');
const demoBtn      = $('demoBtn');
const backendUrlInput = $('backendUrl');
const saveSettingsBtn = $('saveSettingsBtn');
const testConnectionBtn = $('testConnectionBtn');

// Reading display
const epochNum        = $('epochNum');
const qualityText     = $('qualityText');
const latencyText     = $('latencyText');
const chittaCard      = $('chittaCard');
const chittaStateName = $('chittaStateName');
const chittaDepthLabel= $('chittaDepthLabel');
const chittaDepthFill = $('chittaDepthFill');
const chittaConfidence= $('chittaConfidence');
const contemplativeDepth = $('contemplativeDepth');
const swaraCard       = $('swaraCard');
const swaraIda        = $('swaraIda');
const swaraSushumna   = $('swaraSushumna');
const swaraPingala    = $('swaraPingala');
const swaraState      = $('swaraState');
const swaraConfidence = $('swaraConfidence');
const swaraNote       = $('swaraNote');
const asymFill        = $('asymFill');
const asymThumb       = $('asymThumb');
const tattvaFlags     = $('tattvaFlags');
const footerTimestamp = $('footerTimestamp');
const footerBoard     = $('footerBoard');
const footerUptime    = $('footerUptime');
const footerMode      = $('footerMode');
const eegCanvas       = $('eegCanvas');
const ctx             = eegCanvas.getContext('2d');

// ── State ─────────────────────────────────────────────────────────────────
let backendUrl = localStorage.getItem('controlhub_url') || '';
let demoMode   = false;
let connected  = false;
let sseSource  = null;
let pollTimer  = null;
let demoTimer  = null;
let wavePhase  = 0;
let rafId      = null;

// EEG waveform ring buffer
const WAVE_LEN = 300;
const waveBuffer = new Float32Array(WAVE_LEN);
let waveTail = 0;

// ── Canvas setup ──────────────────────────────────────────────────────────
function resizeCanvas() {
  const dpr  = window.devicePixelRatio || 1;
  const rect = eegCanvas.parentElement.getBoundingClientRect();
  eegCanvas.width  = rect.width * dpr;
  eegCanvas.height = 110        * dpr;
  // Reset transform before applying DPR scale so repeated resizes don't compound.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── EEG Waveform renderer ─────────────────────────────────────────────────
function pushWaveSample(val) {
  waveBuffer[waveTail % WAVE_LEN] = val;
  waveTail++;
}

function renderWave() {
  const w = eegCanvas.clientWidth;
  const h = 110;

  ctx.clearRect(0, 0, w, h);

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#FFFFFF');
  bg.addColorStop(1, '#F7F6F2');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Centre grid line
  ctx.strokeStyle = '#E4E2DC';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Wave
  const len = Math.min(waveTail, WAVE_LEN);
  if (len < 2) { rafId = requestAnimationFrame(renderWave); return; }

  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0,   'rgba(217,119,87,0)');
  grad.addColorStop(0.2, 'rgba(217,119,87,0.8)');
  grad.addColorStop(0.85,'rgba(217,119,87,0.8)');
  grad.addColorStop(1,   'rgba(217,119,87,0.0)');

  ctx.strokeStyle = grad;
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.beginPath();

  for (let i = 0; i < len; i++) {
    const idx = (waveTail - len + i) % WAVE_LEN;
    const x   = (i / (len - 1)) * w;
    const y   = h / 2 - waveBuffer[(idx + WAVE_LEN) % WAVE_LEN] * (h * 0.34);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Fill beneath
  ctx.lineTo(w, h / 2);
  ctx.lineTo(0, h / 2);
  ctx.closePath();
  const fillGrad = ctx.createLinearGradient(0, h/2 - h*0.34, 0, h/2 + h*0.1);
  fillGrad.addColorStop(0, 'rgba(217,119,87,0.12)');
  fillGrad.addColorStop(1, 'rgba(217,119,87,0)');
  ctx.fillStyle = fillGrad;
  ctx.fill();

  rafId = requestAnimationFrame(renderWave);
}
rafId = requestAnimationFrame(renderWave);

// Idle animation when no signal
let idlePhase = 0;
function tickIdleWave() {
  if (!connected && !demoMode) {
    idlePhase += 0.04;
    const val = Math.sin(idlePhase) * 0.15 +
                Math.sin(idlePhase * 2.3 + 1) * 0.05 +
                Math.sin(idlePhase * 0.7 + 2) * 0.08;
    pushWaveSample(val);
  }
}
setInterval(tickIdleWave, 60);

// ── Status helpers ─────────────────────────────────────────────────────────
function setStatus(state, label) {
  statusPill.className = 'status-pill ' + (state || '');
  statusLabel.textContent = label;
}

function setFooterMode(mode) {
  footerMode.textContent = mode;
}

// ── Settings panel ─────────────────────────────────────────────────────────
settingsBtn.addEventListener('click', () => {
  settingsOverlay.classList.toggle('open');
  backendUrlInput.value = backendUrl;
});
settingsClose.addEventListener('click', () => settingsOverlay.classList.remove('open'));
settingsOverlay.addEventListener('click', e => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove('open');
});

saveSettingsBtn.addEventListener('click', () => {
  const url = backendUrlInput.value.trim().replace(/\/$/, '');
  if (!url) { alert('Please enter a valid URL.'); return; }
  backendUrl = url;
  localStorage.setItem('controlhub_url', url);
  settingsOverlay.classList.remove('open');
  stopDemo();
  connect();
});

testConnectionBtn.addEventListener('click', async () => {
  const url = backendUrlInput.value.trim().replace(/\/$/, '');
  if (!url) { alert('Enter a URL first.'); return; }
  testConnectionBtn.textContent = 'Testing…';
  testConnectionBtn.disabled = true;
  try {
    const r = await fetch(url + '/status', { signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    alert(`✓ Connected! Board: ${data.board || 'unknown'}, Uptime: ${data.uptime_seconds || 0}s`);
  } catch (e) {
    alert('✗ Connection failed: ' + e.message);
  } finally {
    testConnectionBtn.textContent = 'Test connection';
    testConnectionBtn.disabled = false;
  }
});

// ── Demo mode button ───────────────────────────────────────────────────────
demoBtn.addEventListener('click', () => {
  if (demoMode) { stopDemo(); } else { startDemo(); }
});

// ── Connection / SSE ───────────────────────────────────────────────────────
function connect() {
  if (!backendUrl) { setStatus('', 'no backend configured'); return; }
  disconnect();
  setStatus('', 'connecting…');
  footerBoard.textContent = '—';

  // Fetch status first
  fetch(backendUrl + '/status', { signal: AbortSignal.timeout(6000) })
    .then(r => r.json())
    .then(s => {
      footerBoard.textContent   = s.board || 'synthetic';
      footerUptime.textContent  = s.uptime_seconds != null ? formatUptime(s.uptime_seconds) : '—';
    })
    .catch(() => {});

  // Try SSE stream
  try {
    sseSource = new EventSource(backendUrl + '/stream');
    sseSource.onopen = () => {
      connected = true;
      setStatus('connected', 'live');
      setFooterMode('SSE stream');
    };
    sseSource.onmessage = e => {
      try { applyReading(JSON.parse(e.data)); } catch (_) {}
    };
    sseSource.onerror = () => {
      sseSource.close(); sseSource = null;
      connected = false;
      // Fall back to polling
      startPolling();
    };
  } catch (err) {
    startPolling();
  }
}

function startPolling() {
  if (pollTimer) return;
  setFooterMode('polling');
  pollTimer = setInterval(async () => {
    try {
      const r = await fetch(backendUrl + '/reading', { signal: AbortSignal.timeout(4000) });
      const data = await r.json();
      connected = true;
      setStatus('connected', 'live');
      applyReading(data);
    } catch (e) {
      connected = false;
      setStatus('error', 'connection lost');
    }
  }, 1000);
}

function disconnect() {
  if (sseSource)  { sseSource.close(); sseSource = null; }
  if (pollTimer)  { clearInterval(pollTimer); pollTimer = null; }
  connected = false;
  setStatus('', 'disconnected');
}

// Uptime refresh
setInterval(() => {
  if (connected && backendUrl) {
    fetch(backendUrl + '/status', { signal: AbortSignal.timeout(3000) })
      .then(r => r.json())
      .then(s => { footerUptime.textContent = s.uptime_seconds != null ? formatUptime(s.uptime_seconds) : '—'; })
      .catch(() => {});
  }
}, 30000);

// ── Apply reading to UI ────────────────────────────────────────────────────
function applyReading(data) {
  if (!data) return;

  // Epoch / quality / latency
  if (data.epoch != null)       epochNum.textContent    = data.epoch;
  if (data.latency_ms != null)  latencyText.textContent = data.latency_ms.toFixed(1) + ' ms';
  if (data.data_quality)        qualityText.textContent = data.data_quality;
  if (data.timestamp)           footerTimestamp.textContent = data.timestamp;

  // Chitta Bhumi
  const cb = data.chitta_bhumi;
  if (cb) {
    const state = cb.state || '—';
    chittaStateName.textContent  = state;
    chittaDepthLabel.textContent = cb.depth || '';

    // Depth fill %
    const depthMap = { Kshipta: 12, Vikshipta: 37, Ekagra: 62, Niruddha: 94 };
    chittaDepthFill.style.width  = (depthMap[state] ?? 0) + '%';

    // State class on card
    chittaCard.className = 'card chitta-card' + (state !== '—' ? ' state-' + state : '');

    // Depth node highlights
    document.querySelectorAll('.chitta-depth-nodes span').forEach(n => {
      n.classList.toggle('active', n.dataset.state === state);
    });

    // Confidence
    chittaConfidence.textContent = cb.confidence || '—';

    // Probabilities
    if (cb.probabilities) {
      ['Kshipta', 'Vikshipta', 'Ekagra', 'Niruddha'].forEach(s => {
        const row = document.querySelector(`.prob-row[data-state="${s}"]`);
        if (!row) return;
        const raw = cb.probabilities[s];
        // Accept either "82.3%" string or 0.823 numeric
        let pct = 0;
        if (typeof raw === 'string')  pct = parseFloat(raw);
        else if (typeof raw === 'number') pct = raw < 1.5 ? raw * 100 : raw;
        const display = typeof raw === 'string' ? raw : pct.toFixed(1) + '%';
        row.querySelector('.prob-fill').style.width = pct + '%';
        row.querySelector('.prob-val').textContent  = display;
      });
    }
  }

  // Contemplative depth
  const depth = data.contemplative_depth || (data.chitta_bhumi && data.chitta_bhumi.depth);
  if (depth) {
    contemplativeDepth.textContent = depth;
    contemplativeDepth.className   = 'depth-pill ' + depth;
  }

  // Swara
  const sw = data.swara;
  if (sw) {
    const rawState = sw.state || '';
    swaraState.textContent      = rawState;
    swaraConfidence.textContent = sw.confidence || '—';
    swaraNote.textContent       = sw.note || '';

    // Determine which nadi is active
    let active = 'sushumna';
    if (/ida/i.test(rawState))      active = 'ida';
    else if (/pingala/i.test(rawState)) active = 'pingala';

    swaraIda.className       = 'swara-glyph' + (active === 'ida'      ? ' active-ida'      : '');
    swaraSushumna.className  = 'swara-glyph' + (active === 'sushumna' ? ' active-sushumna' : '');
    swaraPingala.className   = 'swara-glyph' + (active === 'pingala'  ? ' active-pingala'  : '');
  }

  // Alpha asymmetry
  if (data.alpha_asymmetry != null) {
    const asym  = data.alpha_asymmetry; // range roughly -0.5..+0.5
    const clamped = Math.max(-0.5, Math.min(0.5, asym));
    const pct   = (clamped / 0.5) * 50; // -50%..+50% around centre
    const centre = 50; // 50% = midpoint of bar
    const pos    = centre + pct;

    asymThumb.style.left = pos + '%';

    // Fill from centre toward the active side
    if (pct > 0) {
      // right-dominant (Pingala side)
      asymFill.style.left       = centre + '%';
      asymFill.style.right      = (100 - pos) + '%';
      asymFill.style.background = 'var(--pingala)';
    } else if (pct < 0) {
      // left-dominant (Ida side)
      asymFill.style.left       = pos + '%';
      asymFill.style.right      = (100 - centre) + '%';
      asymFill.style.background = 'var(--ida)';
    } else {
      asymFill.style.left  = '50%';
      asymFill.style.right = '50%';
      asymFill.style.background = 'var(--sushumna)';
    }

    const isLeft = pct < 0 ? 'var(--ida)' : pct > 0 ? 'var(--pingala)' : 'var(--sushumna)';
    asymThumb.style.background = isLeft;
  }

  // Band powers
  const bp = data.band_powers && data.band_powers.relative;
  if (bp) {
    const setBar = (id, valId, band) => {
      const v = parseFloat(bp[band]) || 0;
      $(id).style.height   = Math.round(v * 100) + '%';
      $(valId).textContent = (v * 100).toFixed(1) + '%';
    };
    setBar('bandDelta', 'bandDeltaVal', 'delta');
    setBar('bandTheta', 'bandThetaVal', 'theta');
    setBar('bandAlpha', 'bandAlphaVal', 'alpha');
    setBar('bandBeta',  'bandBetaVal',  'beta');
    setBar('bandGamma', 'bandGammaVal', 'gamma');

    // Advance wave phase; actual sample injection happens in the loop below
    wavePhase += 0.18;
    // Push several samples per reading to keep wave smooth at 1 Hz cadence
    for (let i = 0; i < 18; i++) {
      const noise = (Math.random() - 0.5) * 0.08;
      const t = i / 18;
      const s = (
        (bp.delta || 0) * 0.6 * Math.sin((wavePhase - 0.18 + t * 0.18) * 2.0) +
        (bp.theta || 0) * 0.9 * Math.sin((wavePhase - 0.18 + t * 0.18) * 5.5 + 0.7) +
        (bp.alpha || 0) * 1.2 * Math.sin((wavePhase - 0.18 + t * 0.18) * 10  + 1.2) +
        (bp.beta  || 0) * 0.8 * Math.sin((wavePhase - 0.18 + t * 0.18) * 20  + 2.1) +
        (bp.gamma || 0) * 0.4 * Math.sin((wavePhase - 0.18 + t * 0.18) * 38  + 3.0) +
        noise
      );
      pushWaveSample(s);
    }
  }

  // Tattva flags
  applyTattvaFlags(data.tattva_flags || []);
}

function applyTattvaFlags(flags) {
  tattvaFlags.innerHTML = '';
  if (!flags || flags.length === 0) {
    tattvaFlags.innerHTML = '<span class="tattva-empty">no flags active</span>';
    return;
  }
  flags.forEach(f => {
    const span = document.createElement('span');
    span.className = 'tattva-flag ' + getTattvaClass(f);
    span.textContent = f;
    tattvaFlags.appendChild(span);
  });
}

function getTattvaClass(flag) {
  if (/tattva/i.test(flag))    return 'tattva-activation';
  if (/pratyahara/i.test(flag)) return 'pratyahara';
  if (/turiya/i.test(flag))    return 'turiya';
  if (/gamma/i.test(flag))     return 'gamma-spike';
  return 'other';
}

// ── Demo mode ──────────────────────────────────────────────────────────────
const DEMO_STATES = ['Kshipta', 'Vikshipta', 'Ekagra', 'Niruddha'];
const DEMO_DEPTH  = { Kshipta:'Surface', Vikshipta:'Emerging', Ekagra:'Deep', Niruddha:'Profound' };
const DEMO_SWARA  = [
  'Ida Nadi — right hemisphere dominant',
  'Pingala Nadi — left hemisphere dominant',
  'Sushumna — both nadis balanced',
];
const DEMO_NOTES  = {
  'Ida Nadi — right hemisphere dominant':
    'Parasympathetic dominance. Receptive, creative and introspective state.',
  'Pingala Nadi — left hemisphere dominant':
    'Sympathetic dominance. Active, analytical and goal-directed focus.',
  'Sushumna — both nadis balanced':
    'Equilibrium of solar and lunar channels. Gateway to higher contemplative states.',
};
const DEMO_TATTVA_POOL = [
  [], [], [],
  ['Pratyahara Window'],
  ['Potential Tattva Activation'],
  ['Turiya Approach'],
  ['Potential Tattva Activation', 'Pratyahara Window'],
];

let demoEpoch = 0;
let demoStateIdx = 0;
let demoSwaraIdx = 0;

function makeDemoReading() {
  demoEpoch++;
  // Slowly drift through states
  if (demoEpoch % 8 === 0) demoStateIdx = (demoStateIdx + 1) % DEMO_STATES.length;
  if (demoEpoch % 5 === 0) demoSwaraIdx = (demoSwaraIdx + 1) % DEMO_SWARA.length;

  const state = DEMO_STATES[demoStateIdx];
  const swara = DEMO_SWARA[demoSwaraIdx];

  // Band powers inspired by the state
  const bandProfiles = {
    Kshipta:   { delta:0.08, theta:0.15, alpha:0.22, beta:0.40, gamma:0.15 },
    Vikshipta: { delta:0.12, theta:0.22, alpha:0.28, beta:0.28, gamma:0.10 },
    Ekagra:    { delta:0.10, theta:0.20, alpha:0.42, beta:0.20, gamma:0.08 },
    Niruddha:  { delta:0.08, theta:0.35, alpha:0.38, beta:0.12, gamma:0.07 },
  };
  const base = bandProfiles[state];

  // Add some jitter
  const jitter = v => Math.max(0.01, v + (Math.random() - 0.5) * 0.06);
  const bands  = {};
  let total    = 0;
  for (const k in base) { bands[k] = jitter(base[k]); total += bands[k]; }
  for (const k in bands) bands[k] = parseFloat((bands[k] / total).toFixed(4));

  // Build probabilities
  const stateOrder = [...DEMO_STATES];
  const logits  = stateOrder.map(s => s === state ? 2.2 + Math.random() * 0.4 : Math.random() * 0.6);
  const expArr  = logits.map(Math.exp);
  const expSum  = expArr.reduce((a,b) => a+b, 0);
  const probs   = {};
  stateOrder.forEach((s,i) => { probs[s] = ((expArr[i]/expSum)*100).toFixed(1) + '%'; });

  // Alpha asymmetry
  const asymSign = /Ida/.test(swara) ? -1 : /Pingala/.test(swara) ? 1 : 0;
  const alphaAsym = asymSign * (0.05 + Math.random() * 0.15);

  const swaraConfMap = { 'Low': 0.45, 'Moderate': 0.65, 'High': 0.88 };
  const confKeys = ['Low', 'Moderate', 'High'];
  const confKey  = confKeys[demoStateIdx % 3];

  const tattvaPool = DEMO_TATTVA_POOL[demoEpoch % DEMO_TATTVA_POOL.length];

  const now = new Date();
  const ts = now.toISOString().slice(11, 22) + ' UTC';

  return {
    timestamp:   ts,
    epoch:       demoEpoch,
    latency_ms:  parseFloat((30 + Math.random() * 40).toFixed(1)),
    data_quality: demoEpoch > 3 ? '✓ clean' : '⚠ padded (buffer filling)',
    chitta_bhumi: {
      state:         state,
      depth:         DEMO_DEPTH[state],
      confidence:    probs[state],
      probabilities: probs,
    },
    swara: {
      state:      swara,
      confidence: confKey,
      note:       DEMO_NOTES[swara],
    },
    band_powers: { relative: bands },
    alpha_asymmetry:    parseFloat(alphaAsym.toFixed(4)),
    tattva_flags:       tattvaPool,
    contemplative_depth: DEMO_DEPTH[state],
  };
}

function startDemo() {
  if (demoMode) return;
  demoMode = true;
  demoBtn.classList.add('active');
  demoBtn.title = 'Stop demo';
  disconnect();
  setStatus('demo', 'demo mode');
  setFooterMode('synthetic demo');
  footerBoard.textContent = 'Synthetic Board';

  // Immediate first reading
  applyReading(makeDemoReading());
  demoTimer = setInterval(() => { applyReading(makeDemoReading()); }, 1200);
}

function stopDemo() {
  if (!demoMode) return;
  demoMode = false;
  demoBtn.classList.remove('active');
  demoBtn.title = 'Toggle demo mode';
  clearInterval(demoTimer);
  demoTimer = null;
  setStatus('', 'disconnected');
  setFooterMode('—');
}

// ── Helpers ────────────────────────────────────────────────────────────────
function formatUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}h ${m}m`
    : m > 0
    ? `${m}m ${sec}s`
    : `${sec}s`;
}

// ── Init ───────────────────────────────────────────────────────────────────
(function init() {
  // Pre-fill URL input
  backendUrlInput.value = backendUrl;

  // If backend URL stored, connect
  if (backendUrl) {
    connect();
  } else {
    setStatus('', 'no backend — use ⚙ to configure or ▶ for demo');
    footerMode.textContent = '—';
  }
})();
