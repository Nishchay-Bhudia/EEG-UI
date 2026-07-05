/* ════════════════════════════════════════════════════════════════════════════
 EEG DEV TESTING — app.js
 Modes: demo | bluetooth+backend | bluetooth-local | backend-url
 Auth: Login → Session management → Admin dashboard (dedicated page)
 New: Trigunas display, Session epoch storage, Admin session analytics
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

// Muse S PPG UUIDs for heart rate and SpO2
const MUSE_PPG_UUIDS = {
  ambient: '273e000f-4c4d-454d-96be-f03bac821358',
  ir:      '273e0010-4c4d-454d-96be-f03bac821358',
  red:     '273e0011-4c4d-454d-96be-f03bac821358',
};
const PPG_SAMPLE_RATE = 64;
const PPG_WINDOW_SAMPLES = PPG_SAMPLE_RATE * 8; // 8-second window

const DEPTH_PCT = { 'Deep Inertia': 3, Surface: 12, Emerging: 37, Deep: 62, Profound: 94 };
const CHITTA_DEPTHS = { Mudha: 'Deep Inertia', Kshipta: 'Surface', Vikshipta: 'Emerging', Ekagra: 'Deep', Niruddha: 'Profound' };
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

// PPG state (Muse S heart rate / SpO2)
    const ppgBuf = { ambient: [], ir: [], red: [] };
    let latestHeartRate = null;
    let latestSpO2 = null;

    const waveBuf = new Float32Array(WAVE_LEN);
let waveTail = 0;
let wavePhase = 0;

// Band power state — updated each epoch; used by drawWave for live bar display
let lastBandPowers = { delta: 0.15, theta: 0.18, alpha: 0.28, low_beta: 0.18, high_beta: 0.13, gamma: 0.08 };

// Replay Player state
let replayEpochs = [];
let replayIndex = 0;
let replayTimer = null;
let replayPlaying = false;
let currentAnalyticsSessionId = null;

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

  const isElevated = currentUser.role === 'admin' || currentUser.role === 'co-admin';
  $('btn-open-admin').style.display = isElevated ? '' : 'none';

  resizeCanvas();
  requestAnimationFrame(drawWave);
  $('val-buffer').textContent = '0 / ' + COLLECT_N;

  if (backendUrl) {
    $('input-backend-url').value = backendUrl;
    // Ping once to show backend status, but don't force 'backend' mode — conflicts with BT
    pingBackendStatus(backendUrl);
  }

  loadSessionHistory();
}

function showAdminPage() {
  $('login-screen').style.display = 'none';
  $('main-header').style.display = '';
  $('main-content').style.display = 'none';
  $('admin-page').style.display = '';

  const isCoAdmin = currentUser.role === 'co-admin';
  const usersTabBtn = document.querySelector('.admin-tab[data-tab="users"]');
  if (usersTabBtn) usersTabBtn.style.display = isCoAdmin ? 'none' : '';
  const targetTab = isCoAdmin ? 'sessions' : adminCurrentTab;
  openAdminTab(targetTab);
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
    const res = await fetch(url + '/status', { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    testEl.style.color = '#56A67A';
    testEl.textContent = '✓ Connected — board: ' + (data.board || 'web-bluetooth') + (data.model_ready ? ' | model ready' : ' | model loading…');
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
  if (tabName === 'users' && currentUser.role === 'co-admin') tabName = 'sessions';
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
  tbody.innerHTML = '<tr><td colspan="5">Loading…</td></tr>';
  try {
    const users = await api('GET', '/users');
    tbody.innerHTML = '';
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="5">No users found.</td></tr>';
      return;
    }
    users.forEach(u => {
      const isSelf = u.id === currentUser.id;
      const roleClass = 'role-' + u.role.replace('-', '_');
      const roleSelector = !isSelf ? `
        <select class="field-input field-input-xs" data-action="select-role">
          <option value="user" ${u.role==='user'?'selected':''}>user</option>
          <option value="co-admin" ${u.role==='co-admin'?'selected':''}>co-admin</option>
          <option value="admin" ${u.role==='admin'?'selected':''}>admin</option>
        </select>
        <button class="btn btn-primary btn-sm" data-action="change-role" data-uid="${u.id}">Apply</button>
      ` : '';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escHtml(u.username)}</strong></td>
        <td><span class="role-badge ${roleClass}">${escHtml(u.role)}</span></td>
        <td>${formatDate(u.createdAt)}</td>
        <td>
          <div class="table-actions">
            ${roleSelector}
          </div>
        </td>
        <td>
          <div class="table-actions">
            <button class="btn btn-ghost btn-sm" data-action="reset-pw" data-uid="${u.id}">Reset PW</button>
            ${!isSelf
              ? `<button class="btn btn-danger btn-sm" data-action="delete-user" data-uid="${u.id}">Delete</button>`
              : '<span class="role-badge role-user">you</span>'}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5">${escHtml(err.message)}</td></tr>`;
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
  } else if (action === 'change-role') {
    const row = btn.closest('tr');
    const select = row.querySelector('[data-action="select-role"]');
    if (!select) return;
    const newRole = select.value;
    if (!confirm(`Change this user's role to "${newRole}"?`)) return;
    try {
      await api('PUT', '/users/' + uid + '/role', { role: newRole });
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
        <td data-username="${escHtml(s.username || '')}">${escHtml(s.username || '?')}</td>
        <td><strong>${escHtml(s.name)}</strong></td>
        <td>${formatDate(s.startTime)}</td>
        <td>${s.duration ? formatDuration(s.duration) : (s.endTime ? '—' : '<em>active</em>')}</td>
        <td><span class="epoch-badge" id="epoch-count-${s.id}">—</span></td>
        <td>
          <button class="btn btn-secondary btn-sm" data-action="view-analytics" data-sid="${s.id}" data-sname="${escHtml(s.name)}">
            View Analytics
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    loadEpochCounts(sessions);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6">${escHtml(err.message)}</td></tr>`;
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

function setAnalyticsState(state) {
  // state: 'loading' | 'error' | 'content'
  $('analytics-loading').style.display = state === 'loading' ? '' : 'none';
  $('analytics-error').style.display = state === 'error' ? '' : 'none';
  $('analytics-content').style.display = state === 'content' ? '' : 'none';
}

async function openSessionAnalytics(sessionId, sessionName) {
  currentAnalyticsSessionId = sessionId;
  $('analytics-session-name').textContent = sessionName || 'Session';
  $('analytics-session-meta').textContent = '';
  $('analytics-overlay').style.display = '';
  setAnalyticsState('loading');

  try {
    const data = await api('GET', '/sessions/' + sessionId + '/analytics');
    renderAnalyticsSummary(data.summary || {});
    renderAnalyticsTimeline(data.phases || []);
    setAnalyticsState('content');
    loadReplayData();
    loadAnalyticsNotes(sessionId);
  } catch (err) {
    $('analytics-error').textContent = err.message;
    setAnalyticsState('error');
  }
}

function pct(v) { return v != null ? Math.round(v * 100) + '%' : '—'; }

function renderAnalyticsSummary(s) {
  $('a-total-epochs').textContent = s.totalEpochs ?? '—';
  $('a-duration').textContent = s.durationSeconds ? formatDuration(s.durationSeconds) : '—';
  $('a-dominant-guna').textContent = s.dominantGuna ? capitalize(s.dominantGuna) : '—';
  $('a-dominant-state').textContent = s.dominantState ?? '—';
  $('a-avg-spo2').textContent = s.avgSpo2 != null ? s.avgSpo2.toFixed(1) : '—';
  $('a-avg-hr').textContent = s.avgHr != null ? s.avgHr.toFixed(0) : '—';

  const gunas = s.avgGunas || {};
  ['sattva', 'rajas', 'tamas'].forEach(g => {
    const barEl = $('a-bar-' + g);
    const pctEl = $('a-pct-' + g);
    if (barEl) barEl.style.width = (gunas[g] != null ? Math.round(gunas[g] * 100) : 0) + '%';
    if (pctEl) pctEl.textContent = pct(gunas[g]);
  });

  renderBreakdown('a-state-breakdown', s.stateCounts || {}, s.totalEpochs || 0);
  renderBreakdown('a-swara-breakdown', s.swaraCounts || {}, s.totalEpochs || 0);

  const bandsEl = $('a-avg-bands');
  if (bandsEl) {
    const syms = { delta: 'δ', theta: 'θ', alpha: 'α', beta: 'β', gamma: 'γ' };
    const avgBands = s.avgBands || {};
    bandsEl.innerHTML = ['delta', 'theta', 'alpha', 'beta', 'gamma'].map(b => `
      <div class="analytics-band-pill">
        <span class="analytics-band-sym">${syms[b]}</span>
        <span class="analytics-band-name">${b}</span>
        <span class="analytics-band-val">${pct(avgBands[b])}</span>
      </div>
    `).join('');
  }
}

function renderBreakdown(containerId, counts, total) {
  const el = $(containerId);
  if (!el) return;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:12px">No data.</p>'; return; }
  el.innerHTML = entries.map(([label, count]) => {
    const p = total ? Math.round((count / total) * 100) : 0;
    return `
      <div class="breakdown-item">
        <span class="breakdown-label">${escHtml(label)}</span>
        <div class="breakdown-bar-bg"><div class="breakdown-bar" style="width:${p}%"></div></div>
        <span class="breakdown-pct">${p}%</span>
      </div>
    `;
  }).join('');
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function renderAnalyticsTimeline(phases) {
  const el = $('a-timeline');
  if (!el) return;
  if (!phases.length) { el.innerHTML = '<p style="color:var(--text-muted);font-size:12px">No phase data.</p>'; return; }
  el.innerHTML = phases.map(p => `
    <div class="timeline-phase">
      <strong>${escHtml(p.state)}</strong>
      <span>${escHtml(p.depth || '')}</span>
      <span>${formatTime(p.fromSeconds)} – ${formatTime(p.toSeconds)}</span>
      <span>${p.epochCount} epochs</span>
    </div>
  `).join('');
}

// ── Session Notes (analytics modal) ───────────────────────────────────────────
async function loadAnalyticsNotes(sessionId) {
  const el = $('a-notes-content');
  if (!el) return;
  try {
    const data = await api('GET', '/sessions/' + sessionId + '/notes');
    el.innerHTML = data.content
      ? escHtml(data.content).replace(/\n/g, '<br>')
      : '<em class="analytics-notes-empty">No notes recorded for this session.</em>';
  } catch {
    el.innerHTML = '<em class="analytics-notes-empty">No notes recorded for this session.</em>';
  }
}

// ── Replay Player ─────────────────────────────────────────────────────────────
$('replay-prev').addEventListener('click', () => { updateReplayDisplay(replayIndex - 1); });
$('replay-next').addEventListener('click', () => { updateReplayDisplay(replayIndex + 1); });
$('replay-play-pause').addEventListener('click', () => {
  if (replayPlaying) stopReplay(); else startReplay();
});
$('replay-slider').addEventListener('input', e => { updateReplayDisplay(parseInt(e.target.value, 10)); });

function startReplay() {
  if (!replayEpochs.length) return;
  replayPlaying = true;
  $('replay-play-pause').textContent = '⏸ Pause';
  replayTimer = setInterval(() => {
    if (replayIndex >= replayEpochs.length - 1) { stopReplay(); return; }
    updateReplayDisplay(replayIndex + 1);
  }, 1500);
}

function stopReplay() {
  replayPlaying = false;
  clearInterval(replayTimer); replayTimer = null;
  $('replay-play-pause').textContent = '▶ Play';
}

async function loadReplayData() {
  stopReplay();
  replayEpochs = [];
  replayIndex = 0;
  const noData = $('replay-no-data');
  const stateDisplay = $('replay-state-display');
  const slider = $('replay-slider');

  if (!currentAnalyticsSessionId) { showReplayNoData(); return; }

  try {
    const data = await api('GET', '/sessions/' + currentAnalyticsSessionId + '/epochs');
    replayEpochs = Array.isArray(data) ? data : (data.epochs || []);
  } catch {
    showReplayNoData();
    return;
  }

  if (!replayEpochs.length) { showReplayNoData(); return; }

  if (noData) noData.style.display = 'none';
  if (stateDisplay) stateDisplay.style.display = '';
  if (slider) {
    slider.max = replayEpochs.length - 1;
    slider.value = 0;
  }
  updateReplayDisplay(0);
}

function showReplayNoData() {
  const noData = $('replay-no-data');
  const stateDisplay = $('replay-state-display');
  if (noData) noData.style.display = '';
  if (stateDisplay) stateDisplay.style.display = 'none';
  const epochLbl = $('replay-epoch-label');
  const timeLbl = $('replay-time-label');
  if (epochLbl) epochLbl.textContent = '—';
  if (timeLbl) timeLbl.textContent = '—';
}

function updateReplayDisplay(idx) {
  if (!replayEpochs.length) return;
  idx = Math.max(0, Math.min(idx, replayEpochs.length - 1));
  replayIndex = idx;
  const ep = replayEpochs[idx];
  const slider = $('replay-slider');
  if (slider) slider.value = idx;

  const epochLbl = $('replay-epoch-label');
  const timeLbl = $('replay-time-label');
  if (epochLbl) epochLbl.textContent = `${idx + 1} / ${replayEpochs.length}`;
  if (timeLbl) timeLbl.textContent = ep.elapsedSeconds != null ? formatTime(ep.elapsedSeconds) : '—';

  // Replay into the main display
  const ch = ep.chittaBhumi ? { state: ep.chittaBhumi, depth: ep.contemplativeDepth, confidence: ep.chittaConfidence, probabilities: {} } : {};
  const sw = ep.swara ? { state: ep.swara, confidence: ep.swaraConfidence, note: '' } : {};
  applyReading({
    epoch: ep.epochNum,
    chitta_bhumi: ch,
    swara: sw,
    band_powers: { relative: ep.bands || {} },
    eeg_spectrum: ep.bands || {},
    tattva_flags: ep.tattvaFlags || [],
    contemplative_depth: ep.contemplativeDepth,
    alpha_asymmetry: 0,
    gunas: ep.gunas || null,
    blood_oxygen: ep.bloodOxygen,
    heart_rate: ep.heartRate,
    latency_ms: null,
    data_quality: '⏪ replay',
  });

  // Replay state summary panel
  const stateValEl = $('replay-state-val');
  const swaraValEl = $('replay-swara-val');
  const gunaValEl = $('replay-guna-val');
  const alphaValEl = $('replay-alpha-val');
  const spo2ValEl = $('replay-spo2-val');
  const hrValEl = $('replay-hr-val');
  if (stateValEl) stateValEl.textContent = ep.chittaBhumi || '—';
  if (swaraValEl) swaraValEl.textContent = ep.swara || '—';
  if (gunaValEl) gunaValEl.textContent = ep.gunas?.label || '—';
  if (alphaValEl) alphaValEl.textContent = ep.bands?.alpha != null ? Math.round(ep.bands.alpha * 100) + '%' : '—';
  if (spo2ValEl) spo2ValEl.textContent = ep.bloodOxygen != null ? ep.bloodOxygen.toFixed(1) + '%' : '—';
  if (hrValEl) hrValEl.textContent = ep.heartRate != null ? ep.heartRate.toFixed(0) + ' bpm' : '—';
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
    $('session-status').style.display = '';
    $('btn-start-session').style.display = 'none';
    $('btn-end-session').style.display = '';
    $('session-notes').value = '';
    $('session-notes').disabled = false;

    clearInterval(sessionTimerInterval);
    sessionTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - sessionStartTimestamp) / 1000);
      $('session-timer').textContent = formatTime(elapsed);
    }, 1000);
    $('session-timer').textContent = '0:00';
  } catch (err) {
    alert('Failed to start session: ' + err.message);
  }
});

$('btn-end-session').addEventListener('click', async () => {
  if (!activeSession) return;
  try {
    await api('POST', '/sessions/' + activeSession.id + '/end');
  } catch { /* ignore */ }
  clearInterval(sessionTimerInterval);
  activeSession = null;
  $('session-status').style.display = 'none';
  $('btn-start-session').style.display = '';
  $('btn-end-session').style.display = 'none';
  $('session-notes').disabled = true;
  await loadSessionHistory();
});

// ── Session notes autosave (debounced) ────────────────────────────────────────
$('session-notes').disabled = true;
$('session-notes').addEventListener('input', () => {
  if (!activeSession) return;
  clearTimeout(notesSaveTimeout);
  notesSaveTimeout = setTimeout(async () => {
    try {
      await api('PUT', '/sessions/' + activeSession.id + '/notes', { content: $('session-notes').value });
    } catch { /* ignore — will retry on next keystroke */ }
  }, 800);
});

async function loadSessionHistory() {
  const list = $('history-list');
  if (!list) return;
  try {
    const sessions = await api('GET', '/sessions/mine');
    list.innerHTML = '';
    if (!sessions.length) {
      list.innerHTML = '<div id="history-empty" class="history-empty">No sessions yet</div>';
      return;
    }
    sessions.slice(0, 5).forEach(s => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.textContent = `${s.name} — ${formatDate(s.startTime)}`;
      list.appendChild(item);
    });
  } catch { /* ignore */ }
}

$('btn-toggle-history').addEventListener('click', () => {
  const list = $('history-list');
  const btn = $('btn-toggle-history');
  const isHidden = list.style.display === 'none';
  list.style.display = isHidden ? '' : 'none';
  btn.textContent = isHidden ? 'Hide' : 'Show';
});

// Store epoch to database (fire-and-forget)
function storeEpochToSession(r) {
  if (!activeSession || !r) return;
  sessionEpochCounter++;
  const elapsedSeconds = sessionStartTimestamp
    ? (Date.now() - sessionStartTimestamp.getTime()) / 1000
    : null;

  const ch = r.chitta_bhumi || {};
  const sw = r.swara || {};
  const spectrum = r.eeg_spectrum || (r.band_powers && r.band_powers.relative) || {};
  const gunas = r.gunas || {};
  const flags = r.tattva_flags || [];
  const swaraSimple = (sw.state || '').split(' ')[0] || null;

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
      beta: spectrum.beta ?? null,
      gamma: spectrum.gamma ?? null,
    },
    gunas: {
      sattva: gunas.sattva ?? null,
      rajas: gunas.rajas ?? null,
      tamas: gunas.tamas ?? null,
      label: gunas.label || null,
    },
    tattvaFlags: flags || [],
    bloodOxygen: r.blood_oxygen != null ? r.blood_oxygen : null,
    heartRate: r.heart_rate != null ? r.heart_rate : null,
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
  const maxI = probs.indexOf(Math.max(...probs));
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
    swara: { state: swaraState, confidence: Math.abs(asym)>0.12 ? 'High' : 'Moderate', note: swaraNote },
    band_powers: { relative: bp },
    eeg_spectrum: bp,
    alpha_asymmetry: asym,
    tattva_flags: tattva,
    contemplative_depth: depth,
  };
}

// ── Demo mode ─────────────────────────────────────────────────────────────────
// All 5 Chitta Bhumis (v2 adds Mudha). Cycle through them in demo.
const DEMO_STATES = ['Kshipta','Vikshipta','Ekagra','Niruddha'];
const DEMO_SWARA = [
  'Ida (Parasympathetic / Lunar)',
  'Pingala (Sympathetic / Solar)',
  'Sushumna (Balanced / Central)',
];
// Band powers aligned with paper's exact EEG signatures (see data_generator.py)
// high_beta (18-30 Hz) is the PRIMARY Rajas marker — shown separately from low_beta.
const DEMO_BANDS = {
  Mudha:    { delta:0.44, theta:0.17, alpha:0.07, low_beta:0.15, high_beta:0.10, gamma:0.04, beta:0.25 },
  Kshipta:  { delta:0.09, theta:0.12, alpha:0.12, low_beta:0.22, high_beta:0.33, gamma:0.10, beta:0.55 },
  Vikshipta:{ delta:0.14, theta:0.17, alpha:0.26, low_beta:0.21, high_beta:0.14, gamma:0.08, beta:0.35 },
  Ekagra:   { delta:0.08, theta:0.29, alpha:0.37, low_beta:0.12, high_beta:0.07, gamma:0.07, beta:0.19 },
  Niruddha: { delta:0.05, theta:0.18, alpha:0.30, low_beta:0.10, high_beta:0.05, gamma:0.32, beta:0.15 },
};
// Approximate gunas from paper's specifications for each state (for demo accuracy)
const DEMO_GUNAS = {
  Mudha:    { sattva:0.20, rajas:0.15, tamas:0.65, label:'Tamasic',  note:'Tamas predominates — heaviness and dullness. Stimulating pranayama recommended.' },
  Kshipta:  { sattva:0.12, rajas:0.73, tamas:0.15, label:'Rajasic',  note:'Rajas predominates — high-beta desynchronization, prefrontal hyperarousal.' },
  Vikshipta:{ sattva:0.52, rajas:0.32, tamas:0.16, label:'Balanced', note:'The three Gunas are in relative equilibrium — a balanced, transitional state.' },
  Ekagra:   { sattva:0.78, rajas:0.12, tamas:0.10, label:'Sattvic',  note:'Sattva predominates — alpha synchrony and Fm-θ. Optimal for contemplative practice.' },
  Niruddha: { sattva:0.88, rajas:0.07, tamas:0.05, label:'Sattvic',  note:'Deep Sattva — global gamma coherence. Gunatita: beyond the three Gunas.' },
};

$('btn-demo').addEventListener('click', () => {
  if (mode === 'demo') {
    clearInterval(demoTimer); demoTimer = null;
    mode = 'idle'; setStatus('', 'disconnected');
    $('btn-demo').textContent = '▶ Demo';
    return;
  }
  if (mode === 'bluetooth') disconnectBluetooth();
  mode = 'demo';
  setStatus('demo', 'demo mode');
  $('btn-demo').textContent = '⏹ Stop Demo';

  const ALL_DEMO_STATES = ['Mudha','Kshipta','Vikshipta','Ekagra','Niruddha'];
  const runDemo = () => {
    demoEpoch++;
    const state = ALL_DEMO_STATES[demoStateIdx % ALL_DEMO_STATES.length];
    const swara = DEMO_SWARA[demoSwaraIdx % DEMO_SWARA.length];
    const bp = { ...DEMO_BANDS[state] };

    // Add realistic jitter to band powers
    Object.keys(bp).forEach(k => { bp[k] = Math.max(0.01, bp[k] + (Math.random()-0.5)*0.03); });

    const faa = swara.includes('Ida') ? -(0.15+Math.random()*0.25)
      : swara.includes('Pingala') ? (0.15+Math.random()*0.25)
      : (Math.random()-0.5)*0.10;
    const isIda = faa < -0.15, isPingala = faa > 0.15;

    // Build probabilities using paper's scoring logic (simplified)
    const rawScores = {
      Mudha:    Math.max(0, bp.delta - 0.30) * 3.0 + Math.max(0, 0.10 - bp.alpha) * 2.0,
      Kshipta:  Math.max(0, bp.high_beta - 0.15) * 4.0 + Math.max(0, 0.15 - bp.alpha) * 2.0,
      Vikshipta:Math.max(0, bp.alpha - 0.10) * 2.0 + 0.8,
      Ekagra:   Math.max(0, bp.theta - 0.20) * 3.0 + Math.max(0, bp.alpha - 0.25) * 3.0,
      Niruddha: Math.max(0, bp.gamma - 0.15) * 4.0,
    };
    const scoreTotal = Object.values(rawScores).reduce((a,b) => a+b, 1e-6);
    const probs = {};
    ALL_DEMO_STATES.forEach(s => { probs[s] = rawScores[s] / scoreTotal; });
    // Bias winner toward current state
    probs[state] = Math.max(probs[state], 0.45);
    const biasTotal = Object.values(probs).reduce((a,b) => a+b, 0);
    ALL_DEMO_STATES.forEach(s => { probs[s] /= biasTotal; });

    const tattva = [];
    if (bp.alpha > 0.35 && bp.high_beta < 0.10) tattva.push('Pratyahara Window');
    if (bp.theta  > 0.28) tattva.push('Fm-θ Activation (Frontal Midline Theta)');
    if (bp.gamma  > 0.15) tattva.push('Gamma Surge — Ajna/Sahasrara activation');
    if (bp.delta  > 0.40 && bp.alpha < 0.10) tattva.push('Tamasic State — Kapalabhati recommended');
    if (bp.high_beta > 0.30) tattva.push('High-Beta Agitation — Nadi Shodhana recommended');

    epoch++;
    const depth = CHITTA_DEPTHS[state];
    const gunas = { ...DEMO_GUNAS[state] };
    const swaraKey = isIda ? 'ida' : isPingala ? 'pingala' : 'sushumna';
    const r = {
      epoch, latency_ms: 18 + Math.random() * 8,
      data_quality: '✓ demo',
      chitta_bhumi: { state, depth, confidence: probs[state].toFixed(3), probabilities: probs },
      swara: {
        state:      swara,
        confidence: 'Moderate',
        note:       SWARA_NOTES[swaraKey],
      },
      band_powers:  { relative: bp },
      eeg_spectrum: bp,
      alpha_asymmetry: faa,
      tattva_flags: tattva,
      contemplative_depth: depth,
      gunas,
      blood_oxygen: +(96 + Math.random() * 3).toFixed(1),
      heart_rate:   Math.round(60 + Math.random() * 25),
    };
    applyReading(r);
    storeEpochToSession(r);
    if (demoEpoch % 3 === 0) demoStateIdx++;
    if (demoEpoch % 7 === 0) demoSwaraIdx++;
  };

  runDemo();
  demoTimer = setInterval(runDemo, DEMO_INTERVAL);
});

// ── Bluetooth mode ────────────────────────────────────────────────────────────
$('btn-bluetooth').addEventListener('click', () => {
  if (mode === 'bluetooth') {
    disconnectBluetooth();
  } else {
    connectBluetooth();
  }
});

async function connectBluetooth() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth is not available. Please use Chrome or Edge on desktop.');
    return;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [MUSE_SERVICE_UUID] }],
      optionalServices: [MUSE_SERVICE_UUID],
    });
    btDevice = device;
    device.addEventListener('gattserverdisconnected', onBtDisconnected);

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(MUSE_SERVICE_UUID);

    const controlChar = await service.getCharacteristic(MUSE_CONTROL_UUID).catch(() => null);
    if (controlChar) {
      // CRITICAL FIX: Muse protocol requires a 1-byte length prefix before every command.
      // Without the prefix the headband silently ignores the command and never streams EEG.
      function museCmd(s) {
        const payload = new TextEncoder().encode(s + '\n');
        const buf = new Uint8Array(payload.length + 1);
        buf[0] = payload.length; // length prefix byte — this is mandatory
        buf.set(payload, 1);
        return buf;
      }
      await controlChar.writeValue(museCmd('h'));    // halt any prior streaming
      await new Promise(r => setTimeout(r, 300));
      await controlChar.writeValue(museCmd('p21'));  // preset 21 = EEG mode
      await new Promise(r => setTimeout(r, 300));
      await controlChar.writeValue(museCmd('d'));    // start streaming
      await new Promise(r => setTimeout(r, 500));   // let stream initialise before subscribing
    }

    for (let c = 0; c < MUSE_EEG_UUIDS.length; c++) {
      const char = await service.getCharacteristic(MUSE_EEG_UUIDS[c]).catch(() => null);
      if (!char) continue;
      await char.startNotifications();
      const ch = c;
      char.addEventListener('characteristicvaluechanged', ev => onMuseEEG(ev, ch));
    }

    // Muse S PPG subscription for heart rate and SpO2
      for (const [key, uuid] of Object.entries(MUSE_PPG_UUIDS)) {
        const ppgChar = await service.getCharacteristic(uuid).catch(() => null);
        if (!ppgChar) continue;
        await ppgChar.startNotifications();
        ppgChar.addEventListener('characteristicvaluechanged', ev => onMusePPG(ev, key));
      }
      ppgBuf.ambient.length = 0; ppgBuf.ir.length = 0; ppgBuf.red.length = 0;
      latestHeartRate = null; latestSpO2 = null;

      btDisconnect = () => { if (device.gatt.connected) device.gatt.disconnect(); };

      // Stop backend URL polling — BT mode handles data directly
    if (backendPollTimer) { clearInterval(backendPollTimer); backendPollTimer = null; }
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
      setStatus('error', 'BT failed: ' + err.message);
    }
  }
}

function onMuseEEG(ev, ch) {
  const data = ev.target.value;
  const samples = [];
  // FIX: safe loop — ensures we always have 2 bytes to read (i and i+1)
  for (let i = 2; i + 1 < data.byteLength; i += 2) {
    // Convert raw int16 to microvolts (Muse scale: 0.48828125 µV/LSB)
    samples.push(data.getInt16(i, false) * 0.48828125e-6);
  }
  bleChannels[ch].push(...samples);
  bleSamTick += samples.length;

  const buf = Math.min(bleChannels[0].length, COLLECT_N);
  const bufEl = $('val-buffer');
  if (bufEl) bufEl.textContent = buf + ' / ' + COLLECT_N;

  if (bleChannels[0].length >= COLLECT_N) processBluetoothEEG();
}

async function processBluetoothEEG() {
  const snapshot = bleChannels.map(ch => {
    const s = ch.slice(-COLLECT_N);
    ch.length = 0;
    return s;
  });
  const bufEl = $('val-buffer');
  if (bufEl) bufEl.textContent = '0 / ' + COLLECT_N;
  blePhase++;
  const t0 = performance.now();

  if (backendUrl) {
    try {
      const res = await fetch(backendUrl.replace(/\/$/, '') + '/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            eeg_data: snapshot,
            sample_rate: SAMPLE_RATE,
            ...(latestSpO2 !== null     && { blood_oxygen: +latestSpO2.toFixed(1) }),
            ...(latestHeartRate !== null && { heart_rate:  +latestHeartRate.toFixed(1) }),
          }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || 'HTTP ' + res.status);
      }
      const data = await res.json();
      const latency = (performance.now() - t0).toFixed(1);
      epoch++;
      const r = {
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
          // Use backend note, fall back to our SWARA_NOTES lookup
          note: data.swara?.note || SWARA_NOTES[(data.swara?.state||'').toLowerCase().split(' ')[0]] || '',
        },
        // Backend may return tattva_flags or tattva; check both
        tattva_flags: data.tattva_flags || data.tattva || [],
        contemplative_depth: data.chitta_bhumi?.depth || data.depth || '—',
        // Use hemispheric asymmetry from backend if available
        alpha_asymmetry: data.hemispheric_asymmetry?.asymmetry ?? data.alpha_asymmetry ?? 0,
        // Backend returns eeg_spectrum or band_relative
        eeg_spectrum: data.eeg_spectrum || data.band_relative || null,
        gunas: data.gunas || null,
        blood_oxygen: data.blood_oxygen ?? null,
        heart_rate: data.heart_rate ?? null,
      };
      applyReading(r);
      storeEpochToSession(r);
      return;
    } catch (err) {
      console.warn('Backend /analyze failed, falling back to local FFT:', err.message);
    }
  }

  // Local FFT fallback
  const signal = snapshot[0] || [];
  if (signal.length < 64) return;
  const sz = Math.pow(2, Math.floor(Math.log2(signal.length)));
  const mags = fft(signal.slice(-sz));
  const bp = bandPowers(mags, SAMPLE_RATE, sz);
  const r = classifyLocal(bp);
  r.latency_ms = parseFloat((performance.now() - t0).toFixed(1));
  applyReading(r);
  storeEpochToSession(r);
}

function disconnectBluetooth() {
  if (btDisconnect) { btDisconnect(); btDisconnect = null; }
  btDevice = null;
  const btRow = $('bt-device-row');
  if (btRow) btRow.style.display = 'none';
  bleChannels.forEach(ch => { ch.length = 0; });
  ppgBuf.ambient.length = 0; ppgBuf.ir.length = 0; ppgBuf.red.length = 0;
  latestHeartRate = null; latestSpO2 = null;
  mode = 'idle';
  setStatus('', 'disconnected');
  $('btn-bluetooth').classList.remove('bt-active');
  const bufEl = $('val-buffer');
  if (bufEl) bufEl.textContent = '0 / ' + COLLECT_N;
}

function onBtDisconnected() {
  if (mode === 'bluetooth') disconnectBluetooth();
}

// ── Muse S PPG processing (heart rate + SpO2) ─────────────────────────────────
function onMusePPG(ev, channel) {
  const data = ev.target.value;
  // Muse PPG: 2-byte header + 6 samples × 3 bytes uint24 big-endian
  const buf = ppgBuf[channel];
  for (let i = 2; i + 2 < data.byteLength; i += 3) {
    buf.push((data.getUint8(i) << 16) | (data.getUint8(i + 1) << 8) | data.getUint8(i + 2));
  }
  if (buf.length > PPG_WINDOW_SAMPLES) buf.splice(0, buf.length - PPG_WINDOW_SAMPLES);

  if (channel === 'ir' && buf.length >= PPG_WINDOW_SAMPLES) {
    latestHeartRate = computeHeartRate(ppgBuf.ir);
    if (ppgBuf.red.length >= PPG_WINDOW_SAMPLES) latestSpO2 = computeSpO2(ppgBuf.ir, ppgBuf.red);
    const hrEl = $('val-hr'), spo2El = $('val-spo2');
    const hrSt = $('hr-status'), spo2St = $('spo2-status');
    if (hrEl && latestHeartRate != null) { hrEl.textContent = latestHeartRate.toFixed(0); if (hrSt) hrSt.textContent = 'live reading'; }
    if (spo2El && latestSpO2 != null)   { spo2El.textContent = latestSpO2.toFixed(1);   if (spo2St) spo2St.textContent = 'live reading'; }
  }
}

/** BPM from PPG IR via threshold peak detection */
function computeHeartRate(signal) {
  if (signal.length < 64) return null;
  const mean = signal.reduce((a, b) => a + b, 0) / signal.length;
  const ac = signal.map(v => v - mean);
  const std = Math.sqrt(ac.reduce((s, v) => s + v * v, 0) / ac.length);
  const thr = std * 0.5;
  // 0.28 s refractory → supports up to ~214 BPM (covers athletic/stress range)
  const minDist = Math.round(PPG_SAMPLE_RATE * 0.28);
  const peaks = []; let lastPeak = -minDist;
  for (let i = 1; i < ac.length - 1; i++) {
    if (ac[i] > thr && ac[i] > ac[i - 1] && ac[i] > ac[i + 1] && (i - lastPeak) >= minDist) {
      peaks.push(i); lastPeak = i;
    }
  }
  if (peaks.length < 2) return null;
  const rrs = peaks.slice(1).map((p, i) => p - peaks[i]);
  const meanRR = rrs.reduce((a, b) => a + b, 0) / rrs.length;
  const hr = (60 * PPG_SAMPLE_RATE) / meanRR;
  return (hr >= 30 && hr <= 200) ? hr : null;
}

/** SpO2 % from red/IR ratio-of-ratios: SpO2 ≈ 110 − 25 × R */
function computeSpO2(ir, red) {
  if (ir.length < 64 || red.length < 64) return null;
  const len = Math.min(ir.length, red.length);
  const irS = ir.slice(-len), redS = red.slice(-len);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const acRms = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
  const dcIr = mean(irS), dcRed = mean(redS);
  if (dcIr < 1 || dcRed < 1) return null;
  const acIr = acRms(irS), acRed = acRms(redS);
  if (acIr < 1 || acRed < 1) return null;
  const R = (acRed / dcRed) / (acIr / dcIr);
  return Math.min(100, Math.max(85, 110 - 25 * R));
}

// ── Backend URL mode ──────────────────────────────────────────────────────────
// Lightweight status ping that does NOT change mode (safe to call on login)
async function pingBackendStatus(url) {
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/status', { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      const boardEl = $('val-board');
      const modeEl = $('val-mode');
      if (boardEl) boardEl.textContent = 'Render backend';
      if (modeEl) modeEl.textContent = data.model_ready ? 'ready' : 'loading model…';
    }
  } catch {
    const boardEl = $('val-board');
    if (boardEl) boardEl.textContent = 'backend waking…';
  }
}

async function connectBackendUrl(url) {
  if (backendPollTimer) { clearInterval(backendPollTimer); backendPollTimer = null; }
  mode = 'backend';
  setStatus('waking', 'waking up…');
  const boardEl = $('val-board');
  const modeEl = $('val-mode');
  if (boardEl) boardEl.textContent = 'Render backend';
  if (modeEl) modeEl.textContent = 'BLE → Render';

  let attempts = 0;
  const MAX = 40;
  let modelConfirmedReady = false;

  const poll = async () => {
    attempts++;
    try {
      const res = await fetch(url.replace(/\/$/, '') + '/status', { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (data.model_ready) {
          modelConfirmedReady = true;
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
        modelConfirmedReady = true; // stop retrying
        clearInterval(backendPollTimer); backendPollTimer = null;
        setStatus('error', 'backend offline');
      }
    }
  };

  await poll();
  // Do not start interval if: BT connected during first poll, or model already confirmed ready
  if (mode !== 'backend' || modelConfirmedReady) return;
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
  const demoBtn = $('btn-demo');
  if (demoBtn) demoBtn.textContent = '▶ Demo';
}

// ── Canvas / waveform ─────────────────────────────────────────────────────────
function resizeCanvas() {
  const canvas = $('eeg-canvas');
  if (!canvas) return;
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
}

window.addEventListener('resize', resizeCanvas);

// ── Band colour table for wave visualization (yogic chakra associations) ─────
const BAND_VIZ = [
  { key: 'delta',    label: 'δ Delta',   color: '#4A6FA5' },  // Muladhara – deep blue
  { key: 'theta',    label: 'θ Theta',   color: '#7B5EA7' },  // Svadhisthana – purple
  { key: 'alpha',    label: 'α Alpha',   color: '#3DAA77' },  // Anahata – green
  { key: 'low_beta', label: 'β Low',     color: '#E8A838' },  // Manipura – amber
  { key: 'high_beta',label: 'β High',    color: '#E05030' },  // Kshipta – orange-red
  { key: 'gamma',    label: 'γ Gamma',   color: '#B03A8A' },  // Sahasrara – magenta
];

function drawWave() {
  const canvas = $('eeg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // ── Layout: top 52% = raw EEG trace, bottom 48% = band power bars ──────
  const waveH  = Math.floor(H * 0.52);
  const barAreaH = H - waveH;
  const barH   = Math.floor(barAreaH / BAND_VIZ.length);
  const labelW = 52; // px reserved for label on left

  // ── TOP: raw EEG trace ──────────────────────────────────────────────────
  if (mode === 'bluetooth' && bleSamTick > 0) {
    const ch0 = bleChannels[0];
    const len = Math.min(ch0.length, WAVE_LEN);
    if (len > 1) {
      ctx.beginPath();
      ctx.strokeStyle = 'var(--accent, #56A67A)';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < len; i++) {
        const x = (i / (len - 1)) * W;
        const v = ch0[ch0.length - len + i];
        const y = waveH / 2 - v * waveH * 400;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  } else {
    // Synthetic idle wave — composite of all active bands
    wavePhase += 0.04;
    const bp = lastBandPowers;
    ctx.beginPath();
    ctx.strokeStyle = 'var(--accent, #56A67A)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < WAVE_LEN; i++) {
      const x = (i / (WAVE_LEN - 1)) * W;
      const t = i * 0.1 + wavePhase;
      // Synthesise a wave whose frequency content matches the current band powers
      const y = waveH / 2
        + Math.sin(t * 0.35) * 12 * (bp.delta    || 0.15)   // delta ~low freq
        + Math.sin(t * 0.65) * 10 * (bp.theta    || 0.18)   // theta
        + Math.sin(t * 1.2)  * 14 * (bp.alpha    || 0.28)   // alpha
        + Math.sin(t * 2.2)  *  8 * (bp.low_beta || 0.18)   // low beta
        + Math.sin(t * 3.8)  *  5 * (bp.high_beta|| 0.13)   // high beta
        + Math.sin(t * 6.5)  *  3 * (bp.gamma    || 0.08);  // gamma
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ── Separator line ───────────────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, waveH); ctx.lineTo(W, waveH);
  ctx.stroke();

  // ── BOTTOM: frequency band power bars ────────────────────────────────────
  const bp = lastBandPowers;
  BAND_VIZ.forEach(({ key, label, color }, idx) => {
    const y = waveH + idx * barH;
    const power = bp[key] || 0;
    const fillW = Math.max(0, Math.min(1, power)) * (W - labelW);

    // Background track
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(labelW, y + 2, W - labelW, barH - 4);

    // Filled bar
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(labelW, y + 2, fillW, barH - 4);
    ctx.globalAlpha = 1.0;

    // Label (left)
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.max(9, Math.min(11, barH - 4))}px monospace`;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 2, y + barH / 2);

    // Percentage value (right, inside bar if room)
    const pct = Math.round(power * 100);
    const pctStr = pct + '%';
    ctx.fillStyle = '#ffffff';
    ctx.font = `${Math.max(8, Math.min(10, barH - 5))}px monospace`;
    const pctX = labelW + fillW - 28;
    if (pctX > labelW + 4) {
      ctx.fillText(pctStr, pctX, y + barH / 2);
    }
  });

  requestAnimationFrame(drawWave);
}

// ── Status indicator ──────────────────────────────────────────────────────────
function setStatus(cls, text) {
  const dot = $('status-dot');
  const lbl = $('status-text');
  if (dot) dot.className = 'status-dot' + (cls ? ' ' + cls : '');
  if (lbl) lbl.textContent = text;
}

// ── Apply reading to UI ───────────────────────────────────────────────────────
function applyReading(r) {
  // ── Epoch / quality / latency ──
  const epochEl = $('val-epoch');
  const qualEl = $('val-quality');
  const latEl = $('val-latency');
  if (epochEl) epochEl.textContent = r.epoch ?? epoch;
  if (qualEl) qualEl.textContent = r.data_quality || '—';
  if (latEl) latEl.textContent = r.latency_ms != null ? r.latency_ms.toFixed(1) : '—';

  // ── Chitta Bhumi ──
  const ch = r.chitta_bhumi || {};
  const state = ch.state || '—';
  const chittaEl = $('chitta-state');
  const chittaSubEl = $('chitta-sub');
  if (chittaEl) chittaEl.textContent = state;
  if (chittaSubEl) chittaSubEl.textContent = ch.depth || ch.confidence || '—';

  const depth = ch.depth || CHITTA_DEPTHS[state] || 'Surface';
  const depthPct = DEPTH_PCT[depth] ?? 12;
  const depthFill = $('depth-fill');
  const depthColor = state === 'Mudha'     ? '#4A3060'       // deep inertia — dark purple
    : state === 'Kshipta'   ? 'var(--kshipta)'
    : state === 'Vikshipta' ? 'var(--vikshipta)'
    : state === 'Ekagra'    ? 'var(--ekagra)' : 'var(--niruddha)';
  if (depthFill) {
    depthFill.style.width = depthPct + '%';
    depthFill.style.background = depthColor;
  }

  const confEl = $('val-confidence');
  const depthEl = $('val-depth');
  if (confEl) confEl.textContent = ch.confidence || '—';
  if (depthEl) depthEl.textContent = depth;

  const probs = ch.probabilities || {};
  // All 5 Chitta Bhumis (v2 adds Mudha)
  ['Mudha', 'Kshipta', 'Vikshipta', 'Ekagra', 'Niruddha'].forEach(s => {
    const raw = probs[s] ?? '0%';
    const pct = typeof raw === 'number' ? raw * 100 : parseFloat(raw);
    const key = s.toLowerCase();
    const el = $('prob-' + key);
    const bar = $('bar-' + key);
    if (el) el.textContent = isNaN(pct) ? raw : pct.toFixed(1) + '%';
    if (bar) bar.style.width = (isNaN(pct) ? parseFloat(raw) : pct) + '%';
  });

  // ── Swara ──
  const sw = r.swara || {};
  const sst = (sw.state || '').toLowerCase();
  const isIda = /ida/.test(sst);
  const isPingala = /pingala/.test(sst);
  const isSushumna = !isIda && !isPingala;

  const swaraNote = $('swara-note');
  const swaraConf = $('swara-confidence');
  if (swaraNote) swaraNote.textContent = sw.note || (isIda ? SWARA_NOTES.ida : isPingala ? SWARA_NOTES.pingala : SWARA_NOTES.sushumna);
  if (swaraConf) swaraConf.textContent = sw.confidence || '—';

  const glIda = $('glyph-ida');
  const glSus = $('glyph-sushumna');
  const glPin = $('glyph-pingala');
  if (glIda) glIda.className = 'swara-glyph' + (isIda ? ' active-ida' : '');
  if (glSus) glSus.className = 'swara-glyph' + (isSushumna ? ' active-sushumna' : '');
  if (glPin) glPin.className = 'swara-glyph' + (isPingala ? ' active-pingala' : '');

  const asym = r.alpha_asymmetry || 0;
  const clamped = Math.max(-0.5, Math.min(0.5, asym));
  const pct = (clamped / 0.5) * 50;
  const thumbL = (50 + pct) + '%';
  const fillBg = isIda ? 'var(--ida)' : isPingala ? 'var(--pingala)' : 'var(--sushumna)';
  const thumb = $('asym-thumb');
  const fillEl = $('asym-fill');
  if (thumb) { thumb.style.left = thumbL; thumb.style.background = fillBg; }
  if (fillEl) {
    if (pct > 0) {
      fillEl.style.left = '50%';
      fillEl.style.right = (100 - (50 + pct)) + '%';
      fillEl.style.background = fillBg;
    } else if (pct < 0) {
      fillEl.style.left = (50 + pct) + '%';
      fillEl.style.right = '50%';
      fillEl.style.background = fillBg;
    } else {
      fillEl.style.left = fillEl.style.right = '50%';
    }
  }

  // ── Spectral Band Powers ──
  const spectrum = r.eeg_spectrum || (r.band_powers && r.band_powers.relative) || {};
  // Show all 6 bands (high_beta and low_beta are new in v2; beta = combined fallback)
  const allBands = ['delta', 'theta', 'alpha', 'low_beta', 'high_beta', 'beta', 'gamma'];
  allBands.forEach(b => {
    const raw = spectrum[b] ?? null;
    const pctVal = raw != null ? Math.round(raw * 100) : null;
    const barEl = $('bar-' + b);
    const valEl = $('val-' + b);
    if (barEl) barEl.style.width = (pctVal ?? 0) + '%';
    if (valEl) valEl.textContent = pctVal != null ? pctVal + '%' : '—';
  });

  // Update band power state for canvas visualization
  lastBandPowers = {
    delta:    spectrum.delta     ?? lastBandPowers.delta,
    theta:    spectrum.theta     ?? lastBandPowers.theta,
    alpha:    spectrum.alpha     ?? lastBandPowers.alpha,
    low_beta: spectrum.low_beta  ?? (spectrum.beta != null ? spectrum.beta * 0.55 : lastBandPowers.low_beta),
    high_beta:spectrum.high_beta ?? (spectrum.beta != null ? spectrum.beta * 0.45 : lastBandPowers.high_beta),
    gamma:    spectrum.gamma     ?? lastBandPowers.gamma,
  };

  // ── Tattva flags ──
  const flags = r.tattva_flags || [];
  const tattvaEl = $('tattva-flags');
  if (tattvaEl) {
    tattvaEl.innerHTML = flags.length
      ? flags.map(f => `<span class="tattva-tag">${escHtml(f)}</span>`).join('')
      : '<span class="tattva-tag muted">None detected</span>';
  }

  // ── Trigunas ──
  const gunas = r.gunas || {};
  const gunaKeys = ['sattva', 'rajas', 'tamas'];
  gunaKeys.forEach(g => {
    const val = gunas[g] ?? null;
    const pctVal = val != null ? Math.round(val * 100) : null;
    const barEl = $('bar-' + g);
    const valEl = $('val-' + g);
    if (barEl) barEl.style.width = (pctVal ?? 0) + '%';
    if (valEl) valEl.textContent = pctVal != null ? pctVal + '%' : '—';
  });

  const gunaLabel = gunas.label || (gunas.sattva > gunas.rajas && gunas.sattva > gunas.tamas ? 'Sattvic'
    : gunas.rajas > gunas.tamas ? 'Rajasic' : gunas.tamas ? 'Tamasic' : '—');
  const gunaDominantEl = $('gunas-dominant');
  const gunaNoteEl = $('gunas-note');
  if (gunaDominantEl) gunaDominantEl.textContent = gunaLabel || '—';
  if (gunaNoteEl) {
    gunaNoteEl.textContent = gunaLabel === 'Sattvic' ? 'clarity & balance dominant'
      : gunaLabel === 'Rajasic' ? 'activity & passion dominant'
      : gunaLabel === 'Tamasic' ? 'inertia & heaviness dominant' : '';
  }

  // ── Blood oxygen / heart rate (if device supports) ──
  const spo2El = $('val-spo2');
  const hrEl = $('val-hr');
  const spo2StatusEl = $('spo2-status');
  const hrStatusEl = $('hr-status');
  if (spo2El) spo2El.textContent = r.blood_oxygen != null ? r.blood_oxygen.toFixed(1) : '—';
  if (hrEl) hrEl.textContent = r.heart_rate != null ? r.heart_rate.toFixed(0) : '—';
  if (spo2StatusEl) spo2StatusEl.textContent = r.blood_oxygen != null ? 'live reading' : 'awaiting signal';
  if (hrStatusEl) hrStatusEl.textContent = r.heart_rate != null ? 'live reading' : 'awaiting signal';
}

// ── Init ──────────────────────────────────────────────────────────────────────
checkAuth();
