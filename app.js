/* ════════════════════════════════════════════════════════════════════════════
   EEG DEV TESTING — app.js
   Modes: demo | bluetooth+backend | bluetooth-local | backend-url
   Auth: Login → Session management → Admin dashboard (dedicated page)
   New: Trigunas display, Session epoch storage, Admin session analytics
════════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const SAMPLE_RATE  = 256;
const COLLECT_SECS = 2;
const COLLECT_N    = SAMPLE_RATE * COLLECT_SECS;
const WAVE_LEN     = 300;
const DEMO_INTERVAL = 1200;

const MUSE_SERVICE_UUID  = '0000fe8d-0000-1000-8000-00805f9b34fb';
const MUSE_CONTROL_UUID  = '273e0001-4c4d-454d-96be-f03bac821358';
const MUSE_EEG_UUIDS = [
  '273e0003-4c4d-454d-96be-f03bac821358',
  '273e0004-4c4d-454d-96be-f03bac821358',
  '273e0005-4c4d-454d-96be-f03bac821358',
  '273e0006-4c4d-454d-96be-f03bac821358',
];

const DEPTH_PCT    = { Surface: 12, Emerging: 37, Deep: 62, Profound: 94 };
const CHITTA_DEPTHS = { Kshipta: 'Surface', Vikshipta: 'Emerging', Ekagra: 'Deep', Niruddha: 'Profound' };
const SWARA_NOTES = {
  ida:      'Parasympathetic dominance. Receptive, creative and introspective state.',
  pingala:  'Sympathetic dominance. Active, analytical and goal-directed focus.',
  sushumna: 'Equilibrium of solar and lunar channels. Gateway to higher contemplative states.',
};

// ── App state ─────────────────────────────────────────────────────────────────
let mode            = 'idle';
let backendUrl      = localStorage.getItem('controlhub_url') || 'https://eeg-backend-5.onrender.com';
let btDevice        = null;
let btDisconnect    = null;
let demoTimer       = null;
let epoch           = 0;
let demoStateIdx    = 0;
let demoSwaraIdx    = 0;
let demoEpoch       = 0;
let pollTimer       = null;
let sseSource       = null;
let backendPollTimer = null;

// Auth state
let currentUser = null; // { id, username, role }

// Session state
let activeSession         = null; // { id, name, startTime }
let sessionTimerInterval  = null;
let notesSaveTimeout      = null;
let sessionEpochCounter   = 0;   // epoch counter within current session
let sessionStartTimestamp = null; // Date object when session started

// Admin page state
let adminCurrentTab     = 'users';
let resetPwTargetUserId = null;

const bleChannels = [[], [], [], []];
let blePhase   = 0;
let bleSamTick = 0;

const waveBuf  = new Float32Array(WAVE_LEN);
let waveTail   = 0;
let wavePhase  = 0;

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
  const res  = await fetch('/api' + path, opts);
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
  $('login-screen').style.display    = 'flex';
  $('main-header').style.display     = 'none';
  $('main-content').style.display    = 'none';
  $('admin-page').style.display      = 'none';
}

function showMainApp() {
  $('login-screen').style.display    = 'none';
  $('main-header').style.display     = '';
  $('main-content').style.display    = '';
  $('admin-page').style.display      = 'none';

  // Update user menu
  $('user-avatar-initial').textContent = (currentUser.username[0] || '?').toUpperCase();
  $('user-display-name').textContent   = currentUser.username;
  $('user-menu-role').textContent      = currentUser.role;

  $('btn-open-admin').style.display = currentUser.role === 'admin' ? '' : 'none';

  // Start canvas
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

  // Load the active admin tab
  openAdminTab(adminCurrentTab);
}

// ── Login form ────────────────────────────────────────────────────────────────
$('btn-login').addEventListener('click', async () => {
  const username = $('input-username').value.trim();
  const password = $('input-password').value;
  const errEl    = $('login-error');
  errEl.style.display = 'none';
  $('btn-login').disabled = true;
  $('btn-login').textContent = 'Signing in…';

  try {
    currentUser = await api('POST', '/auth/login', { username, password });
    showMainApp();
  } catch (err) {
    errEl.textContent    = err.message || 'Login failed';
    errEl.style.display  = '';
  } finally {
    $('btn-login').disabled    = false;
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
  currentUser    = null;
  activeSession  = null;
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
$('btn-open-admin').addEventListener('click', () => {
  showAdminPage();
});

$('btn-back-to-dashboard').addEventListener('click', () => {
  showMainApp();
});

// Admin tab switching
qAll('.admin-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    openAdminTab(tab.dataset.tab);
  });
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
  $('create-user-form').style.display    = '';
  $('create-user-error').style.display   = 'none';
  $('new-username').value  = '';
  $('new-password').value  = '';
  $('new-role').value      = 'user';
});

$('btn-cancel-create-user').addEventListener('click', () => {
  $('create-user-form').style.display = 'none';
});

$('btn-create-user').addEventListener('click', async () => {
  const username = $('new-username').value.trim();
  const password = $('new-password').value;
  const role     = $('new-role').value;
  const errEl    = $('create-user-error');
  errEl.style.display = 'none';

  if (!username || !password) {
    errEl.textContent   = 'Username and password required.';
    errEl.style.display = '';
    return;
  }

  try {
    await api('POST', '/users', { username, password, role });
    $('create-user-form').style.display = 'none';
    await loadAdminUsers();
  } catch (err) {
    errEl.textContent   = err.message;
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
    resetPwTargetUserId              = null;
    $('reset-pw-input').value        = '';
    alert('Password updated.');
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

async function loadAdminUsers() {
  const tbody = $('admin-users-tbody');
  tbody.innerHTML = '<tr><td colspan="4" class="table-loading">Loading…</td></tr>';
  try {
    const users = await api('GET', '/users');
    tbody.innerHTML = '';
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="table-loading">No users found.</td></tr>';
      return;
    }
    users.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escHtml(u.username)}</strong></td>
        <td><span class="role-badge role-${u.role}">${escHtml(u.role)}</span></td>
        <td>${formatDate(u.createdAt)}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-ghost btn-sm" data-action="reset-pw" data-uid="${u.id}">Reset PW</button>
            ${u.id !== currentUser.id
              ? `<button class="btn btn-danger btn-sm" data-action="delete-user" data-uid="${u.id}">Delete</button>`
              : '<span style="font-size:11px;color:var(--text-muted)">(you)</span>'
            }
          </div>
        </td>`;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="table-error">${escHtml(err.message)}</td></tr>`;
  }
}

$('admin-users-tbody').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const uid    = parseInt(btn.dataset.uid, 10);
  const action = btn.dataset.action;

  if (action === 'reset-pw') {
    resetPwTargetUserId          = uid;
    $('reset-pw-input').value    = '';
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
  tbody.innerHTML = '<tr><td colspan="6" class="table-loading">Loading…</td></tr>';
  try {
    const sessions = await api('GET', '/sessions');
    tbody.innerHTML = '';
    if (!sessions.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-loading">No sessions yet.</td></tr>';
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
        <td><span class="epoch-badge" id="epoch-count-${s.id}">—</span></td>
        <td>
          <div class="table-actions">
            <button class="btn btn-secondary btn-sm" data-action="view-analytics" data-sid="${s.id}" data-sname="${escHtml(s.name)}">
              View Analytics
            </button>
          </div>
        </td>`;
      tbody.appendChild(tr);
    });

    // Load epoch counts in background (best-effort)
    loadEpochCounts(sessions);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-error">${escHtml(err.message)}</td></tr>`;
  }
}

async function loadEpochCounts(sessions) {
  // Fire all analytics requests, pick only epoch count from summary
  await Promise.allSettled(sessions.map(async s => {
    try {
      const data = await api('GET', '/sessions/' + s.id + '/analytics');
      const el   = $('epoch-count-' + s.id);
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

  // Meta subtitle
  $('analytics-session-name').textContent = session.name;
  $('analytics-session-meta').textContent =
    `${session.username || '?'} · ${formatDate(session.startTime)}` +
    (session.duration ? ` · ${formatDuration(session.duration)}` : '');

  // ── Summary stats ──
  $('a-total-epochs').textContent  = summary.totalEpochs ?? '—';
  $('a-duration').textContent      = summary.durationSeconds ? formatDuration(summary.durationSeconds) : '—';

  // Dominant guna
  const gunaLabel = summary.dominantGuna
    ? summary.dominantGuna.charAt(0).toUpperCase() + summary.dominantGuna.slice(1)
    : '—';
  $('a-dominant-guna').textContent = gunaLabel;
  $('a-dominant-guna').style.color = summary.dominantGuna === 'sattva' ? 'var(--sattva)'
    : summary.dominantGuna === 'rajas' ? 'var(--rajas)'
    : summary.dominantGuna === 'tamas' ? 'var(--tamas)' : 'var(--text)';

  // Dominant Chitta Bhumi
  const stateEntries = Object.entries(summary.stateBreakdown || {}).sort((a, b) => b[1] - a[1]);
  $('a-dominant-state').textContent = stateEntries[0]?.[0] ?? '—';

  // ── Gunas bars ──
  const avgGunas = summary.avgGunas || {};
  setAnalyticsGuna('sattva', avgGunas.sattva);
  setAnalyticsGuna('rajas',  avgGunas.rajas);
  setAnalyticsGuna('tamas',  avgGunas.tamas);

  // ── State breakdown ──
  const stateColors = { Kshipta: 'var(--kshipta)', Vikshipta: 'var(--vikshipta)', Ekagra: 'var(--ekagra)', Niruddha: 'var(--niruddha)' };
  renderBreakdownList('a-state-breakdown', summary.stateBreakdown || {}, stateColors);

  // ── Swara breakdown ──
  const swaraColors = { Ida: 'var(--ida)', Pingala: 'var(--pingala)', Sushumna: 'var(--sushumna)' };
  renderBreakdownList('a-swara-breakdown', summary.swaraBreakdown || {}, swaraColors);

  // ── Avg bands ──
  renderAvgBands(summary.avgBands || {});

  // ── Timeline of phases ──
  renderTimeline(summary.phases || []);
}

function setAnalyticsGuna(name, value) {
  const pct = value != null ? (value * 100).toFixed(1) : null;
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
  if (!entries.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">No data</div>';
    return;
  }
  entries.forEach(([label, pct]) => {
    const color = colorMap[label] || 'var(--accent)';
    const div = document.createElement('div');
    div.className = 'breakdown-item';
    div.innerHTML = `
      <span class="breakdown-label">${escHtml(label)}</span>
      <div class="breakdown-bar-bg">
        <div class="breakdown-bar" style="width:${pct}%;background:${color}"></div>
      </div>
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
    const val  = bands[key];
    const pct  = val != null ? (val * 100).toFixed(1) + '%' : '—';
    const div  = document.createElement('div');
    div.className = 'analytics-band-pill';
    div.innerHTML = `
      <span class="analytics-band-sym" style="color:${color}">${sym}</span>
      <span class="analytics-band-name">${name}</span>
      <span class="analytics-band-val">${pct}</span>`;
    container.appendChild(div);
  });
}

function renderTimeline(phases) {
  const container = $('a-timeline');
  if (!container) return;
  container.innerHTML = '';

  if (!phases.length) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:12px 0">No epoch data recorded for this session.</div>';
    return;
  }

  phases.forEach(phase => {
    const fromStr = phase.fromSeconds != null ? formatTime(phase.fromSeconds) : '—';
    const toStr   = phase.toSeconds   != null ? formatTime(phase.toSeconds)   : '—';
    const timeStr = `${fromStr} → ${toStr}`;

    // Build dominant guna badge for this phase
    const gunas = phase.avgGunas || {};
    const dominantGunaKey = Object.entries(gunas).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0]?.[0];
    const gunaLabels = { sattva: '☀ Sattvic', rajas: '🔥 Rajasic', tamas: '🌑 Tamasic' };
    const gunaClass  = { sattva: 'tgb-sattva', rajas: 'tgb-rajas', tamas: 'tgb-tamas' };
    const gunaBadge  = dominantGunaKey
      ? `<span class="timeline-guna-badge ${gunaClass[dominantGunaKey]}">${gunaLabels[dominantGunaKey]}</span>`
      : '';

    // Band summary for this phase
    const bands = phase.avgBands || {};
    const topBand = Object.entries(bands).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0];
    const bandNote = topBand ? `Dominant band: ${topBand[0]} (${(topBand[1] * 100).toFixed(1)}%)` : '';

    const div = document.createElement('div');
    div.className = `timeline-phase phase-${phase.state}`;
    div.innerHTML = `
      <div class="timeline-time">${escHtml(timeStr)}</div>
      <div class="timeline-state">
        <div class="timeline-state-name">${escHtml(phase.state)}</div>
        <div class="timeline-state-depth">${escHtml(phase.depth || '')}</div>
        ${bandNote ? `<div class="timeline-state-detail">${escHtml(bandNote)}</div>` : ''}
      </div>
      <div class="timeline-gunas">${gunaBadge}</div>
      <div class="timeline-epoch-count">${phase.epochCount} epoch${phase.epochCount !== 1 ? 's' : ''}</div>`;
    container.appendChild(div);
  });
}

// ── EEG Readings → UI ─────────────────────────────────────────────────────────
function setStatus(type, text) {
  const dot  = $('status-dot');
  const txt  = $('status-text');
  dot.className = 'status-dot' + (type ? ' ' + type : '');
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
  $('val-latency').textContent = r.latency_ms   != null ? r.latency_ms.toFixed(1) : '—';

  // ── Chitta Bhumi ──
  const ch    = r.chitta_bhumi || {};
  const state = ch.state || '—';
  $('chitta-state').textContent = state;
  $('chitta-sub').textContent   = ch.depth || ch.confidence || '—';

  // Depth bar
  const depth     = ch.depth || CHITTA_DEPTHS[state] || 'Surface';
  const depthPct  = DEPTH_PCT[depth] ?? 12;
  const depthFill = $('depth-fill');
  const depthColor = state === 'Kshipta' ? 'var(--kshipta)' : state === 'Vikshipta' ? 'var(--vikshipta)'
    : state === 'Ekagra' ? 'var(--ekagra)' : 'var(--niruddha)';
  depthFill.style.width      = depthPct + '%';
  depthFill.style.background = depthColor;

  $('val-confidence').textContent = ch.confidence || '—';
  $('val-depth').textContent      = depth;

  // State probabilities
  const probs = ch.probabilities || {};
  ['Kshipta', 'Vikshipta', 'Ekagra', 'Niruddha'].forEach(s => {
    const raw = probs[s] ?? '0%';
    const pct = parseFloat(raw);
    const key = s.toLowerCase();
    const el  = $('prob-' + key);
    const bar = $('bar-' + key);
    if (el)  el.textContent  = isNaN(pct) ? raw : pct.toFixed(1) + '%';
    if (bar) bar.style.width = (isNaN(pct) ? parseFloat(raw) : pct) + '%';
  });

  // ── Swara ──
  const sw  = r.swara || {};
  const sst = (sw.state || '').toLowerCase();
  const isIda      = /ida/.test(sst);
  const isPingala  = /pingala/.test(sst);
  const isSushumna = !isIda && !isPingala;

  $('swara-note').textContent       = sw.note || (isIda ? SWARA_NOTES.ida : isPingala ? SWARA_NOTES.pingala : SWARA_NOTES.sushumna);
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
  const bands = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
  bands.forEach(b => {
    const raw = spectrum[b] ?? null;
    const pct = raw != null ? (raw * 100).toFixed(1) : null;
    const valEl = $('val-' + b);
    const barEl = $('bar-' + b);
    if (valEl) valEl.textContent = pct ? pct + '%' : '—';
    if (barEl) barEl.style.width = pct ? Math.min(pct, 100) + '%' : '0%';
  });

  // ── Tattva Flags ──
  const flags   = r.tattva_flags || r.tattva || [];
  const flagDiv = $('tattva-flags');
  flagDiv.innerHTML = '';
  if (!flags.length) {
    flagDiv.innerHTML = 'no flags active';
  } else {
    flags.forEach(f => {
      const span = document.createElement('span');
      let cls = 'tattva-other';
      if (/tattva/i.test(f))    cls = 'tattva-activation';
      else if (/pratyahara/i.test(f)) cls = 'pratyahara';
      else if (/turiya/i.test(f))     cls = 'turiya';
      else if (/gamma/i.test(f))      cls = 'gamma-spike';
      span.className  = 'tattva-flag ' + cls;
      span.textContent = f;
      flagDiv.appendChild(span);
    });
  }

  // ── Trigunas ──
  applyGunas(r.gunas);

  // ── Store epoch to DB (if session active) ──
  if (activeSession) {
    storeEpoch(r, spectrum, flags);
  }

  // ── Waveform pulse ──
  const ampSrc = spectrum.alpha || spectrum.theta || 0.2;
  const amp = 0.3 + ampSrc * 1.5;
  for (let i = 0; i < 8; i++) {
    waveBuf[waveTail % WAVE_LEN] = Math.sin(wavePhase + i * 0.8) * amp;
    waveTail++;
    wavePhase += 0.18;
  }
}

// ── Trigunas UI ───────────────────────────────────────────────────────────────
function applyGunas(gunas) {
  if (!gunas) {
    // Compute locally if not provided by backend
    gunas = computeLocalGunas();
  }

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

/**
 * computeLocalGunas — simple heuristic for demo/local-FFT mode
 * when the Python backend doesn't return gunas.
 */
function computeLocalGunas() {
  // Read current band bar widths as a proxy for band power
  const get = id => parseFloat($('bar-' + id)?.style.width || '0') / 100;
  const alpha = get('alpha'), theta = get('theta'), beta = get('beta'),
        delta = get('delta'), gamma = get('gamma');

  let sat = alpha * 3.0 + theta * 1.5 - beta * 1.5;
  let raj = beta * 3.0 + gamma * 2.5 - alpha * 1.5;
  let tam = delta * 3.0 - alpha * 1.5;

  sat = Math.max(sat, 0.05);
  raj = Math.max(raj, 0.05);
  tam = Math.max(tam, 0.05);
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

  const ch    = r.chitta_bhumi  || {};
  const sw    = r.swara         || {};
  const gunas = r.gunas         || computeLocalGunas();

  // Determine simple swara key
  const swaraState = sw.state || '';
  const swaraSimple = /ida/i.test(swaraState) ? 'Ida' : /pingala/i.test(swaraState) ? 'Pingala' : 'Sushumna';

  const epochBody = {
    epochNum:          sessionEpochCounter,
    elapsedSeconds:    elapsedSeconds ? +elapsedSeconds.toFixed(2) : null,
    chittaBhumi:       ch.state            || null,
    chittaConfidence:  ch.confidence       || null,
    contemplativeDepth: ch.depth           || null,
    swara:             swaraSimple,
    swaraConfidence:   sw.confidence       || null,
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

  // Fire-and-forget — don't block the UI
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

  const asym = (Math.random()-0.5) * 0.3;
  const isIda = asym < -0.04, isPingala = asym > 0.04;
  const swaraState = isIda ? 'Ida Nadi — right hemisphere dominant'
    : isPingala ? 'Pingala Nadi — left hemisphere dominant'
    : 'Sushumna — both nadis balanced';
  const swaraNote = isIda ? SWARA_NOTES.ida : isPingala ? SWARA_NOTES.pingala : SWARA_NOTES.sushumna;

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
    swara:        { state: swaraState, confidence: Math.abs(asym)>0.12 ? 'High' : 'Moderate', note: swaraNote },
    band_powers:  { relative: bp },
    eeg_spectrum: bp,
    alpha_asymmetry: asym,
    tattva_flags: tattva,
    contemplative_depth: depth,
    // gunas not included — will be computed locally in applyReading
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
  'Ida Nadi — right hemisphere dominant':    SWARA_NOTES.ida,
  'Pingala Nadi — left hemisphere dominant': SWARA_NOTES.pingala,
  'Sushumna — both nadis balanced':          SWARA_NOTES.sushumna,
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
    const state = DEMO_STATES[demoStateIdx];
    const swaraStr = DEMO_SWARA[demoSwaraIdx];
    const bp = DEMO_BANDS[state];

    // Simulated probs
    const probMap = {};
    DEMO_STATES.forEach((s, i) => {
      probMap[s] = (i === demoStateIdx ? 72 + Math.random()*10 : 5 + Math.random()*8).toFixed(1) + '%';
    });
    const asym = demoSwaraIdx === 0 ? -0.2 : demoSwaraIdx === 1 ? 0.2 : 0.01;

    epoch++;
    applyReading({
      epoch,
      latency_ms: 18 + Math.random()*6,
      data_quality: '✓ demo mode',
      chitta_bhumi: {
        state,
        depth: CHITTA_DEPTHS[state],
        confidence: (72 + Math.random()*10).toFixed(1) + '%',
        probabilities: probMap,
      },
      swara: {
        state: swaraStr,
        confidence: Math.abs(asym) > 0.12 ? 'High' : 'Moderate',
        note: SWARA_NOTES_MAP[swaraStr],
      },
      eeg_spectrum: bp,
      alpha_asymmetry: asym,
      tattva_flags: [],
      contemplative_depth: CHITTA_DEPTHS[state],
    });

    // Advance state every few ticks
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

// ── Demo button ───────────────────────────────────────────────────────────────
$('btn-demo').addEventListener('click', () => {
  if (mode === 'demo') stopDemo();
  else startDemo();
});

// ── Bluetooth ─────────────────────────────────────────────────────────────────
$('btn-bt-scan').addEventListener('click', async () => {
  $('settings-overlay').classList.remove('open');
  await connectBluetooth();
});
$('btn-bt-disconnect').addEventListener('click', disconnectBluetooth);
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
      filters:          [{ services: [MUSE_SERVICE_UUID] }],
      optionalServices: [MUSE_SERVICE_UUID],
    });
    btDevice = device;
    device.addEventListener('gattserverdisconnected', onBtDisconnected);

    const server  = await device.gatt.connect();
    const service = await server.getPrimaryService(MUSE_SERVICE_UUID);

    const controlChar = await service.getCharacteristic(MUSE_CONTROL_UUID).catch(() => null);
    if (controlChar) {
      const enc = new TextEncoder();
      await controlChar.writeValue(enc.encode('p21\n'));
      await new Promise(r => setTimeout(r, 300));
      await controlChar.writeValue(enc.encode('d\n'));
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
  } catch (err) {
    if (!err.message?.includes('cancelled')) {
      console.warn('BT connect failed:', err.message);
      setStatus('error', 'BT failed');
    }
  }
}

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
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ eeg_data: snapshot, sample_rate: SAMPLE_RATE }),
        signal:  AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data    = await res.json();
      const latency = (performance.now() - t0).toFixed(1);
      epoch++;
      applyReading({
        epoch, latency_ms: parseFloat(latency),
        data_quality: '✓ BLE → Render',
        timestamp: new Date().toISOString().slice(11,22) + ' UTC',
        chitta_bhumi: {
          state:         data.chitta_bhumi?.state      || '—',
          depth:         data.chitta_bhumi?.depth       || data.depth || '—',
          confidence:    data.chitta_bhumi?.confidence  || '—',
          probabilities: data.chitta_bhumi?.probabilities || {},
        },
        swara: {
          state:      data.swara?.state      || '—',
          confidence: data.swara?.confidence || '—',
          note:       data.swara?.note       || '',
        },
        tattva_flags:        data.tattva || data.tattva_flags || [],
        contemplative_depth: data.depth || '—',
        alpha_asymmetry:     0,
        eeg_spectrum:        data.eeg_spectrum || null,
        // NEW: backend now returns gunas
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
      const res  = await fetch(url.replace(/\/$/, '') + '/status', { signal: AbortSignal.timeout(5000) });
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
  clearInterval(demoTimer);        demoTimer        = null;
  clearInterval(pollTimer);        pollTimer        = null;
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
  if (name === null) return; // cancelled

  try {
    const sess = await api('POST', '/sessions/start', { name: name.trim() || 'New Session' });
    activeSession        = sess;
    sessionStartTimestamp = new Date();
    sessionEpochCounter  = 0;

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
    activeSession = null;
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
  $('history-list').style.display    = historyVisible ? '' : 'none';
  $('btn-toggle-history').textContent = historyVisible ? 'Hide' : 'Show';
  if (historyVisible) loadSessionHistory();
});

async function loadSessionHistory() {
  try {
    const sessions = await api('GET', '/sessions');
    const list     = $('history-list');
    const empty    = $('history-empty');

    list.innerHTML = '';
    if (!sessions.length) {
      list.appendChild(empty);
      return;
    }

    sessions.slice(0, 10).forEach(s => {
      const div = document.createElement('div');
      div.className = 'history-item';
      div.innerHTML = `
        <div class="history-info">
          <div class="history-name">${escHtml(s.name)}</div>
          <div class="history-meta">${formatDate(s.startTime)}</div>
        </div>
        <div class="history-dur">${s.duration ? formatDuration(s.duration) : (s.endTime ? '—' : 'active')}</div>`;
      list.appendChild(div);
    });
  } catch (err) {
    console.warn('History load failed:', err.message);
  }
}

// ── History toggle btn ────────────────────────────────────────────────────────
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
  const w = canvas.clientWidth, h = 110;
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
  grad.addColorStop(0, 'rgba(217,119,87,0)');
  grad.addColorStop(0.18, 'rgba(217,119,87,0.8)');
  grad.addColorStop(0.85, 'rgba(217,119,87,0.8)');
  grad.addColorStop(1, 'rgba(217,119,87,0)');
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

// Start by checking auth — show login or main app accordingly
checkAuth();
