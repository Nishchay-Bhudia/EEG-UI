/* ════════════════════════════════════════════════════════════════════════════
 EEG DEV TESTING — app.js
 Modes: demo | bluetooth+backend | bluetooth-local | backend-url
 Auth: Login → Session management → Admin dashboard (dedicated page)
 New: Trigunas display, Session epoch storage, Admin session analytics,
      BT Wizard connection flow, Session Replay player
════════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const SAMPLE_RATE = 256;
const COLLECT_SECS = 2;
const COLLECT_N = SAMPLE_RATE * COLLECT_SECS;
const WAVE_LEN = 300;
const DEMO_INTERVAL = 1200;

const MUSE_SERVICE_UUID = '0000fe8d-0000-1000-8000-00805f9b34fb';
const MUSE_CONTROL_UUID = '273e0001-4c4d-454d-96be-f03bac821358';
const MUSE_EEG_UUIDS = [
  '273e0003-4c4d-454d-96be-f03bac821358',
  '273e0004-4c4d-454d-96be-f03bac821358',
  '273e0005-4c4d-454d-96be-f03bac821358',
  '273e0006-4c4d-454d-96be-f03bac821358',
];

const DEPTH_PCT = { Surface: 12, Emerging: 37, Deep: 62, Profound: 94 };
const CHITTA_DEPTHS = { Kshipta: 'Surface', Vikshipta: 'Emerging', Ekagra: 'Deep', Niruddha: 'Profound' };
const SWARA_NOTES = {
  ida: 'Parasympathetic dominance. Receptive, creative and introspective state.',
  pingala: 'Sympathetic dominance. Active, analytical and goal-directed focus.',
  sushumna: 'Equilibrium of solar and lunar channels. Gateway to higher contemplative states.',
};

// ── App state ─────────────────────────────────────────────────────────────────
let mode = 'idle';
let backendUrl = localStorage.getItem('controlhub_url') || 'https://eeg-backend-5.onrender.com';
let btDevice = null;
let btDisconnect = null;
let demoTimer = null;
let epoch = 0;
let demoStateIdx = 0;
let demoSwaraIdx = 0;
let demoEpoch = 0;
let pollTimer = null;
let sseSource = null;
let backendPollTimer = null;

// Auth state
let currentUser = null; // { id, username, role }

// Session state
let activeSession = null; // { id, name, startTime }
let sessionTimerInterval = null;
let notesSaveTimeout = null;
let sessionEpochCounter = 0;
let sessionStartTimestamp = null;

// Admin page state
let adminCurrentTab = 'users';
let resetPwTargetUserId = null;

const bleChannels = [[], [], [], []];
let blePhase = 0;
let bleSamTick = 0;

const waveBuf = new Float32Array(WAVE_LEN);
let waveTail = 0;
let wavePhase = 0;

// ── BT Wizard state machine ───────────────────────────────────────────────────
// States: idle | pairing | device_connected | waiting_for_signal | signal_detected | countdown | analysing
let btWizardState = 'idle';
let btWizardCountdownTimer = null;
let btWizardSignalCheckTimer = null;
let btWizardEpochCount = 0; // epochs received since device connected
const BT_SIGNAL_THRESHOLD = 3; // epochs needed before countdown

// ── Replay state ──────────────────────────────────────────────────────────────
let replayEpochs = [];       // all epochs for current replay session
let replayCurrentIdx = 0;   // current epoch index
let replayPlaying = false;
let replaySpeed = 1;
let replayTimer = null;
let replaySessionDuration = 0; // total duration in seconds

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
  $('main-header').style.display = 'none';
  $('main-content').style.display = 'none';
  $('admin-page').style.display = 'none';
}

function showMainApp() {
  $('login-screen').style.display = 'none';
  $('main-header').style.display = '';
  $('main-content').style.display = '';
  $('admin-page').style.display = 'none';

  $('user-avatar-initial').textContent = (currentUser.username[0] || '?').toUpperCase();
  $('user-display-name').textContent = currentUser.username;
  $('user-menu-role').textContent = currentUser.role;

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
  $('main-header').style.display = '';
  $('main-content').style.display = 'none';
  $('admin-page').style.display = '';
  openAdminTab(adminCurrentTab);
}

// ── Login form ────────────────────────────────────────────────────────────────
$('btn-login').addEventListener('click', async () => {
  const username = $('input-username').value.trim();
  const password = $('input-password').value;
  const errEl = $('login-error');
  errEl.style.display = 'none';
  $('btn-login').disabled = true;
  $('btn-login').textContent = 'Signing in…';

  try {
    currentUser = await api('POST', '/auth/login', { username, password });
    showMainApp();
  } catch (err) {
    errEl.textContent = err.message || 'Login failed';
    errEl.style.display = '';
  } finally {
    $('btn-login').disabled = false;
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
  currentUser = null;
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
  const url = $('input-backend-url').value.trim().replace(/\/$/, '');
  const testEl = $('test-msg');
  if (!url) { alert('Enter a URL first.'); return; }
  testEl.style.display = '';
  testEl.style.color = 'var(--text-muted)';
  testEl.textContent = 'Testing…';
  try {
    const res = await fetch(url + '/status', { signal: AbortSignal.timeout(5000) });
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
  $('admin-tab-users').style.display = tabName === 'users' ? '' : 'none';
  $('admin-tab-sessions').style.display = tabName === 'sessions' ? '' : 'none';
  if (tabName === 'users') loadAdminUsers();
  if (tabName === 'sessions') loadAdminSessions();
}

// ── Admin: Users tab ──────────────────────────────────────────────────────────
$('btn-add-user').addEventListener('click', () => {
  $('create-user-form').style.display = '';
  $('create-user-error').style.display = 'none';
  $('new-username').value = '';
  $('new-password').value = '';
  $('new-role').value = 'user';
});

$('btn-cancel-create-user').addEventListener('click', () => {
  $('create-user-form').style.display = 'none';
});

$('btn-create-user').addEventListener('click', async () => {
  const username = $('new-username').value.trim();
  const password = $('new-password').value;
  const role = $('new-role').value;
  const errEl = $('create-user-error');
  errEl.style.display = 'none';

  if (!username || !password) {
    errEl.textContent = 'Username and password required.';
    errEl.style.display = '';
    return;
  }

  try {
    await api('POST', '/users', { username, password, role });
    $('create-user-form').style.display = 'none';
    await loadAdminUsers();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = '';
  }
});

$('btn-cancel-reset-pw').addEventListener('click', () => {
  $('reset-pw-form').style.display = 'none';
  resetPwTargetUserId = null;
});

$('btn-save-reset-pw').addEventListener('click', async () => {
  if (!resetPwTargetUserId) return;
  const pw = $('reset-pw-input').value;
  if (!pw) { alert('Enter a password.'); return; }
  try {
    await api('PUT', '/users/' + resetPwTargetUserId + '/password', { password: pw });
    $('reset-pw-form').style.display = 'none';
    resetPwTargetUserId = null;
    $('reset-pw-input').value = '';
    alert('Password updated.');
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

async function loadAdminUsers() {
  const tbody = $('admin-users-tbody');
  tbody.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';
  try {
    const users = await api('GET', '/users');
    tbody.innerHTML = '';
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="4">No users found.</td></tr>';
      return;
    }
    users.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escHtml(u.username)}</strong></td>
        <td><span class="role-badge">${escHtml(u.role)}</span></td>
        <td>${formatDate(u.createdAt)}</td>
        <td>
          <button class="btn-sm" data-action="reset-pw" data-uid="${u.id}">Reset PW</button>
          ${u.id !== currentUser.id
            ? `<button class="btn-sm btn-danger" data-action="delete-user" data-uid="${u.id}">Delete</button>`
            : '<span class="text-muted">(you)</span>'
          }
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="error">${escHtml(err.message)}</td></tr>`;
  }
}

$('admin-users-tbody').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const uid = parseInt(btn.dataset.uid, 10);
  const action = btn.dataset.action;

  if (action === 'reset-pw') {
    resetPwTargetUserId = uid;
    $('reset-pw-input').value = '';
    $('reset-pw-form').style.display = '';
    $('reset-pw-input').focus();
  } else if (action === 'delete-user') {
    if (!confirm('Delete this user? This cannot be undone.')) return;
    try {
      await api('DELETE', '/users/' + uid);
      await loadAdminUsers();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }
});

// ── Admin: Sessions tab ───────────────────────────────────────────────────────
$('admin-sessions-search').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  qAll('#admin-sessions-tbody tr').forEach(tr => {
    const user = tr.querySelector('[data-username]')?.dataset.username || '';
    tr.style.display = user.includes(q) ? '' : 'none';
  });
});

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
        <td data-username="${escHtml((s.username || '').toLowerCase())}">${escHtml(s.username || '?')}</td>
        <td><strong>${escHtml(s.name)}</strong></td>
        <td>${formatDate(s.startTime)}</td>
        <td>${s.duration ? formatDuration(s.duration) : (s.endTime ? '—' : '<em>active</em>')}</td>
        <td id="epoch-count-${s.id}">—</td>
        <td><button class="btn-sm" data-action="view-analytics" data-sid="${s.id}" data-sname="${escHtml(s.name)}">View Analytics</button></td>
      `;
      tbody.appendChild(tr);
    });

    loadEpochCounts(sessions);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="error">${escHtml(err.message)}</td></tr>`;
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
  const sid = parseInt(btn.dataset.sid, 10);
  const sname = btn.dataset.sname;
  openSessionAnalytics(sid, sname);
});

// ── Session Analytics Overlay ─────────────────────────────────────────────────
$('btn-close-analytics').addEventListener('click', () => {
  $('analytics-overlay').style.display = 'none';
  stopReplay();
});

$('analytics-overlay').addEventListener('click', e => {
  if (e.target === $('analytics-overlay')) {
    $('analytics-overlay').style.display = 'none';
    stopReplay();
  }
});

async function openSessionAnalytics(sessionId, sessionName) {
  const overlay = $('analytics-overlay');
  overlay.style.display = 'flex';
  stopReplay();

  $('analytics-session-name').textContent = sessionName || 'Session Analytics';
  $('analytics-session-meta').textContent = '';
  $('analytics-loading').style.display = '';
  $('analytics-error').style.display = 'none';
  $('analytics-content').style.display = 'none';

  // Reset notes area
  const notesEl = $('a-session-notes');
  if (notesEl) notesEl.value = '';
  const notesWrap = $('a-notes-wrap');
  if (notesWrap) notesWrap.style.display = 'none';

  try {
    // Fetch analytics and notes in parallel
    const [data, notesData] = await Promise.all([
      api('GET', '/sessions/' + sessionId + '/analytics'),
      api('GET', '/sessions/' + sessionId + '/notes').catch(() => ({ content: '' })),
    ]);

    renderSessionAnalytics(data);

    // Show notes (admin can read anyone's; users read their own)
    if (notesEl && notesWrap) {
      notesEl.value = notesData.content || '';
      notesWrap.style.display = '';
    }

    // Set up replay using epoch data
    if (data.epochs && data.epochs.length > 0) {
      setupReplay(data.epochs, data.session);
    }
  } catch (err) {
    $('analytics-loading').style.display = 'none';
    $('analytics-error').style.display = '';
    $('analytics-error').textContent = 'Failed to load analytics: ' + err.message;
  }
}

function renderSessionAnalytics(data) {
  const { session, summary } = data;
  $('analytics-loading').style.display = 'none';
  $('analytics-content').style.display = '';

  $('analytics-session-name').textContent = session.name;
  $('analytics-session-meta').textContent =
    `${session.username || '?'} · ${formatDate(session.startTime)}` +
    (session.duration ? ` · ${formatDuration(session.duration)}` : '');

  $('a-total-epochs').textContent = summary.totalEpochs ?? '—';
  $('a-duration').textContent = summary.durationSeconds ? formatDuration(summary.durationSeconds) : '—';

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
  setAnalyticsGuna('rajas', avgGunas.rajas);
  setAnalyticsGuna('tamas', avgGunas.tamas);

  const stateColors = { Kshipta: 'var(--kshipta)', Vikshipta: 'var(--vikshipta)', Ekagra: 'var(--ekagra)', Niruddha: 'var(--niruddha)' };
  renderBreakdownList('a-state-breakdown', summary.stateBreakdown || {}, stateColors);

  const swaraColors = { Ida: 'var(--ida)', Pingala: 'var(--pingala)', Sushumna: 'var(--sushumna)' };
  renderBreakdownList('a-swara-breakdown', summary.swaraBreakdown || {}, swaraColors);

  renderAvgBands(summary.avgBands || {});
  renderTimeline(summary.phases || []);
}

function setAnalyticsGuna(name, value) {
  const pct = value != null ? (value * 100).toFixed(1) : null;
  const bar = $('a-bar-' + name);
  const pctEl = $('a-pct-' + name);
  if (bar) bar.style.width = pct ? pct + '%' : '0%';
  if (pctEl) pctEl.textContent = pct ? pct + '%' : '—';
}

function renderBreakdownList(containerId, breakdown, colorMap) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = '';
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    el.innerHTML = '<p class="text-muted">No data</p>';
    return;
  }
  entries.forEach(([label, pct]) => {
    const color = colorMap[label] || 'var(--accent)';
    const div = document.createElement('div');
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
    { key: 'beta',  sym: 'β', name: 'Beta',  color: 'var(--beta)' },
    { key: 'gamma', sym: 'γ', name: 'Gamma', color: 'var(--gamma)' },
  ];
  defs.forEach(({ key, sym, name, color }) => {
    const val = bands[key];
    const pct = val != null ? (val * 100).toFixed(1) + '%' : '—';
    const div = document.createElement('div');
    div.className = 'analytics-band-pill';
    div.innerHTML = `<span class="band-sym" style="color:${color}">${sym}</span><span class="band-name">${name}</span><span class="band-val">${pct}</span>`;
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

    const bands  = phase.avgBands || {};
    const topBand = Object.entries(bands).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0];
    const bandNote = topBand ? `Dominant band: ${topBand[0]} (${(topBand[1] * 100).toFixed(1)}%)` : '';

    const div = document.createElement('div');
    div.className = `timeline-phase phase-${phase.state}`;
    div.innerHTML = `
      <div class="phase-header">
        <span class="phase-time">${escHtml(timeStr)}</span>
        <span class="phase-state">${escHtml(phase.state)}</span>
        <span class="phase-depth">${escHtml(phase.depth || '')}</span>
        ${bandNote ? `<span class="phase-band-note">${escHtml(bandNote)}</span>` : ''}
      </div>
      <div class="phase-footer">
        ${gunaBadge}
        <span class="phase-epoch-count">${phase.epochCount} epoch${phase.epochCount !== 1 ? 's' : ''}</span>
      </div>`;
    container.appendChild(div);
  });
}

// ── EEG Readings → UI ─────────────────────────────────────────────────────────
function setStatus(type, text) {
  const dot = $('status-dot');
  const txt = $('status-text');
  dot.className = 'status-dot' + (type ? ' ' + type : '');
  txt.textContent = text;
}

function applyReading(r) {
  $('val-epoch').textContent = r.epoch ?? epoch;
  $('val-quality').textContent = r.data_quality || '—';
  $('val-latency').textContent = r.latency_ms != null ? r.latency_ms.toFixed(1) : '—';

  const ch = r.chitta_bhumi || {};
  const state = ch.state || '—';
  $('chitta-state').textContent = state;
  $('chitta-sub').textContent = ch.depth || ch.confidence || '—';

  const depth = ch.depth || CHITTA_DEPTHS[state] || 'Surface';
  const depthPct = DEPTH_PCT[depth] ?? 12;
  const depthFill = $('depth-fill');
  const depthColor = state === 'Kshipta' ? 'var(--kshipta)' : state === 'Vikshipta' ? 'var(--vikshipta)'
    : state === 'Ekagra' ? 'var(--ekagra)' : 'var(--niruddha)';
  depthFill.style.width = depthPct + '%';
  depthFill.style.background = depthColor;

  $('val-confidence').textContent = ch.confidence || '—';
  $('val-depth').textContent = depth;

  const probs = ch.probabilities || {};
  ['Kshipta', 'Vikshipta', 'Ekagra', 'Niruddha'].forEach(s => {
    const raw = probs[s] ?? '0%';
    const pct = parseFloat(raw);
    const key = s.toLowerCase();
    const el  = $('prob-' + key);
    const bar = $('bar-' + key);
    if (el)  el.textContent = isNaN(pct) ? raw : pct.toFixed(1) + '%';
    if (bar) bar.style.width = (isNaN(pct) ? parseFloat(raw) : pct) + '%';
  });

  const sw   = r.swara || {};
  const sst  = (sw.state || '').toLowerCase();
  const isIda      = /ida/.test(sst);
  const isPingala  = /pingala/.test(sst);
  const isSushumna = !isIda && !isPingala;

  $('swara-note').textContent = sw.note || (isIda ? SWARA_NOTES.ida : isPingala ? SWARA_NOTES.pingala : SWARA_NOTES.sushumna);
  $('swara-confidence').textContent = sw.confidence || '—';

  $('glyph-ida').className      = 'swara-glyph' + (isIda      ? ' active-ida'      : '');
  $('glyph-sushumna').className = 'swara-glyph' + (isSushumna ? ' active-sushumna' : '');
  $('glyph-pingala').className  = 'swara-glyph' + (isPingala  ? ' active-pingala'  : '');

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
    fillEl.style.left = '50%'; fillEl.style.right = (100 - (50 + pct)) + '%'; fillEl.style.background = fillBg;
  } else if (pct < 0) {
    fillEl.style.left = (50 + pct) + '%'; fillEl.style.right = '50%'; fillEl.style.background = fillBg;
  } else {
    fillEl.style.left = fillEl.style.right = '50%';
  }

  const spectrum = r.eeg_spectrum || (r.band_powers && r.band_powers.relative) || {};
  const bands = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
  bands.forEach(b => {
    const raw  = spectrum[b] ?? null;
    const pct  = raw != null ? (raw * 100).toFixed(1) : null;
    const valEl = $('val-' + b);
    const barEl = $('bar-' + b);
    if (valEl) valEl.textContent = pct ? pct + '%' : '—';
    if (barEl) barEl.style.width = pct ? Math.min(pct, 100) + '%' : '0%';
  });

  const flags   = r.tattva_flags || r.tattva || [];
  const flagDiv = $('tattva-flags');
  flagDiv.innerHTML = '';
  if (!flags.length) {
    flagDiv.innerHTML = 'no flags active';
  } else {
    flags.forEach(f => {
      const span = document.createElement('span');
      let cls = 'tattva-other';
      if (/tattva/i.test(f))     cls = 'tattva-activation';
      else if (/pratyahara/i.test(f)) cls = 'pratyahara';
      else if (/turiya/i.test(f))    cls = 'turiya';
      else if (/gamma/i.test(f))     cls = 'gamma-spike';
      span.className = 'tattva-flag ' + cls;
      span.textContent = f;
      flagDiv.appendChild(span);
    });
  }

  applyGunas(r.gunas);

  if (activeSession) storeEpoch(r, spectrum, flags);

  // BT wizard: if in waiting_for_signal, count epochs towards threshold
  if (btWizardState === 'waiting_for_signal' || btWizardState === 'device_connected') {
    btWizardEpochCount++;
    updateWizardSignalQuality(r.data_quality || 'Fair');
    if (btWizardEpochCount >= BT_SIGNAL_THRESHOLD) {
      setBtWizardState('signal_detected');
    }
  }

  const ampSrc = spectrum.alpha || spectrum.theta || 0.2;
  const amp    = 0.3 + ampSrc * 1.5;
  for (let i = 0; i < 8; i++) {
    waveBuf[waveTail % WAVE_LEN] = Math.sin(wavePhase + i * 0.8) * amp;
    waveTail++;
    wavePhase += 0.18;
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
  $('gunas-note').textContent = note || '';
}

function computeLocalGunas() {
  const get = id => parseFloat($('bar-' + id)?.style.width || '0') / 100;
  const alpha = get('alpha'), theta = get('theta'), beta = get('beta'),
        delta = get('delta'), gamma = get('gamma');

  let sat = alpha * 3.0 + theta * 1.5 - beta * 1.5;
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
  const swaraSimple = /ida/i.test(swaraState) ? 'Ida' : /pingala/i.test(swaraState) ? 'Pingala' : 'Sushumna';

  const epochBody = {
    epochNum: sessionEpochCounter,
    elapsedSeconds: elapsedSeconds ? +elapsedSeconds.toFixed(2) : null,
    chittaBhumi: ch.state || null,
    chittaConfidence: ch.confidence || null,
    contemplativeDepth: ch.depth || null,
    swara: swaraSimple,
    swaraConfidence: sw.confidence || null,
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
  };

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
  for (let i = 0; i < half; i++) mags[i] = Math.sqrt(re[i]*re[i] + im[i]*im[i]);
  return mags;
}

function bandPowers(mags, sr, sz) {
  const binHz = sr / sz;
  let d=0, t=0, a=0, b=0, g=0, total=0;
  mags.forEach((v, i) => {
    const hz = i * binHz;
    if (hz >= 1  && hz <  4)  d += v;
    if (hz >= 4  && hz <  8)  t += v;
    if (hz >= 8  && hz < 13)  a += v;
    if (hz >= 13 && hz < 30)  b += v;
    if (hz >= 30 && hz < 50)  g += v;
    if (hz >= 1  && hz < 50)  total += v;
  });
  if (!total) return { delta:0.2,theta:0.2,alpha:0.2,beta:0.2,gamma:0.2 };
  return { delta:d/total, theta:t/total, alpha:a/total, beta:b/total, gamma:g/total };
}

function classifyLocal(bp) {
  const DEMO_STATES = ['Kshipta','Vikshipta','Ekagra','Niruddha'];
  const alpha = bp.alpha, theta = bp.theta, beta = bp.beta;
  let state;
  if      (alpha > 0.35)             state = 'Ekagra';
  else if (theta > 0.30)             state = 'Vikshipta';
  else if (alpha > 0.25 && beta < 0.20) state = 'Niruddha';
  else                                state = 'Kshipta';
  const depth = CHITTA_DEPTHS[state];
  const asym  = bp.alpha - bp.theta;
  const swaraSimple = asym > 0.02 ? 'Pingala (Solar · Right)' : asym < -0.02 ? 'Ida (Lunar · Left)' : 'Sushumna (Balanced)';
  const gunas = computeLocalGunas ? computeLocalGunas() : { sattva:0.33, rajas:0.33, tamas:0.34, label:'Balanced' };
  epoch++;
  return {
    epoch,
    data_quality: '✓ local FFT',
    timestamp: new Date().toISOString().slice(11,22),
    chitta_bhumi: { state, depth, confidence: '—', probabilities: {} },
    swara: { state: swaraSimple, confidence: '—' },
    tattva_flags: [],
    alpha_asymmetry: asym,
    eeg_spectrum: bp,
    gunas,
  };
}

// ── Demo mode ─────────────────────────────────────────────────────────────────
const DEMO_SEQUENCE = [
  { chitta_bhumi:{ state:'Kshipta',  depth:'Surface',  confidence:'71%', probabilities:{Kshipta:'71%',Vikshipta:'18%',Ekagra:'8%',Niruddha:'3%'} }, swara:{ state:'Pingala (Solar)', confidence:'68%' }, tattva_flags:[], alpha_asymmetry:0.12, eeg_spectrum:{ delta:0.28, theta:0.22, alpha:0.24, beta:0.19, gamma:0.07 }, gunas:{ sattva:0.28, rajas:0.51, tamas:0.21, label:'Rajasic' } },
  { chitta_bhumi:{ state:'Vikshipta', depth:'Emerging', confidence:'65%', probabilities:{Kshipta:'22%',Vikshipta:'65%',Ekagra:'10%',Niruddha:'3%'} }, swara:{ state:'Ida (Lunar)',    confidence:'72%' }, tattva_flags:[], alpha_asymmetry:-0.08, eeg_spectrum:{ delta:0.22, theta:0.31, alpha:0.28, beta:0.14, gamma:0.05 }, gunas:{ sattva:0.42, rajas:0.32, tamas:0.26, label:'Sattvic' } },
  { chitta_bhumi:{ state:'Ekagra',   depth:'Deep',     confidence:'80%', probabilities:{Kshipta:'5%',Vikshipta:'12%',Ekagra:'80%',Niruddha:'3%'} },  swara:{ state:'Sushumna',       confidence:'61%' }, tattva_flags:['Pratyahara Window detected'], alpha_asymmetry:0.01, eeg_spectrum:{ delta:0.18, theta:0.24, alpha:0.38, beta:0.14, gamma:0.06 }, gunas:{ sattva:0.58, rajas:0.25, tamas:0.17, label:'Sattvic' } },
  { chitta_bhumi:{ state:'Niruddha', depth:'Profound', confidence:'91%', probabilities:{Kshipta:'2%',Vikshipta:'4%',Ekagra:'3%',Niruddha:'91%'} },  swara:{ state:'Sushumna',       confidence:'88%' }, tattva_flags:['Turiya State – Deep Theta Coherence','Pratyahara Window detected'], alpha_asymmetry:0.00, eeg_spectrum:{ delta:0.15, theta:0.38, alpha:0.30, beta:0.11, gamma:0.06 }, gunas:{ sattva:0.67, rajas:0.19, tamas:0.14, label:'Sattvic' } },
];

function startDemo() {
  stopAll();
  mode = 'demo';
  $('btn-demo').textContent = '⏹ Stop';
  setStatus('demo', 'demo running');
  $('val-mode').textContent = 'Demo';
  $('val-board').textContent = 'Simulated';

  const tick = () => {
    const base  = DEMO_SEQUENCE[demoStateIdx % DEMO_SEQUENCE.length];
    const noise = () => (Math.random() - 0.5) * 0.04;
    const sp    = base.eeg_spectrum;
    const noisy = {
      delta: Math.max(0, sp.delta + noise()),
      theta: Math.max(0, sp.theta + noise()),
      alpha: Math.max(0, sp.alpha + noise()),
      beta:  Math.max(0, sp.beta  + noise()),
      gamma: Math.max(0, sp.gamma + noise()),
    };
    demoEpoch++;
    applyReading({
      ...base,
      epoch: demoEpoch,
      data_quality: '✓ demo',
      timestamp: new Date().toISOString().slice(11,22) + ' UTC',
      eeg_spectrum: noisy,
      latency_ms: 8 + Math.random() * 4,
    });
    if (demoEpoch % 3 === 0) demoStateIdx++;
  };

  tick();
  demoTimer = setInterval(tick, DEMO_INTERVAL);
}

$('btn-demo').addEventListener('click', () => {
  if (mode === 'demo') { stopAll(); } else { startDemo(); }
});

// ── Bluetooth — with connection wizard ────────────────────────────────────────
$('btn-bluetooth').addEventListener('click', () => {
  if (mode === 'bluetooth') {
    disconnectBluetooth();
  } else {
    openBtWizard();
  }
});

function openBtWizard() {
  btWizardEpochCount = 0;
  setBtWizardState('pairing');
  $('bt-wizard-overlay').style.display = 'flex';
  connectBluetooth();
}

function closeBtWizard() {
  $('bt-wizard-overlay').style.display = 'none';
  clearTimeout(btWizardCountdownTimer);
  clearInterval(btWizardSignalCheckTimer);
  btWizardState = 'idle';
}

function setBtWizardState(newState) {
  btWizardState = newState;

  // Hide all phase panels
  ['btwiz-pairing','btwiz-connected','btwiz-countdown'].forEach(id => {
    const el = $(id);
    if (el) el.style.display = 'none';
  });

  if (newState === 'pairing') {
    $('btwiz-pairing').style.display = '';
    setBtWizardStatusText('Searching…');
  }

  if (newState === 'device_connected' || newState === 'waiting_for_signal') {
    $('btwiz-connected').style.display = '';
    $('btwiz-signal-label').textContent = 'Waiting for Brain Signals…';
    $('btwiz-signal-quality').textContent = '—';
    $('btwiz-signal-quality').className = 'btwiz-quality';
    $('btwiz-head-glow').style.borderColor = 'rgba(255,255,255,0.2)';
  }

  if (newState === 'signal_detected') {
    $('btwiz-connected').style.display = '';
    $('btwiz-signal-label').textContent = 'Signal Acquired — Starting analysis…';
    $('btwiz-head-glow').style.borderColor = '#56A67A';
    startBtCountdown();
  }

  if (newState === 'countdown') {
    $('btwiz-countdown').style.display = '';
  }

  if (newState === 'analysing') {
    closeBtWizard();
  }
}

function setBtWizardStatusText(text) {
  const el = $('btwiz-status-text');
  if (el) el.textContent = text;
}

function updateWizardSignalQuality(quality) {
  const el = $('btwiz-signal-quality');
  if (!el) return;
  const labels = {
    'Poor': { text: 'Poor', cls: 'btwiz-quality quality-poor' },
    'Fair': { text: 'Fair', cls: 'btwiz-quality quality-fair' },
    'Good': { text: 'Good', cls: 'btwiz-quality quality-good' },
    'Excellent': { text: 'Excellent', cls: 'btwiz-quality quality-excellent' },
  };
  const q = quality.includes('✓') ? 'Good' : (labels[quality] ? quality : 'Fair');
  const def = labels[q] || labels['Fair'];
  el.textContent = def.text;
  el.className = def.cls;
  $('btwiz-signal-label').textContent = 'Receiving Brain Signals…';
}

function startBtCountdown() {
  setBtWizardState('countdown');
  let count = 3;
  const numEl = $('btwiz-countdown-num');
  if (numEl) {
    numEl.textContent = count;
    numEl.classList.remove('countdown-animate');
    void numEl.offsetWidth; // force reflow
    numEl.classList.add('countdown-animate');
  }

  const tick = () => {
    count--;
    if (count <= 0) {
      setBtWizardState('analysing');
      return;
    }
    if (numEl) {
      numEl.textContent = count;
      numEl.classList.remove('countdown-animate');
      void numEl.offsetWidth;
      numEl.classList.add('countdown-animate');
    }
    btWizardCountdownTimer = setTimeout(tick, 1000);
  };
  btWizardCountdownTimer = setTimeout(tick, 1000);
}

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    setBtWizardStatusText('Web Bluetooth not supported. Use Chrome or Edge.');
    return;
  }

  try {
    setBtWizardStatusText('Searching…');

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [MUSE_SERVICE_UUID] }],
      optionalServices: [MUSE_SERVICE_UUID],
    });

    setBtWizardStatusText('Connecting…');
    const server = await device.gatt.connect();
    setBtWizardStatusText('Authenticating…');
    const service = await server.getPrimaryService(MUSE_SERVICE_UUID);
    setBtWizardStatusText('Connected');

    device.addEventListener('gattserverdisconnected', onBtDisconnected);

    const ctrl = await service.getCharacteristic(MUSE_CONTROL_UUID).catch(() => null);
    if (ctrl) {
      await ctrl.writeValue(new TextEncoder().encode('p21\n')).catch(() => {});
      await ctrl.writeValue(new TextEncoder().encode('s\n')).catch(() => {});
    }

    for (let c = 0; c < MUSE_EEG_UUIDS.length; c++) {
      const char = await service.getCharacteristic(MUSE_EEG_UUIDS[c]).catch(() => null);
      if (!char) continue;
      await char.startNotifications();
      const ch = c;
      char.addEventListener('characteristicvaluechanged', ev => onMuseEEG(ev, ch));
    }

    btDisconnect = () => { if (device.gatt.connected) device.gatt.disconnect(); };
    mode = 'bluetooth';
    setStatus('bluetooth', 'BLE connected');
    $('btn-bluetooth').classList.add('bt-active');
    $('bt-device-name').textContent = device.name || 'BLE device';
    $('bt-device-row').style.display = '';
    bleChannels.forEach(ch => { ch.length = 0; });
    $('val-buffer').textContent = '0 / ' + COLLECT_N;

    // Advance wizard to signal-waiting phase
    setBtWizardState('waiting_for_signal');
    btWizardEpochCount = 0;

  } catch (err) {
    if (err.message?.includes('cancelled') || err.name === 'NotFoundError') {
      closeBtWizard();
    } else {
      setBtWizardStatusText('Connection failed: ' + err.message);
      setStatus('error', 'BT failed');
    }
  }
}

function onMuseEEG(ev, ch) {
  const data = ev.target.value;
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
      const res = await fetch(backendUrl.replace(/\/$/, '') + '/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eeg_data: snapshot, sample_rate: SAMPLE_RATE }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const latency = (performance.now() - t0).toFixed(1);
      epoch++;
      applyReading({
        epoch, latency_ms: parseFloat(latency),
        data_quality: '✓ BLE → Render',
        timestamp: new Date().toISOString().slice(11,22) + ' UTC',
        chitta_bhumi: {
          state: data.chitta_bhumi?.state || '—',
          depth: data.chitta_bhumi?.depth || data.depth || '—',
          confidence: data.chitta_bhumi?.confidence || '—',
          probabilities: data.chitta_bhumi?.probabilities || {},
        },
        swara: {
          state: data.swara?.state || '—',
          confidence: data.swara?.confidence || '—',
          note: data.swara?.note || '',
        },
        tattva_flags: data.tattva || data.tattva_flags || [],
        contemplative_depth: data.depth || '—',
        alpha_asymmetry: 0,
        eeg_spectrum: data.eeg_spectrum || null,
        gunas: data.gunas || null,
      });
      return;
    } catch (err) {
      console.warn('Backend /analyze failed, falling back to local FFT:', err.message);
    }
  }

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
  $('bt-device-row').style.display = 'none';
  bleChannels.forEach(ch => { ch.length = 0; });
  mode = 'idle';
  setStatus('', 'disconnected');
  $('btn-bluetooth').classList.remove('bt-active');
  $('val-buffer').textContent = '0 / ' + COLLECT_N;

  // If wizard is open, go back to pairing
  if (btWizardState !== 'idle' && btWizardState !== 'analysing') {
    clearTimeout(btWizardCountdownTimer);
    setBtWizardState('pairing');
    connectBluetooth(); // retry
  }
}

function onBtDisconnected() {
  if (mode === 'bluetooth') disconnectBluetooth();
}

// ── BT Wizard close button ────────────────────────────────────────────────────
document.addEventListener('click', e => {
  if (e.target.id === 'btn-close-bt-wizard') {
    if (mode === 'bluetooth') disconnectBluetooth();
    closeBtWizard();
  }
});

// ── Backend URL mode ──────────────────────────────────────────────────────────
async function connectBackendUrl(url) {
  if (backendPollTimer) { clearInterval(backendPollTimer); backendPollTimer = null; }
  mode = 'backend';
  setStatus('waking', 'waking up…');
  $('val-board').textContent = 'Render backend';
  $('val-mode').textContent  = 'BLE → Render';

  let attempts = 0;
  const MAX = 40;

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
  clearInterval(demoTimer); demoTimer = null;
  clearInterval(pollTimer); pollTimer = null;
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
    activeSession = sess;
    sessionStartTimestamp = new Date();
    sessionEpochCounter = 0;

    $('session-name-display').textContent = sess.name;
    $('btn-start-session').style.display = 'none';
    $('btn-end-session').style.display   = '';

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
    activeSession = null;
    sessionStartTimestamp = null;
    $('btn-start-session').style.display   = '';
    $('btn-end-session').style.display     = 'none';
    $('session-name-display').textContent  = '—';
    $('session-timer').textContent         = '0:00';
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
  $('history-list').style.display  = historyVisible ? '' : 'none';
  $('btn-toggle-history').textContent = historyVisible ? 'Hide' : 'Show';
  if (historyVisible) loadSessionHistory();
});

async function loadSessionHistory() {
  try {
    const sessions = await api('GET', '/sessions');
    const list  = $('history-list');
    const empty = $('history-empty');

    list.innerHTML = '';
    if (!sessions.length) {
      list.appendChild(empty);
      return;
    }

    sessions.slice(0, 10).forEach(s => {
      const div = document.createElement('div');
      div.className = 'history-item';
      div.innerHTML = `
        <div class="history-item-info">
          <span class="history-name">${escHtml(s.name)}</span>
          <span class="history-date">${formatDate(s.startTime)}</span>
          <span class="history-dur">${s.duration ? formatDuration(s.duration) : (s.endTime ? '—' : 'active')}</span>
        </div>
        <button class="btn-sm" data-action="view-analytics" data-sid="${s.id}" data-sname="${escHtml(s.name)}">View</button>
      `;
      list.appendChild(div);
    });
  } catch (err) {
    console.warn('History load failed:', err.message);
  }
}

$('history-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-action="view-analytics"]');
  if (!btn) return;
  const sid   = parseInt(btn.dataset.sid, 10);
  const sname = btn.dataset.sname;
  openSessionAnalytics(sid, sname);
});

$('btn-toggle-history').textContent = 'Show';

// ── Session Replay ─────────────────────────────────────────────────────────────
function setupReplay(epochs, session) {
  replayEpochs  = epochs.filter(e => e.elapsedSeconds != null).sort((a,b) => a.elapsedSeconds - b.elapsedSeconds);
  replayCurrentIdx = 0;
  replayPlaying = false;
  replaySpeed   = 1;

  if (!replayEpochs.length) {
    const rp = $('replay-player');
    if (rp) rp.style.display = 'none';
    return;
  }

  const lastEpoch = replayEpochs[replayEpochs.length - 1];
  replaySessionDuration = lastEpoch.elapsedSeconds || session.duration || 0;

  const slider = $('replay-slider');
  if (slider) {
    slider.min   = 0;
    slider.max   = replayEpochs.length - 1;
    slider.value = 0;
  }

  updateReplayUI();

  const rp = $('replay-player');
  if (rp) rp.style.display = '';

  // Keyboard shortcuts
  document.addEventListener('keydown', onReplayKeydown);
}

function stopReplay() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  replayPlaying = false;
  replayEpochs  = [];
  const playBtn = $('replay-play');
  if (playBtn) playBtn.textContent = '▶';
  const rp = $('replay-player');
  if (rp) rp.style.display = 'none';
  document.removeEventListener('keydown', onReplayKeydown);
}

function onReplayKeydown(e) {
  // Only act if analytics overlay is open
  if ($('analytics-overlay').style.display === 'none') return;
  if (e.code === 'Space')       { e.preventDefault(); toggleReplayPlay(); }
  if (e.code === 'ArrowLeft')   { e.preventDefault(); replayJump(-10); }
  if (e.code === 'ArrowRight')  { e.preventDefault(); replayJump(+10); }
}

function toggleReplayPlay() {
  replayPlaying ? pauseReplay() : playReplay();
}

function playReplay() {
  if (!replayEpochs.length) return;
  if (replayCurrentIdx >= replayEpochs.length - 1) replayCurrentIdx = 0;

  replayPlaying = true;
  const playBtn = $('replay-play');
  if (playBtn) playBtn.textContent = '⏸';

  // Each epoch: use elapsed diff between adjacent epochs, scaled by speed
  const advanceEpoch = () => {
    if (!replayPlaying || replayCurrentIdx >= replayEpochs.length - 1) {
      pauseReplay();
      return;
    }
    replayCurrentIdx++;
    applyReplayEpoch(replayCurrentIdx);
    updateReplayUI();

    // Time until next epoch
    const curr = replayEpochs[replayCurrentIdx];
    const next = replayEpochs[replayCurrentIdx + 1];
    const delay = next ? Math.max(50, (next.elapsedSeconds - curr.elapsedSeconds) * 1000 / replaySpeed) : 1000;
    replayTimer = setTimeout(advanceEpoch, delay);
  };

  applyReplayEpoch(replayCurrentIdx);
  updateReplayUI();
  const curr = replayEpochs[replayCurrentIdx];
  const next = replayEpochs[replayCurrentIdx + 1];
  const delay = next ? Math.max(50, (next.elapsedSeconds - curr.elapsedSeconds) * 1000 / replaySpeed) : 1000;
  replayTimer = setTimeout(advanceEpoch, delay);
}

function pauseReplay() {
  replayPlaying = false;
  if (replayTimer) { clearTimeout(replayTimer); replayTimer = null; }
  const playBtn = $('replay-play');
  if (playBtn) playBtn.textContent = '▶';
}

function replayJump(seconds) {
  if (!replayEpochs.length) return;
  const targetSec = (replayEpochs[replayCurrentIdx]?.elapsedSeconds || 0) + seconds;
  // Find nearest epoch
  let bestIdx = replayCurrentIdx;
  let bestDiff = Infinity;
  replayEpochs.forEach((ep, i) => {
    const diff = Math.abs(ep.elapsedSeconds - targetSec);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  });
  replayCurrentIdx = Math.max(0, Math.min(replayEpochs.length - 1, bestIdx));
  applyReplayEpoch(replayCurrentIdx);
  updateReplayUI();
  // If playing, restart timer from new position
  if (replayPlaying) { pauseReplay(); playReplay(); }
}

function applyReplayEpoch(idx) {
  const ep = replayEpochs[idx];
  if (!ep) return;

  const bands = ep.bands || {};
  const gunas = ep.gunas || {};

  // Build a reading object identical to what applyReading expects
  const reading = {
    epoch: ep.epochNum,
    data_quality: '⏮ replay',
    latency_ms: null,
    chitta_bhumi: {
      state: ep.chittaBhumi || '—',
      depth: ep.contemplativeDepth || '—',
      confidence: ep.chittaConfidence || '—',
      probabilities: {},
    },
    swara: {
      state: ep.swara || '—',
      confidence: ep.swaraConfidence || '—',
    },
    tattva_flags: ep.tattvaFlags || [],
    alpha_asymmetry: 0,
    eeg_spectrum: bands,
    gunas: {
      sattva: gunas.sattva,
      rajas:  gunas.rajas,
      tamas:  gunas.tamas,
      label:  gunas.label || '—',
    },
  };

  // Apply to all live UI widgets — same path as live streaming
  const savedActiveSession = activeSession;
  activeSession = null; // don't re-store epochs during replay
  applyReading(reading);
  activeSession = savedActiveSession;
}

function updateReplayUI() {
  const ep   = replayEpochs[replayCurrentIdx];
  const curr = ep?.elapsedSeconds ?? 0;
  const total = replaySessionDuration;

  const currentTimeEl = $('replay-current-time');
  const totalTimeEl   = $('replay-total-time');
  const slider        = $('replay-slider');

  if (currentTimeEl) currentTimeEl.textContent = formatTime(curr);
  if (totalTimeEl)   totalTimeEl.textContent   = formatTime(total);
  if (slider)        slider.value = replayCurrentIdx;
}

// Replay event listeners
document.addEventListener('DOMContentLoaded', () => {
  const replay = id => $(id);

  const bindReplay = () => {
    const playBtn    = $('replay-play');
    const restartBtn = $('replay-restart');
    const backBtn    = $('replay-back');
    const fwdBtn     = $('replay-fwd');
    const speedSel   = $('replay-speed');
    const slider     = $('replay-slider');

    if (playBtn)    playBtn.addEventListener('click', toggleReplayPlay);
    if (restartBtn) restartBtn.addEventListener('click', () => {
      pauseReplay();
      replayCurrentIdx = 0;
      applyReplayEpoch(0);
      updateReplayUI();
    });
    if (backBtn) backBtn.addEventListener('click', () => replayJump(-10));
    if (fwdBtn)  fwdBtn.addEventListener('click',  () => replayJump(+10));
    if (speedSel) speedSel.addEventListener('change', () => {
      replaySpeed = parseFloat(speedSel.value) || 1;
      if (replayPlaying) { pauseReplay(); playReplay(); }
    });
    if (slider) {
      slider.addEventListener('input', () => {
        const idx = parseInt(slider.value, 10);
        replayCurrentIdx = idx;
        applyReplayEpoch(idx);
        updateReplayUI();
      });
      slider.addEventListener('mousedown', () => { if (replayPlaying) pauseReplay(); });
    }
  };
  bindReplay();
});

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
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
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
  ctx.lineJoin  = 'round';
  ctx.lineCap   = 'round';

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
