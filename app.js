/* ════════════════════════════════════════════════════════════════════════════
   EEG DEV TESTING — app.js
   Modes: demo | bluetooth+backend | bluetooth-local | backend-url
   Auth: Login → Session management → Admin dashboard (dedicated page)
   New: Trigunas display, Session epoch storage, Admin session analytics
   New: Heart Rate + Blood Oxygen (SpO2) via PPG — silently skipped when
        the connected headset has no PPG sensor.
════════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const SAMPLE_RATE  = 256;
const COLLECT_SECS = 2;
const COLLECT_N    = SAMPLE_RATE * COLLECT_SECS;
const WAVE_LEN     = 300;
const DEMO_INTERVAL = 1200;

// Muse EEG BLE identifiers
const MUSE_SERVICE_UUID  = '0000fe8d-0000-1000-8000-00805f9b34fb';
const MUSE_CONTROL_UUID  = '273e0001-4c4d-454d-96be-f03bac821358';
const MUSE_EEG_UUIDS = [
  '273e0003-4c4d-454d-96be-f03bac821358',
  '273e0004-4c4d-454d-96be-f03bac821358',
  '273e0005-4c4d-454d-96be-f03bac821358',
  '273e0006-4c4d-454d-96be-f03bac821358',
];

// Muse PPG BLE characteristic UUIDs (Muse 2 / Muse S only).
// Other headsets (BrainBit, generic EEG bands) don't expose these —
// subscription attempts will silently fail and HR/SpO2 will stay hidden.
const MUSE_PPG_UUIDS = [
  '273e000f-4c4d-454d-96be-f03bac821358', // PPG ambient
  '273e0010-4c4d-454d-96be-f03bac821358', // PPG infrared (IR)
  '273e0011-4c4d-454d-96be-f03bac821358', // PPG red
];
const PPG_CH_AMBIENT = 0;
const PPG_CH_IR      = 1;
const PPG_CH_RED     = 2;
const PPG_SAMPLE_RATE = 64;                // Muse PPG runs at 64 Hz
const PPG_COLLECT_SECS = 10;              // seconds of PPG needed for HR
const PPG_COLLECT_N    = PPG_SAMPLE_RATE * PPG_COLLECT_SECS;

const DEPTH_PCT   = { Surface: 12, Emerging: 37, Deep: 62, Profound: 94 };
const CHITTA_DEPTHS = { Kshipta: 'Surface', Vikshipta: 'Emerging', Ekagra: 'Deep', Niruddha: 'Profound' };
const SWARA_NOTES = {
  ida:       'Parasympathetic dominance. Receptive, creative and introspective state.',
  pingala:   'Sympathetic dominance. Active, analytical and goal-directed focus.',
  sushumna:  'Equilibrium of solar and lunar channels. Gateway to higher contemplative states.',
};

// ── App state ─────────────────────────────────────────────────────────────────
let mode       = 'idle';
let backendUrl = localStorage.getItem('controlhub_url') || 'https://eeg-backend-5.onrender.com';
let btDevice   = null;
let btDisconnect = null;
let demoTimer  = null;
let epoch      = 0;
let demoStateIdx = 0;
let demoSwaraIdx = 0;
let demoEpoch  = 0;
let pollTimer  = null;
let sseSource  = null;
let backendPollTimer = null;

// Auth state
let currentUser = null; // { id, username, role }

// Session state
let activeSession        = null;  // { id, name, startTime }
let sessionTimerInterval = null;
let notesSaveTimeout     = null;
let sessionEpochCounter  = 0;
let sessionStartTimestamp = null;

// Admin page state
let adminCurrentTab      = 'users';
let resetPwTargetUserId  = null;

// EEG BLE buffers
const bleChannels = [[], [], [], []];
let blePhase  = 0;
let bleSamTick = 0;

// ── PPG state ─────────────────────────────────────────────────────────────────
// Three channels: ambient (0), IR (1), red (2).
// ppgEnabled flips true only when at least one PPG characteristic was found.
const ppgChannels = [[], [], []];
let ppgEnabled    = false;
let latestHeartRate = null; // BPM number or null
let latestSpo2      = null; // SpO2 % number or null

// Waveform
const waveBuf = new Float32Array(WAVE_LEN);
let waveTail  = 0;
let wavePhase = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Utility helpers ───────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function qAll(selector) { return Array.from(document.querySelectorAll(selector)); }

function formatDate(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleString();
}

function formatDuration(secs) {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

function formatTime(seconds) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
async function checkAuth() {
  try {
    currentUser = await api('GET', '/auth/me');
    showMainApp();
  } catch {
    showLoginScreen();
  }
}

function showLoginScreen() {
  $('login-screen').style.display = 'flex';
  $('main-header').style.display  = 'none';
  $('main-content').style.display = 'none';
  $('admin-page').style.display   = 'none';
}

function showMainApp() {
  $('login-screen').style.display = 'none';
  $('main-header').style.display  = '';
  $('main-content').style.display = '';
  $('admin-page').style.display   = 'none';

  $('user-avatar-initial').textContent = (currentUser.username[0] || '?').toUpperCase();
  $('user-display-name').textContent   = currentUser.username;
  $('user-menu-role').textContent      = currentUser.role;

  $('btn-open-admin').style.display = currentUser.role === 'admin' ? '' : 'none';

  resizeCanvas();
  requestAnimationFrame(drawWave);
  $('val-buffer').textContent = '0 / ' + COLLECT_N;

  if (backendUrl) {
    $('input-backend-url').value = backendUrl;
    connectBackendUrl(backendUrl);
  }

  loadSessionHistory();
}

function showAdminPage() {
  $('login-screen').style.display = 'none';
  $('main-header').style.display  = '';
  $('main-content').style.display = 'none';
  $('admin-page').style.display   = '';
  openAdminTab(adminCurrentTab);
}

// ── Login form ────────────────────────────────────────────────────────────────
$('btn-login').addEventListener('click', async () => {
  const username = $('input-username').value.trim();
  const password = $('input-password').value;
  const errEl    = $('login-error');
  errEl.style.display       = 'none';
  $('btn-login').disabled   = true;
  $('btn-login').textContent = 'Signing in…';
  try {
    currentUser = await api('POST', '/auth/login', { username, password });
    showMainApp();
  } catch (err) {
    errEl.textContent    = err.message || 'Login failed';
    errEl.style.display  = '';
  } finally {
    $('btn-login').disabled   = false;
    $('btn-login').textContent = 'Sign In';
  }
});

$('input-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-login').click();
});

// ── User menu ─────────────────────────────────────────────────────────────────
$('btn-user-menu').addEventListener('click', e => {
  e.stopPropagation();
  const dd = $('user-dropdown');
  dd.style.display = dd.style.display === 'none' ? '' : 'none';
});

document.addEventListener('click', () => {
  $('user-dropdown').style.display = 'none';
});

$('btn-logout').addEventListener('click', async () => {
  await api('POST', '/auth/logout').catch(() => {});
  currentUser   = null;
  activeSession = null;
  clearInterval(sessionTimerInterval);
  showLoginScreen();
});

// ── Settings ──────────────────────────────────────────────────────────────────
$('btn-settings').addEventListener('click', () => {
  $('settings-overlay').classList.toggle('open');
});
$('btn-close-settings').addEventListener('click', () => {
  $('settings-overlay').classList.remove('open');
});
$('settings-overlay').addEventListener('click', e => {
  if (e.target === $('settings-overlay')) $('settings-overlay').classList.remove('open');
});

$('btn-test').addEventListener('click', async () => {
  const url    = $('input-backend-url').value.trim().replace(/\/$/, '');
  const testEl = $('test-msg');
  if (!url) { alert('Enter a URL first.'); return; }
  testEl.style.display = '';
  testEl.style.color   = 'var(--text-muted)';
  testEl.textContent   = 'Testing…';
  try {
    const res  = await fetch(url + '/status', { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    testEl.style.color = '#56A67A';
    testEl.textContent = '✓ Connected — board: ' + (data.board || 'unknown');
  } catch (e) {
    testEl.style.color = '#C75C5C';
    testEl.textContent = '✗ ' + (e.message || 'connection failed');
  }
});

$('btn-save').addEventListener('click', () => {
  const url = $('input-backend-url').value.trim().replace(/\/$/, '');
  if (!url) { alert('Enter a URL first.'); return; }
  backendUrl = url;
  localStorage.setItem('controlhub_url', url);
  $('settings-overlay').classList.remove('open');
  connectBackendUrl(url);
});

// ── Admin page navigation ─────────────────────────────────────────────────────
$('btn-open-admin').addEventListener('click', () => { showAdminPage(); });
$('btn-back-to-dashboard').addEventListener('click', () => { showMainApp(); });

qAll('.admin-tab').forEach(tab => {
  tab.addEventListener('click', () => { openAdminTab(tab.dataset.tab); });
});

function openAdminTab(tabName) {
  adminCurrentTab = tabName;
  qAll('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  $('admin-tab-users').style.display    = tabName === 'users'    ? '' : 'none';
  $('admin-tab-sessions').style.display = tabName === 'sessions' ? '' : 'none';
  if (tabName === 'users')    loadAdminUsers();
  if (tabName === 'sessions') loadAdminSessions();
}

// ── Admin: Users tab ──────────────────────────────────────────────────────────
$('btn-add-user').addEventListener('click', () => {
  $('create-user-form').style.display  = '';
  $('create-user-error').style.display = 'none';
});

$('btn-cancel-create').addEventListener('click', () => {
  $('create-user-form').style.display = 'none';
});

$('btn-submit-create').addEventListener('click', async () => {
  const username = $('new-username').value.trim();
  const password = $('new-password').value;
  const role     = $('new-role').value;
  const errEl    = $('create-user-error');
  errEl.style.display = 'none';
  try {
    await api('POST', '/users', { username, password, role });
    $('new-username').value = '';
    $('new-password').value = '';
    $('create-user-form').style.display = 'none';
    loadAdminUsers();
  } catch (err) {
    errEl.textContent   = err.message;
    errEl.style.display = '';
  }
});

async function loadAdminUsers() {
  const tbody = $('admin-users-tbody');
  tbody.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';
  try {
    const users = await api('GET', '/users');
    tbody.innerHTML = '';
    users.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escHtml(u.username)}</td>
        <td><span class="role-badge role-${u.role}">${escHtml(u.role)}</span></td>
        <td>${formatDate(u.createdAt)}</td>
        <td class="user-actions">
          <button class="btn btn-sm btn-outline" data-action="reset-pw" data-uid="${u.id}" data-uname="${escHtml(u.username)}">Reset PW</button>
          <button class="btn btn-sm btn-danger" data-action="delete-user" data-uid="${u.id}">Delete</button>
        </td>`;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-danger">${escHtml(err.message)}</td></tr>`;
  }
}

$('admin-users-tbody').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const uid   = parseInt(btn.dataset.uid, 10);
  const uname = btn.dataset.uname || '';

  if (btn.dataset.action === 'delete-user') {
    if (!confirm(`Delete user "${uname}"? This cannot be undone.`)) return;
    try {
      await api('DELETE', '/users/' + uid);
      loadAdminUsers();
    } catch (err) { alert(err.message); }
  }

  if (btn.dataset.action === 'reset-pw') {
    resetPwTargetUserId = uid;
    $('reset-pw-target').textContent = uname;
    $('reset-pw-form').style.display  = '';
    $('reset-pw-error').style.display = 'none';
    $('new-pw-input').value = '';
  }
});

$('btn-cancel-reset-pw').addEventListener('click', () => {
  $('reset-pw-form').style.display = 'none';
  resetPwTargetUserId = null;
});

$('btn-submit-reset-pw').addEventListener('click', async () => {
  const pw    = $('new-pw-input').value;
  const errEl = $('reset-pw-error');
  errEl.style.display = 'none';
  try {
    await api('PUT', '/users/' + resetPwTargetUserId + '/password', { password: pw });
    $('reset-pw-form').style.display = 'none';
    resetPwTargetUserId = null;
  } catch (err) {
    errEl.textContent   = err.message;
    errEl.style.display = '';
  }
});

// ── Admin: Sessions tab ───────────────────────────────────────────────────────
async function loadAdminSessions() {
  const tbody = $('admin-sessions-tbody');
  tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
  try {
    const sessions = await api('GET', '/sessions');
    tbody.innerHTML = '';
    if (!sessions.length) {
      tbody.innerHTML = '<tr><td colspan="6">No sessions yet.</td></tr>';
      return;
    }
    sessions.forEach(s => {
      const tr = document.createElement('tr');
      tr.dataset.username = (s.username || '').toLowerCase();
      tr.innerHTML = `
        <td>${escHtml(s.username || '?')}</td>
        <td><strong>${escHtml(s.name)}</strong></td>
        <td>${formatDate(s.startTime)}</td>
        <td>${s.duration ? formatDuration(s.duration) : (s.endTime ? '—' : '<em>active</em>')}</td>
        <td id="epoch-count-${s.id}">—</td>
        <td><button class="btn btn-sm btn-outline" data-action="view-analytics" data-sid="${s.id}" data-sname="${escHtml(s.name)}">View Analytics</button></td>`;
      tbody.appendChild(tr);
    });
    loadEpochCounts(sessions);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-danger">${escHtml(err.message)}</td></tr>`;
  }
}

async function loadEpochCounts(sessions) {
  await Promise.allSettled(sessions.map(async s => {
    try {
      const data = await api('GET', '/sessions/' + s.id + '/analytics');
      const el = $('epoch-count-' + s.id);
      if (el) el.textContent = data.summary?.totalEpochs ?? 0;
    } catch { /* ignore */ }
  }));
}

$('admin-sessions-tbody').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action="view-analytics"]');
  if (!btn) return;
  const sid   = parseInt(btn.dataset.sid, 10);
  const sname = btn.dataset.sname;
  openSessionAnalytics(sid, sname);
});

// ── Session Analytics Overlay ─────────────────────────────────────────────────
$('btn-close-analytics').addEventListener('click', () => {
  $('analytics-overlay').style.display = 'none';
});
$('analytics-overlay').addEventListener('click', e => {
  if (e.target === $('analytics-overlay')) $('analytics-overlay').style.display = 'none';
});

async function openSessionAnalytics(sessionId, sessionName) {
  const overlay = $('analytics-overlay');
  overlay.style.display = 'flex';
  $('analytics-session-name').textContent = sessionName || 'Session Analytics';
  $('analytics-session-meta').textContent = '';
  $('analytics-loading').style.display    = '';
  $('analytics-error').style.display      = 'none';
  $('analytics-content').style.display    = 'none';

  try {
    const data = await api('GET', '/sessions/' + sessionId + '/analytics');
    renderSessionAnalytics(data);
  } catch (err) {
    $('analytics-loading').style.display = 'none';
    $('analytics-error').style.display   = '';
    $('analytics-error').textContent     = 'Failed to load analytics: ' + err.message;
  }
}

function renderSessionAnalytics(data) {
  const { session, summary } = data;
  $('analytics-loading').style.display  = 'none';
  $('analytics-content').style.display  = '';

  $('analytics-session-name').textContent = session.name;
  $('analytics-session-meta').textContent =
    `${session.username || '?'} · ${formatDate(session.startTime)}` +
    (session.duration ? ` · ${formatDuration(session.duration)}` : '');

  $('a-total-epochs').textContent   = summary.totalEpochs ?? '—';
  $('a-duration').textContent       = summary.durationSeconds ? formatDuration(summary.durationSeconds) : '—';

  const gunaLabel = summary.dominantGuna
    ? summary.dominantGuna.charAt(0).toUpperCase() + summary.dominantGuna.slice(1)
    : '—';
  $('a-dominant-guna').textContent = gunaLabel;
  $('a-dominant-guna').style.color = summary.dominantGuna === 'sattva' ? 'var(--sattva)'
    : summary.dominantGuna === 'rajas' ? 'var(--rajas)'
    : summary.dominantGuna === 'tamas' ? 'var(--tamas)' : 'var(--text)';

  const stateEntries = Object.entries(summary.stateBreakdown || {}).sort((a, b) => b[1] - a[1]);
  $('a-dominant-state').textContent = stateEntries[0]?.[0] ?? '—';

  const avgGunas = summary.avgGunas || {};
  setAnalyticsGuna('sattva', avgGunas.sattva);
  setAnalyticsGuna('rajas',  avgGunas.rajas);
  setAnalyticsGuna('tamas',  avgGunas.tamas);

  const stateColors = { Kshipta: 'var(--kshipta)', Vikshipta: 'var(--vikshipta)', Ekagra: 'var(--ekagra)', Niruddha: 'var(--niruddha)' };
  renderBreakdownList('a-state-breakdown', summary.stateBreakdown || {}, stateColors);

  const swaraColors = { Ida: 'var(--ida)', Pingala: 'var(--pingala)', Sushumna: 'var(--sushumna)' };
  renderBreakdownList('a-swara-breakdown', summary.swaraBreakdown || {}, swaraColors);

  renderAvgBands(summary.avgBands || {});
  renderTimeline(summary.phases || []);

  // ── Biometrics summary in analytics (only rendered if data exists) ─────────
  const hrEl   = $('a-avg-heart-rate');
  const spo2El = $('a-avg-spo2');
  if (hrEl)   hrEl.textContent   = summary.avgHeartRate  != null ? summary.avgHeartRate.toFixed(1)  + ' BPM' : '—';
  if (spo2El) spo2El.textContent = summary.avgSpo2       != null ? summary.avgSpo2.toFixed(1)       + ' %'   : '—';
}

function setAnalyticsGuna(name, value) {
  const pct  = value != null ? (value * 100).toFixed(1) : null;
  const bar  = $('a-bar-' + name);
  const pctEl = $('a-pct-' + name);
  if (bar)   bar.style.width   = pct ? pct + '%' : '0%';
  if (pctEl) pctEl.textContent = pct ? pct + '%' : '—';
}

function renderBreakdownList(containerId, breakdown, colorMap) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = '';
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { el.innerHTML = '<p class="text-muted">No data</p>'; return; }
  entries.forEach(([label, pct]) => {
    const color = colorMap[label] || 'var(--accent)';
    const div   = document.createElement('div');
    div.className = 'breakdown-item';
    div.innerHTML = `
      <span class="breakdown-label">${escHtml(label)}</span>
      <div class="breakdown-bar-wrap"><div class="breakdown-bar" style="width:${pct}%;background:${color}"></div></div>
      <span class="breakdown-pct">${pct}%</span>`;
    el.appendChild(div);
  });
}

function renderAvgBands(bands) {
  const container = $('a-avg-bands');
  if (!container) return;
  container.innerHTML = '';
  const defs = [
    { key: 'delta', sym: 'δ', name: 'Delta', color: 'var(--delta)' },
    { key: 'theta', sym: 'θ', name: 'Theta', color: 'var(--theta)' },
    { key: 'alpha', sym: 'α', name: 'Alpha', color: 'var(--alpha)' },
    { key: 'beta',  sym: 'β', name: 'Beta',  color: 'var(--beta)'  },
    { key: 'gamma', sym: 'γ', name: 'Gamma', color: 'var(--gamma)' },
  ];
  defs.forEach(({ key, sym, name, color }) => {
    const val = bands[key];
    const pct = val != null ? (val * 100).toFixed(1) + '%' : '—';
    const div = document.createElement('div');
    div.className = 'analytics-band-pill';
    div.innerHTML = `<span class="band-sym" style="color:${color}">${sym}</span><span class="band-name">${name}</span><span class="band-pct">${pct}</span>`;
    container.appendChild(div);
  });
}

function renderTimeline(phases) {
  const container = $('a-timeline');
  if (!container) return;
  container.innerHTML = '';
  if (!phases.length) {
    container.innerHTML = '<p class="text-muted">No epoch data recorded for this session.</p>';
    return;
  }
  phases.forEach(phase => {
    const fromStr = phase.fromSeconds != null ? formatTime(phase.fromSeconds) : '—';
    const toStr   = phase.toSeconds   != null ? formatTime(phase.toSeconds)   : '—';
    const timeStr = `${fromStr} → ${toStr}`;

    const gunas = phase.avgGunas || {};
    const dominantGunaKey = Object.entries(gunas).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0]?.[0];
    const gunaLabels = { sattva: '☀ Sattvic', rajas: '🔥 Rajasic', tamas: '🌑 Tamasic' };
    const gunaClass  = { sattva: 'tgb-sattva', rajas: 'tgb-rajas', tamas: 'tgb-tamas' };
    const gunaBadge  = dominantGunaKey
      ? `<span class="triguna-badge ${gunaClass[dominantGunaKey]}">${gunaLabels[dominantGunaKey]}</span>`
      : '';

    const bands   = phase.avgBands || {};
    const topBand = Object.entries(bands).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0];
    const bandNote = topBand ? `Dominant band: ${topBand[0]} (${(topBand[1] * 100).toFixed(1)}%)` : '';

    const div = document.createElement('div');
    div.className = `timeline-phase phase-${phase.state}`;
    div.innerHTML = `
      <div class="phase-header">
        <span class="phase-time">${escHtml(timeStr)}</span>
        <span class="phase-state">${escHtml(phase.state)}</span>
        <span class="phase-depth">${escHtml(phase.depth || '')}</span>
        ${bandNote ? `<span class="phase-band">${escHtml(bandNote)}</span>` : ''}
      </div>
      <div class="phase-footer">
        ${gunaBadge}
        <span class="phase-count">${phase.epochCount} epoch${phase.epochCount !== 1 ? 's' : ''}</span>
      </div>`;
    container.appendChild(div);
  });
}

// ── EEG Readings → UI ─────────────────────────────────────────────────────────
function setStatus(type, text) {
  const dot = $('status-dot');
  const txt = $('status-text');
  dot.className  = 'status-dot' + (type ? ' ' + type : '');
  txt.textContent = text;
}

/**
 * applyReading — apply a full inference result to every UI widget.
 * Also stores epoch data to DB if a session is active.
 */
function applyReading(r) {
  // ── Epoch / quality / latency ──
  $('val-epoch').textContent   = r.epoch ?? epoch;
  $('val-quality').textContent = r.data_quality || '—';
  $('val-latency').textContent = r.latency_ms != null ? r.latency_ms.toFixed(1) : '—';

  // ── Chitta Bhumi ──
  const ch    = r.chitta_bhumi || {};
  const state = ch.state || '—';
  $('chitta-state').textContent = state;
  $('chitta-sub').textContent   = ch.depth || ch.confidence || '—';

  const depth      = ch.depth || CHITTA_DEPTHS[state] || 'Surface';
  const depthPct   = DEPTH_PCT[depth] ?? 12;
  const depthColor = state === 'Kshipta'   ? 'var(--kshipta)'  :
                     state === 'Vikshipta' ? 'var(--vikshipta)' :
                     state === 'Ekagra'    ? 'var(--ekagra)'    : 'var(--niruddha)';
  const depthFill  = $('depth-fill');
  depthFill.style.width      = depthPct + '%';
  depthFill.style.background = depthColor;

  $('val-confidence').textContent = ch.confidence || '—';
  $('val-depth').textContent      = depth;

  const probs = ch.probabilities || {};
  ['Kshipta', 'Vikshipta', 'Ekagra', 'Niruddha'].forEach(s => {
    const raw = probs[s] ?? '0%';
    const pct = parseFloat(raw);
    const key = s.toLowerCase();
    const el  = $('prob-' + key);
    const bar = $('bar-'  + key);
    if (el)  el.textContent    = isNaN(pct) ? raw : pct.toFixed(1) + '%';
    if (bar) bar.style.width   = (isNaN(pct) ? parseFloat(raw) : pct) + '%';
  });

  // ── Swara ──
  const sw    = r.swara || {};
  const sst   = (sw.state || '').toLowerCase();
  const isIda      = /ida/.test(sst);
  const isPingala  = !isIda && /pingala/.test(sst);
  const isSushumna = !isIda && !isPingala;

  $('swara-note').textContent       = sw.note || (isIda ? SWARA_NOTES.ida : isPingala ? SWARA_NOTES.pingala : SWARA_NOTES.sushumna);
  $('swara-confidence').textContent = sw.confidence || '—';

  $('glyph-ida').className      = 'swara-glyph' + (isIda      ? ' active-ida'      : '');
  $('glyph-sushumna').className  = 'swara-glyph' + (isSushumna ? ' active-sushumna' : '');
  $('glyph-pingala').className   = 'swara-glyph' + (isPingala  ? ' active-pingala'  : '');

  const asym    = r.alpha_asymmetry || 0;
  const clamped = Math.max(-0.5, Math.min(0.5, asym));
  const pct     = (clamped / 0.5) * 50;
  const thumbL  = (50 + pct) + '%';
  const fillBg  = isIda ? 'var(--ida)' : isPingala ? 'var(--pingala)' : 'var(--sushumna)';
  const thumb   = $('asym-thumb');
  const fillEl  = $('asym-fill');
  thumb.style.left       = thumbL;
  thumb.style.background = fillBg;
  if (pct > 0) {
    fillEl.style.left  = '50%';
    fillEl.style.right = (100 - (50 + pct)) + '%';
    fillEl.style.background = fillBg;
  } else if (pct < 0) {
    fillEl.style.left  = (50 + pct) + '%';
    fillEl.style.right = '50%';
    fillEl.style.background = fillBg;
  } else {
    fillEl.style.left = fillEl.style.right = '50%';
  }

  // ── Spectral Band Powers ──
  const spectrum = r.eeg_spectrum || (r.band_powers && r.band_powers.relative) || {};
  ['delta', 'theta', 'alpha', 'beta', 'gamma'].forEach(b => {
    const raw = spectrum[b] ?? null;
    const pct = raw != null ? (raw * 100).toFixed(1) : null;
    const valEl = $('val-' + b);
    const barEl = $('bar-' + b);
    if (valEl) valEl.textContent   = pct ? pct + '%' : '—';
    if (barEl) barEl.style.width   = pct ? Math.min(pct, 100) + '%' : '0%';
  });

  // ── Tattva Flags ──
  const flags   = r.tattva_flags || r.tattva || [];
  const flagDiv = $('tattva-flags');
  flagDiv.innerHTML = '';
  if (!flags.length) {
    flagDiv.innerHTML = '<span class="tattva-none">no flags active</span>';
  } else {
    flags.forEach(f => {
      const span = document.createElement('span');
      let cls = 'tattva-other';
      if (/tattva/i.test(f))      cls = 'tattva-activation';
      else if (/pratyahara/i.test(f)) cls = 'pratyahara';
      else if (/turiya/i.test(f))     cls = 'turiya';
      else if (/gamma/i.test(f))      cls = 'gamma-spike';
      span.className   = 'tattva-flag ' + cls;
      span.textContent = f;
      flagDiv.appendChild(span);
    });
  }

  // ── Trigunas ──
  applyGunas(r.gunas);

  // ── Biometrics from backend response (if backend returns HR/SpO2) ──────────
  // Backend returns these when PPG data was included in the /analyze request.
  // If not provided, fall back to the locally-computed values (from BLE PPG).
  if (r.heart_rate != null) latestHeartRate = r.heart_rate;
  if (r.spo2       != null) latestSpo2      = r.spo2;
  updateBiometricsUI();

  // ── Store epoch to DB (if session active) ──
  if (activeSession) {
    storeEpoch(r, spectrum, flags);
  }

  // ── Waveform pulse ──
  const ampSrc = spectrum.alpha || spectrum.theta || 0.2;
  const amp    = 0.3 + ampSrc * 1.5;
  for (let i = 0; i < 8; i++) {
    waveBuf[waveTail % WAVE_LEN] = Math.sin(wavePhase + i * 0.8) * amp;
    waveTail++;
    wavePhase += 0.18;
  }
}

// ── Biometrics UI update ──────────────────────────────────────────────────────
/**
 * Update Heart Rate and SpO2 widgets.
 * If values are null (headset has no PPG or data not yet ready),
 * the widget stays visible but shows nothing — no error displayed.
 */
function updateBiometricsUI() {
  const hrValEl   = $('val-heart-rate');
  const spo2ValEl = $('val-spo2');

  if (hrValEl) {
    hrValEl.textContent = latestHeartRate != null ? Math.round(latestHeartRate) + '' : '—';
  }
  if (spo2ValEl) {
    spo2ValEl.textContent = latestSpo2 != null ? latestSpo2.toFixed(1) + '' : '—';
  }
}

// ── Trigunas UI ───────────────────────────────────────────────────────────────
function applyGunas(gunas) {
  if (!gunas) gunas = computeLocalGunas();
  const { sattva = 0, rajas = 0, tamas = 0, label = '—', note = '' } = gunas;

  $('val-sattva').textContent = (sattva * 100).toFixed(1) + '%';
  $('val-rajas').textContent  = (rajas  * 100).toFixed(1) + '%';
  $('val-tamas').textContent  = (tamas  * 100).toFixed(1) + '%';

  $('bar-sattva').style.width = (sattva * 100) + '%';
  $('bar-rajas').style.width  = (rajas  * 100) + '%';
  $('bar-tamas').style.width  = (tamas  * 100) + '%';

  $('gunas-dominant').textContent = label || '—';
  $('gunas-note').textContent     = note  || '';
}

function computeLocalGunas() {
  const get = id => parseFloat($('bar-' + id)?.style.width || '0') / 100;
  const alpha = get('alpha'), theta = get('theta'), beta = get('beta'),
        delta = get('delta'), gamma = get('gamma');

  let sat = alpha * 3.0 + theta * 1.5 - beta  * 1.5;
  let raj = beta  * 3.0 + gamma * 2.5 - alpha * 1.5;
  let tam = delta * 3.0 - alpha * 1.5;

  sat = Math.max(sat, 0.05); raj = Math.max(raj, 0.05); tam = Math.max(tam, 0.05);
  const total = sat + raj + tam;
  sat /= total; raj /= total; tam /= total;

  const dominant = sat > raj && sat > tam ? 'sattva' : raj > tam ? 'rajas' : 'tamas';
  const maxVal   = Math.max(sat, raj, tam);
  let label = 'Balanced';
  if (maxVal > 0.45) label = dominant === 'sattva' ? 'Sattvic' : dominant === 'rajas' ? 'Rajasic' : 'Tamasic';

  return { sattva: +sat.toFixed(4), rajas: +raj.toFixed(4), tamas: +tam.toFixed(4), label, note: '' };
}

// ── Store epoch data to DB ────────────────────────────────────────────────────
async function storeEpoch(r, spectrum, flags) {
  if (!activeSession) return;
  sessionEpochCounter++;

  const elapsedSeconds = sessionStartTimestamp
    ? (Date.now() - sessionStartTimestamp.getTime()) / 1000
    : null;

  const ch    = r.chitta_bhumi || {};
  const sw    = r.swara || {};
  const gunas = r.gunas || computeLocalGunas();

  const swaraState  = sw.state || '';
  const swaraSimple = /ida/i.test(swaraState)     ? 'Ida'     :
                      /pingala/i.test(swaraState)  ? 'Pingala' : 'Sushumna';

  const epochBody = {
    epochNum:          sessionEpochCounter,
    elapsedSeconds:    elapsedSeconds ? +elapsedSeconds.toFixed(2) : null,
    chittaBhumi:       ch.state      || null,
    chittaConfidence:  ch.confidence || null,
    contemplativeDepth: ch.depth     || null,
    swara:             swaraSimple,
    swaraConfidence:   sw.confidence || null,
    bands: {
      delta: spectrum.delta ?? null,
      theta: spectrum.theta ?? null,
      alpha: spectrum.alpha ?? null,
      beta:  spectrum.beta  ?? null,
      gamma: spectrum.gamma ?? null,
    },
    gunas: {
      sattva: gunas.sattva ?? null,
      rajas:  gunas.rajas  ?? null,
      tamas:  gunas.tamas  ?? null,
      label:  gunas.label  || null,
    },
    tattvaFlags: flags || [],
    // ── Biometrics — null when the headset has no PPG sensor ─────────────
    heartRate: latestHeartRate ?? null,
    spo2:      latestSpo2      ?? null,
  };

  // Fire-and-forget
  api('POST', '/sessions/' + activeSession.id + '/epoch', epochBody)
    .catch(err => console.warn('[Epoch store] failed:', err.message));
}

// ── Local FFT + classification ────────────────────────────────────────────────
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

  const asym       = (Math.random()-0.5) * 0.3;
  const isIda      = asym < -0.04, isPingala = asym > 0.04;
  const swaraState = isIda ? 'Ida Nadi — right hemisphere dominant'
    : isPingala ? 'Pingala Nadi — left hemisphere dominant'
    : 'Sushumna — both nadis balanced';
  const swaraNote  = isIda ? SWARA_NOTES.ida : isPingala ? SWARA_NOTES.pingala : SWARA_NOTES.sushumna;

  const tattva = [];
  if (bp.alpha>0.35 && bp.theta<0.25) tattva.push('Pratyahara Window');
  if (bp.theta>0.28 && bp.alpha>0.28) tattva.push('Potential Tattva Activation');
  if (bp.theta>0.32 && bp.delta>0.12) tattva.push('Turiya Approach');
  if (bp.gamma>0.12) tattva.push('Gamma Spike');

  epoch++;
  const depth = CHITTA_DEPTHS[state];
  return {
    epoch, latency_ms: 20 + Math.random()*10,
    data_quality: '✓ local FFT',
    chitta_bhumi: { state, depth, confidence: probMap[state], probabilities: probMap },
    swara: { state: swaraState, confidence: Math.abs(asym)>0.12 ? 'High' : 'Moderate', note: swaraNote },
    band_powers: { relative: bp },
    eeg_spectrum: bp,
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
const DEMO_BANDS  = {
  Kshipta:   { delta:0.08, theta:0.15, alpha:0.22, beta:0.40, gamma:0.15 },
  Vikshipta: { delta:0.12, theta:0.22, alpha:0.28, beta:0.28, gamma:0.10 },
  Ekagra:    { delta:0.10, theta:0.20, alpha:0.42, beta:0.20, gamma:0.08 },
  Niruddha:  { delta:0.08, theta:0.35, alpha:0.38, beta:0.12, gamma:0.07 },
};
const SWARA_NOTES_MAP = {
  'Ida Nadi — right hemisphere dominant':     SWARA_NOTES.ida,
  'Pingala Nadi — left hemisphere dominant':  SWARA_NOTES.pingala,
  'Sushumna — both nadis balanced':           SWARA_NOTES.sushumna,
};

function startDemo() {
  stopAll();
  mode = 'demo';
  setStatus('connected', 'demo running');
  $('btn-demo').textContent = '⏹ Stop Demo';
  $('val-mode').textContent  = 'demo';
  $('val-board').textContent = 'synthetic';

  demoEpoch = 0;
  const tick = () => {
    demoEpoch++;
    const state    = DEMO_STATES[demoStateIdx];
    const swaraStr = DEMO_SWARA[demoSwaraIdx];
    const bp       = DEMO_BANDS[state];

    const probMap = {};
    DEMO_STATES.forEach((s, i) => {
      probMap[s] = (i === demoStateIdx ? 72 + Math.random()*10 : 5 + Math.random()*8).toFixed(1) + '%';
    });
    const asym = demoSwaraIdx === 0 ? -0.2 : demoSwaraIdx === 1 ? 0.2 : 0.01;

    epoch++;
    applyReading({
      epoch,
      latency_ms:   18 + Math.random()*6,
      data_quality: '✓ demo mode',
      chitta_bhumi: {
        state,
        depth:       CHITTA_DEPTHS[state],
        confidence:  (72 + Math.random()*10).toFixed(1) + '%',
        probabilities: probMap,
      },
      swara: {
        state:      swaraStr,
        confidence: Math.abs(asym) > 0.12 ? 'High' : 'Moderate',
        note:       SWARA_NOTES_MAP[swaraStr],
      },
      eeg_spectrum:       bp,
      alpha_asymmetry:    asym,
      tattva_flags:       [],
      contemplative_depth: CHITTA_DEPTHS[state],
      // No biometrics in demo — widgets show '—' silently
      heart_rate: null,
      spo2:       null,
    });

    if (demoEpoch % 5 === 0) demoStateIdx = (demoStateIdx + 1) % DEMO_STATES.length;
    if (demoEpoch % 7 === 0) demoSwaraIdx = (demoSwaraIdx + 1) % DEMO_SWARA.length;
  };

  tick();
  demoTimer = setInterval(tick, DEMO_INTERVAL);
}

function stopDemo() {
  clearInterval(demoTimer); demoTimer = null;
  mode = 'idle';
  $('btn-demo').textContent = '▶ Demo';
  setStatus('', 'disconnected');
}

$('btn-demo').addEventListener('click', () => {
  if (mode === 'demo') stopDemo();
  else startDemo();
});

// ── PPG processing ────────────────────────────────────────────────────────────

/**
 * Compute heart rate (BPM) from an IR PPG signal using simple peak detection.
 * Returns null if signal is too short, flat, noisy, or BPM is out of range.
 */
function computeHeartRate(irSamples) {
  if (irSamples.length < PPG_SAMPLE_RATE * 4) return null;

  // Moving-average smooth (~125 ms window)
  const k = Math.max(4, Math.round(PPG_SAMPLE_RATE * 0.125));
  const smoothed = [];
  for (let i = k; i < irSamples.length; i++) {
    let sum = 0;
    for (let j = 0; j < k; j++) sum += irSamples[i - j];
    smoothed.push(sum / k);
  }

  const sMin = Math.min(...smoothed);
  const sMax = Math.max(...smoothed);
  if (sMax - sMin < 100) return null; // flat signal

  // Normalise to 0–1
  const norm = smoothed.map(v => (v - sMin) / (sMax - sMin));

  // Peak detection: must exceed 40 % amplitude, min 0.3 s apart
  const minDist  = Math.round(PPG_SAMPLE_RATE * 0.3);
  const threshold = 0.40;
  const peaks    = [];

  for (let i = 1; i < norm.length - 1; i++) {
    if (norm[i] > threshold && norm[i] >= norm[i - 1] && norm[i] >= norm[i + 1]) {
      if (!peaks.length || (i - peaks[peaks.length - 1]) >= minDist) {
        peaks.push(i);
      }
    }
  }
  if (peaks.length < 2) return null;

  const intervals = peaks.slice(1).map((p, i) => p - peaks[i]);
  const mean      = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const bpm       = (PPG_SAMPLE_RATE * 60) / mean;

  if (bpm < 40 || bpm > 200) return null;
  return Math.round(bpm);
}

/**
 * Compute SpO2 (%) from IR and red PPG channels using the AC/DC ratio method.
 * Returns null if signal quality is insufficient.
 */
function computeSpO2(irSamples, redSamples) {
  const n = Math.min(irSamples.length, redSamples.length);
  if (n < 64) return null;

  const ir  = irSamples.slice(-n);
  const red = redSamples.slice(-n);

  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const p95  = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * 0.95)]; };
  const p05  = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * 0.05)]; };

  const dcIr  = mean(ir);
  const dcRed = mean(red);
  if (dcIr < 1 || dcRed < 1) return null;

  const acIr  = (p95(ir)  - p05(ir))  / 2;
  const acRed = (p95(red) - p05(red)) / 2;
  if (acIr < 1 || acRed < 1) return null;

  const R    = (acRed / dcRed) / (acIr / dcIr);
  if (R < 0.2 || R > 1.5) return null;

  const spo2 = Math.round(Math.min(100, Math.max(85, 110 - 25 * R)) * 10) / 10;
  return spo2;
}

/**
 * Called after enough PPG samples have been collected.
 * Updates latestHeartRate / latestSpo2 and refreshes the UI.
 */
function processPPG() {
  const ir  = ppgChannels[PPG_CH_IR];
  const red = ppgChannels[PPG_CH_RED];

  const hr   = computeHeartRate([...ir]);
  const spo2 = computeSpO2([...ir], [...red]);

  if (hr   != null) latestHeartRate = hr;
  if (spo2 != null) latestSpo2      = spo2;

  updateBiometricsUI();

  // Keep a rolling 30-second buffer to avoid runaway memory growth
  const maxBuf = PPG_SAMPLE_RATE * 30;
  [PPG_CH_AMBIENT, PPG_CH_IR, PPG_CH_RED].forEach(ch => {
    if (ppgChannels[ch].length > maxBuf) {
      ppgChannels[ch] = ppgChannels[ch].slice(-maxBuf);
    }
  });
}

// ── Bluetooth connection ──────────────────────────────────────────────────────
$('btn-bluetooth').addEventListener('click', async () => {
  if (mode === 'bluetooth') disconnectBluetooth();
  else await connectBluetooth();
});

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth is not available. Please use Chrome or Edge.');
    return;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [MUSE_SERVICE_UUID] }],
      optionalServices: [MUSE_SERVICE_UUID],
    });
    btDevice = device;
    device.addEventListener('gattserverdisconnected', onBtDisconnected);

    const server  = await device.gatt.connect();
    const service = await server.getPrimaryService(MUSE_SERVICE_UUID);

    // ── Send Muse preset command ───────────────────────────────────────────
    const controlChar = await service.getCharacteristic(MUSE_CONTROL_UUID).catch(() => null);
    if (controlChar) {
      const enc = new TextEncoder();
      await controlChar.writeValue(enc.encode('p21\n'));
      await new Promise(r => setTimeout(r, 300));
      await controlChar.writeValue(enc.encode('d\n'));
    }

    // ── Subscribe to EEG characteristics ──────────────────────────────────
    for (let c = 0; c < MUSE_EEG_UUIDS.length; c++) {
      const char = await service.getCharacteristic(MUSE_EEG_UUIDS[c]).catch(() => null);
      if (!char) continue;
      await char.startNotifications();
      const ch = c;
      char.addEventListener('characteristicvaluechanged', ev => onMuseEEG(ev, ch));
    }

    // ── Subscribe to PPG characteristics (silently skip if unsupported) ───
    // Muse 2 and Muse S expose these; other EEG headbands do not.
    // If any characteristic is missing, we just skip it — no error shown.
    ppgEnabled = false;
    ppgChannels.forEach(ch => { ch.length = 0; });
    latestHeartRate = null;
    latestSpo2      = null;

    for (let c = 0; c < MUSE_PPG_UUIDS.length; c++) {
      const char = await service.getCharacteristic(MUSE_PPG_UUIDS[c]).catch(() => null);
      if (!char) continue; // headset doesn't have this PPG channel — silently skip
      try {
        await char.startNotifications();
        const ch = c;
        char.addEventListener('characteristicvaluechanged', ev => onMusePPG(ev, ch));
        ppgEnabled = true;
      } catch {
        // Notification setup failed for this PPG char — ignore
      }
    }

    btDisconnect = () => { if (device.gatt.connected) device.gatt.disconnect(); };
    mode = 'bluetooth';
    setStatus('bluetooth', 'BLE connected');
    $('btn-bluetooth').classList.add('bt-active');
    $('bt-device-name').textContent = device.name || 'BLE device';
    $('bt-device-row').style.display = '';
    bleChannels.forEach(ch => { ch.length = 0; });
    $('val-buffer').textContent = '0 / ' + COLLECT_N;
    updateBiometricsUI();
  } catch (err) {
    if (!err.message?.includes('cancelled')) {
      console.warn('BT connect failed:', err.message);
      setStatus('error', 'BT failed');
    }
  }
}

/**
 * Handle a Muse EEG BLE notification packet.
 * Format: 2-byte sequence + 12 × uint12 samples (packed, big-endian).
 */
function onMuseEEG(ev, ch) {
  const data    = ev.target.value;
  const samples = [];
  for (let i = 2; i < data.byteLength - 1; i += 2) {
    samples.push(data.getInt16(i, false) * 0.48828125e-6);
  }
  bleChannels[ch].push(...samples);
  bleSamTick += samples.length;

  const buf = Math.min(bleChannels[0].length, COLLECT_N);
  $('val-buffer').textContent = buf + ' / ' + COLLECT_N;

  if (bleChannels[0].length >= COLLECT_N) processBluetoothEEG();
}

/**
 * Handle a Muse PPG BLE notification packet.
 * Format: 2-byte sequence + 6 × uint24 samples (big-endian).
 * Silently called only when the headset actually supports PPG.
 */
function onMusePPG(ev, ch) {
  const data    = ev.target.value;
  const samples = [];
  // Each sample is 3 bytes big-endian unsigned
  for (let i = 2; i + 2 < data.byteLength; i += 3) {
    const val = (data.getUint8(i) << 16) | (data.getUint8(i + 1) << 8) | data.getUint8(i + 2);
    samples.push(val);
  }
  if (!samples.length) return;
  ppgChannels[ch].push(...samples);

  // Trigger HR/SpO2 computation once we have enough IR samples
  if (ch === PPG_CH_IR && ppgChannels[PPG_CH_IR].length >= PPG_COLLECT_N) {
    processPPG();
  }
}

async function processBluetoothEEG() {
  const snapshot = bleChannels.map(ch => {
    const s = ch.slice(-COLLECT_N);
    ch.length = 0;
    return s;
  });
  $('val-buffer').textContent = '0 / ' + COLLECT_N;
  blePhase++;
  const t0 = performance.now();

  if (backendUrl) {
    try {
      // Include PPG snapshot in the request so the backend can compute
      // more accurate HR/SpO2 with scipy. If not available, send null.
      const ppgIr  = ppgEnabled && ppgChannels[PPG_CH_IR].length  >= PPG_SAMPLE_RATE * 4
        ? [...ppgChannels[PPG_CH_IR]]  : null;
      const ppgRed = ppgEnabled && ppgChannels[PPG_CH_RED].length >= PPG_SAMPLE_RATE * 4
        ? [...ppgChannels[PPG_CH_RED]] : null;

      const res = await fetch(backendUrl.replace(/\/$/, '') + '/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eeg_data:         snapshot,
          sample_rate:      SAMPLE_RATE,
          ppg_ir:           ppgIr,
          ppg_red:          ppgRed,
          ppg_sample_rate:  PPG_SAMPLE_RATE,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data    = await res.json();
      const latency = (performance.now() - t0).toFixed(1);
      epoch++;
      applyReading({
        epoch, latency_ms: parseFloat(latency),
        data_quality: '✓ BLE → Render',
        timestamp: new Date().toISOString().slice(11, 22) + ' UTC',
        chitta_bhumi: {
          state:         data.chitta_bhumi?.state       || '—',
          depth:         data.chitta_bhumi?.depth        || data.depth || '—',
          confidence:    data.chitta_bhumi?.confidence   || '—',
          probabilities: data.chitta_bhumi?.probabilities || {},
        },
        swara: {
          state:      data.swara?.state      || '—',
          confidence: data.swara?.confidence || '—',
          note:       data.swara?.note       || '',
        },
        tattva_flags:     data.tattva || data.tattva_flags || [],
        contemplative_depth: data.depth || '—',
        alpha_asymmetry:  0,
        eeg_spectrum:     data.eeg_spectrum || null,
        gunas:            data.gunas || null,
        // Biometrics returned by backend (null when PPG not provided)
        heart_rate:       data.heart_rate ?? null,
        spo2:             data.spo2       ?? null,
      });
      return;
    } catch (err) {
      console.warn('Backend /analyze failed, falling back to local FFT:', err.message);
    }
  }

  // Local FFT fallback (no backend / backend offline)
  const signal = snapshot[0] || [];
  if (signal.length < 64) return;
  const sz   = Math.pow(2, Math.floor(Math.log2(signal.length)));
  const mags = fft(signal.slice(-sz));
  const bp   = bandPowers(mags, SAMPLE_RATE, sz);
  const r    = classifyLocal(bp);
  r.latency_ms = parseFloat((performance.now() - t0).toFixed(1));
  // Locally-computed biometrics (already in latestHeartRate / latestSpo2)
  r.heart_rate = null; // don't override — updateBiometricsUI() reads the globals
  r.spo2       = null;
  applyReading(r);
}

function disconnectBluetooth() {
  if (btDisconnect) { btDisconnect(); btDisconnect = null; }
  btDevice = null;
  $('bt-device-row').style.display = 'none';
  bleChannels.forEach(ch => { ch.length = 0; });
  ppgChannels.forEach(ch => { ch.length = 0; });
  ppgEnabled      = false;
  latestHeartRate = null;
  latestSpo2      = null;
  updateBiometricsUI();
  mode = 'idle';
  setStatus('', 'disconnected');
  $('btn-bluetooth').classList.remove('bt-active');
  $('val-buffer').textContent = '0 / ' + COLLECT_N;
}

function onBtDisconnected() {
  if (mode === 'bluetooth') disconnectBluetooth();
}

// ── Backend URL mode ──────────────────────────────────────────────────────────
async function connectBackendUrl(url) {
  if (backendPollTimer) { clearInterval(backendPollTimer); backendPollTimer = null; }
  mode = 'backend';
  setStatus('waking', 'waking up…');
  $('val-board').textContent = 'Render backend';
  $('val-mode').textContent  = 'BLE → Render';

  let attempts = 0;
  const MAX    = 40;

  const poll = async () => {
    attempts++;
    try {
      const res = await fetch(url.replace(/\/$/, '') + '/status', { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (data.model_ready) {
          clearInterval(backendPollTimer); backendPollTimer = null;
          setStatus('connected', 'backend ready');
        } else {
          setStatus('waking', 'model loading…');
        }
      } else {
        setStatus('waking', 'waking up…');
      }
    } catch {
      if (attempts >= MAX) {
        clearInterval(backendPollTimer); backendPollTimer = null;
        setStatus('error', 'backend offline');
      }
    }
  };

  await poll();
  if (backendPollTimer === null && mode === 'backend') return;
  backendPollTimer = setInterval(poll, 1500);
}

// ── Stop everything ───────────────────────────────────────────────────────────
function stopAll() {
  clearInterval(demoTimer);        demoTimer = null;
  clearInterval(pollTimer);        pollTimer = null;
  clearInterval(backendPollTimer); backendPollTimer = null;
  if (sseSource) { sseSource.close(); sseSource = null; }
  if (mode === 'bluetooth') disconnectBluetooth();
  mode = 'idle';
  setStatus('', 'disconnected');
  $('btn-demo').textContent = '▶ Demo';
}

// ── Session management ────────────────────────────────────────────────────────
$('btn-start-session').addEventListener('click', async () => {
  const name = prompt('Session name:', 'Session ' + new Date().toLocaleDateString());
  if (name === null) return;

  try {
    const sess = await api('POST', '/sessions/start', { name: name.trim() || 'New Session' });
    activeSession         = sess;
    sessionStartTimestamp = new Date();
    sessionEpochCounter   = 0;

    $('session-name-display').textContent = sess.name;
    $('btn-start-session').style.display  = 'none';
    $('btn-end-session').style.display    = '';

    sessionTimerInterval = setInterval(() => {
      if (!activeSession) return;
      const elapsed = Math.floor((Date.now() - sessionStartTimestamp.getTime()) / 1000);
      $('session-timer').textContent = formatTime(elapsed);
    }, 1000);
  } catch (err) {
    alert('Error starting session: ' + err.message);
  }
});

$('btn-end-session').addEventListener('click', async () => {
  if (!activeSession) return;
  if (!confirm('End this session?')) return;

  clearInterval(sessionTimerInterval);
  sessionTimerInterval = null;

  try {
    await api('POST', '/sessions/' + activeSession.id + '/end');
    activeSession         = null;
    sessionStartTimestamp = null;
    $('btn-start-session').style.display  = '';
    $('btn-end-session').style.display    = 'none';
    $('session-name-display').textContent = '—';
    $('session-timer').textContent        = '0:00';
    loadSessionHistory();
  } catch (err) {
    alert('Error ending session: ' + err.message);
  }
});

// ── Session notes (auto-save) ─────────────────────────────────────────────────
$('session-notes').addEventListener('input', () => {
  if (!activeSession) return;
  clearTimeout(notesSaveTimeout);
  notesSaveTimeout = setTimeout(async () => {
    try {
      await api('PUT', '/sessions/' + activeSession.id + '/notes', {
        content: $('session-notes').value,
      });
    } catch (err) {
      console.warn('Notes save failed:', err.message);
    }
  }, 800);
});

// ── Session history ───────────────────────────────────────────────────────────
let historyVisible = false;

$('btn-toggle-history').addEventListener('click', () => {
  historyVisible = !historyVisible;
  $('history-list').style.display     = historyVisible ? '' : 'none';
  $('btn-toggle-history').textContent = historyVisible ? 'Hide' : 'Show';
  if (historyVisible) loadSessionHistory();
});

async function loadSessionHistory() {
  try {
    const sessions = await api('GET', '/sessions');
    const list     = $('history-list');
    const empty    = $('history-empty');

    list.innerHTML = '';
    if (!sessions.length) { list.appendChild(empty); return; }

    sessions.slice(0, 10).forEach(s => {
      const div = document.createElement('div');
      div.className = 'history-item';
      div.innerHTML = `
        <div class="history-item-info">
          <strong>${escHtml(s.name)}</strong>
          <span class="text-muted">${formatDate(s.startTime)}</span>
        </div>
        <span class="history-duration">${s.duration ? formatDuration(s.duration) : (s.endTime ? '—' : 'active')}</span>`;
      list.appendChild(div);
    });
  } catch (err) {
    console.warn('History load failed:', err.message);
  }
}

$('btn-toggle-history').textContent = 'Show';

// ── Canvas / Waveform ─────────────────────────────────────────────────────────
function resizeCanvas() {
  const canvas = $('eeg-canvas');
  const ctx    = canvas.getContext('2d');
  const dpr    = window.devicePixelRatio || 1;
  const rect   = canvas.parentElement.getBoundingClientRect();
  canvas.width  = rect.width * dpr;
  canvas.height = 110 * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
}

function drawWave() {
  const canvas = $('eeg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w   = canvas.clientWidth, h = 110;
  ctx.clearRect(0, 0, w, h);

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#FFFFFF');
  bg.addColorStop(1, '#F7F6F2');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#E4E2DC';
  ctx.lineWidth   = 1;
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
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';

  ctx.beginPath();
  for (let i = 0; i < len; i++) {
    const idx = (waveTail - len + i) % WAVE_LEN;
    const x   = (i / (WAVE_LEN - 1)) * w;
    const y   = h / 2 - waveBuf[idx] * (h * 0.38);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  requestAnimationFrame(drawWave);
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('resize', resizeCanvas);
checkAuth();
