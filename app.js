/* ════════════════════════════════════════════════════════════════════════════
   EEG DEV TESTING — app.js
   Modes: demo | bluetooth+backend | bluetooth-local | backend-url
   Auth:  Login → Session management → Admin dashboard
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const SAMPLE_RATE   = 256;
const COLLECT_SECS  = 2;
const COLLECT_N     = SAMPLE_RATE * COLLECT_SECS;
const WAVE_LEN      = 300;
const DEMO_INTERVAL = 1200;

const MUSE_SERVICE_UUID = '0000fe8d-0000-1000-8000-00805f9b34fb';
const MUSE_CONTROL_UUID = '273e0001-4c4d-454d-96be-f03bac821358';
const MUSE_EEG_UUIDS    = [
  '273e0003-4c4d-454d-96be-f03bac821358',
  '273e0004-4c4d-454d-96be-f03bac821358',
  '273e0005-4c4d-454d-96be-f03bac821358',
  '273e0006-4c4d-454d-96be-f03bac821358',
];

const DEPTH_PCT      = { Surface: 12, Emerging: 37, Deep: 62, Profound: 94 };
const CHITTA_DEPTHS  = { Kshipta: 'Surface', Vikshipta: 'Emerging', Ekagra: 'Deep', Niruddha: 'Profound' };
const SWARA_NOTES    = {
  ida:       'Parasympathetic dominance. Receptive, creative and introspective state.',
  pingala:   'Sympathetic dominance. Active, analytical and goal-directed focus.',
  sushumna:  'Equilibrium of solar and lunar channels. Gateway to higher contemplative states.',
};

// ── App state ─────────────────────────────────────────────────────────────────
let mode         = 'idle';
let backendUrl   = localStorage.getItem('controlhub_url') || 'https://eeg-backend-5.onrender.com';
let btDevice     = null;
let btDisconnect = null;
let demoTimer    = null;
let epoch        = 0;
let demoStateIdx = 0;
let demoSwaraIdx = 0;
let demoEpoch    = 0;
let pollTimer       = null;
let sseSource       = null;
let backendPollTimer = null;

// Auth state
let currentUser = null; // { id, username, role }

// Session state
let activeSession      = null; // { id, name, startTime }
let sessionTimerInterval = null;
let notesSaveTimeout   = null;

const bleChannels = [[], [], [], []];
let   blePhase    = 0;
let   bleSamTick  = 0;

const waveBuf  = new Float32Array(WAVE_LEN);
let   waveTail = 0;
let   wavePhase = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

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
}

function showMainApp() {
  $('login-screen').style.display = 'none';
  $('main-header').style.display  = '';
  $('main-content').style.display = '';

  // Update user menu
  $('user-avatar-initial').textContent = (currentUser.username[0] || '?').toUpperCase();
  $('user-display-name').textContent   = currentUser.username;
  $('user-menu-role').textContent      = currentUser.role;

  if (currentUser.role === 'admin') {
    $('btn-open-admin').style.display = '';
  } else {
    $('btn-open-admin').style.display = 'none';
  }

  // Start canvas
  resizeCanvas();
  requestAnimationFrame(drawWave);
  $('val-buffer').textContent = '0 / ' + COLLECT_N;

  if (backendUrl) {
    $('input-backend-url').value = backendUrl;
    connectBackendUrl(backendUrl);
  }

  // Load sessions
  loadSessionHistory();
}

// Login form
$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  const errEl    = $('login-error');
  const btn      = $('login-submit-btn');

  errEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    currentUser = await api('POST', '/auth/login', { username, password });
    showMainApp();
  } catch (err) {
    errEl.textContent   = err.message || 'Invalid credentials';
    errEl.style.display = '';
    btn.disabled = false;
    btn.textContent = 'Sign In';
    $('login-password').value = '';
  }
});

// Logout
$('btn-logout').addEventListener('click', async () => {
  closeUserMenu();
  stopAll();
  await api('POST', '/auth/logout').catch(() => {});
  currentUser = null;
  activeSession = null;
  clearInterval(sessionTimerInterval);
  showLoginScreen();
});

// ── USER MENU ─────────────────────────────────────────────────────────────────
$('btn-user-menu').addEventListener('click', () => {
  const dd = $('user-menu-dropdown');
  dd.style.display = dd.style.display === 'none' ? '' : 'none';
});

document.addEventListener('click', e => {
  if (!e.target.closest('.user-menu-wrap')) closeUserMenu();
});

function closeUserMenu() {
  $('user-menu-dropdown').style.display = 'none';
}

// ── SESSION MANAGEMENT ────────────────────────────────────────────────────────
$('btn-start-session').addEventListener('click', async () => {
  const name = $('session-name-input').value.trim();
  try {
    const session = await api('POST', '/sessions', { name });
    activeSession = { id: session.id, name: session.name, startTime: new Date(session.startTime) };
    onSessionStarted();
    await loadSessionHistory();
  } catch (err) {
    alert('Failed to start session: ' + err.message);
  }
});

$('btn-end-session').addEventListener('click', async () => {
  if (!activeSession) return;
  try {
    // Save notes first
    await saveNotes(true);
    await api('PUT', '/sessions/' + activeSession.id + '/end', {});
    onSessionEnded();
    await loadSessionHistory();
  } catch (err) {
    alert('Failed to end session: ' + err.message);
  }
});

function onSessionStarted() {
  $('session-start-area').style.display = 'none';
  $('session-active-area').style.display = '';
  $('session-notes-area').style.display = '';
  $('active-session-name').textContent = activeSession.name;
  $('session-notes-input').value = '';
  $('notes-save-status').textContent = '';
  $('session-name-input').value = '';
  startSessionTimer();
}

function onSessionEnded() {
  activeSession = null;
  clearInterval(sessionTimerInterval);
  $('session-start-area').style.display = '';
  $('session-active-area').style.display = 'none';
  $('session-notes-area').style.display = 'none';
  $('session-notes-input').value = '';
}

function startSessionTimer() {
  clearInterval(sessionTimerInterval);
  sessionTimerInterval = setInterval(() => {
    if (!activeSession) return;
    const elapsed = Math.floor((Date.now() - activeSession.startTime.getTime()) / 1000);
    const m = Math.floor(elapsed / 60), s = elapsed % 60;
    $('active-session-timer').textContent = m + ':' + String(s).padStart(2, '0');
  }, 1000);
}

// Notes autosave
$('session-notes-input').addEventListener('input', () => {
  $('notes-save-status').textContent = 'unsaved…';
  clearTimeout(notesSaveTimeout);
  notesSaveTimeout = setTimeout(() => saveNotes(false), 1500);
});

async function saveNotes(force) {
  if (!activeSession) return;
  const content = $('session-notes-input').value;
  try {
    await api('PUT', '/sessions/' + activeSession.id + '/notes', { content });
    if (!force) {
      $('notes-save-status').textContent = 'saved';
      setTimeout(() => { $('notes-save-status').textContent = ''; }, 2000);
    }
  } catch {
    $('notes-save-status').textContent = 'save failed';
  }
}

// Session history
let historyVisible = false;

$('btn-toggle-history').addEventListener('click', async () => {
  historyVisible = !historyVisible;
  $('session-history-list').style.display = historyVisible ? '' : 'none';
  $('btn-toggle-history').textContent = historyVisible ? 'Hide' : 'Show';
  if (historyVisible) await loadSessionHistory();
});

async function loadSessionHistory() {
  try {
    const sessions = await api('GET', '/sessions');
    renderSessionHistory(sessions);
  } catch {
    // silently fail if not authenticated yet
  }
}

function renderSessionHistory(sessions) {
  const list = $('session-history-list');
  const emptyEl = $('history-empty');

  // Remove all children except the empty message
  Array.from(list.children).forEach(el => {
    if (el !== emptyEl) el.remove();
  });

  if (!sessions || sessions.length === 0) {
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';

  sessions.forEach(s => {
    const isActive = activeSession && activeSession.id === s.id;
    const item = document.createElement('div');
    item.className = 'session-history-item' + (isActive ? ' active-session' : '');

    const dur = s.duration
      ? formatDuration(s.duration)
      : (isActive ? 'in progress' : '—');

    item.innerHTML = `
      <span class="session-history-name">${escHtml(s.name)}</span>
      <div class="session-history-meta">
        <span class="session-history-date">${formatDate(s.startTime)}</span>
        <span class="session-history-dur">${dur}</span>
      </div>
      <span class="session-history-status${s.endTime ? ' ended' : ''}">
        ${s.endTime ? 'ended' : 'active'}
      </span>
    `;

    list.appendChild(item);
  });
}

function formatDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── ADMIN DASHBOARD ───────────────────────────────────────────────────────────
$('btn-open-admin').addEventListener('click', () => {
  closeUserMenu();
  openAdmin();
});

$('btn-close-admin').addEventListener('click', closeAdmin);
$('admin-overlay').addEventListener('click', e => {
  if (e.target === $('admin-overlay')) closeAdmin();
});

function openAdmin() {
  $('admin-overlay').style.display = 'flex';
  loadAdminData('users');
}

function closeAdmin() {
  $('admin-overlay').style.display = 'none';
  $('reset-pwd-modal').style.display = 'none';
}

// Admin tabs
document.querySelectorAll('.admin-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.admin-tab-content').forEach(tc => tc.style.display = 'none');
    tab.classList.add('active');
    const target = tab.dataset.tab;
    $('admin-tab-' + target).style.display = '';
    loadAdminData(target);
  });
});

async function loadAdminData(tab) {
  if (tab === 'users') await loadAdminUsers();
  else if (tab === 'sessions') await loadAdminSessions();
  else if (tab === 'notes') await loadAdminNotes();
}

// ─ Users tab ─
$('btn-add-user').addEventListener('click', () => {
  $('admin-add-user-form').style.display = '';
  $('new-username').focus();
});
$('btn-cancel-add-user').addEventListener('click', () => {
  $('admin-add-user-form').style.display = 'none';
  $('add-user-msg').textContent = '';
});

$('btn-create-user').addEventListener('click', async () => {
  const username = $('new-username').value.trim();
  const password = $('new-password').value;
  const role     = $('new-role').value;
  const msgEl    = $('add-user-msg');

  if (!username || !password) {
    msgEl.className = 'admin-msg error';
    msgEl.textContent = 'Username and password are required.';
    return;
  }

  try {
    await api('POST', '/users', { username, password, role });
    msgEl.className = 'admin-msg success';
    msgEl.textContent = `User "${username}" created successfully.`;
    $('new-username').value = '';
    $('new-password').value = '';
    await loadAdminUsers();
  } catch (err) {
    msgEl.className = 'admin-msg error';
    msgEl.textContent = err.message;
  }
});

async function loadAdminUsers() {
  const tbody = $('users-tbody');
  tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted);font-style:italic">Loading…</td></tr>';
  try {
    const users = await api('GET', '/users');
    tbody.innerHTML = '';
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted);font-style:italic">No users found</td></tr>';
      return;
    }
    users.forEach(u => {
      const tr = document.createElement('tr');
      const isSelf = currentUser && u.id === currentUser.id;
      tr.innerHTML = `
        <td style="font-weight:600;color:var(--text)">${escHtml(u.username)}${isSelf ? ' <span style="font-size:10px;color:var(--text-muted)">(you)</span>' : ''}</td>
        <td><span class="admin-role-badge ${u.role}">${u.role}</span></td>
        <td style="font-size:12px">${formatDate(u.createdAt)}</td>
        <td>
          <div class="admin-actions-cell">
            <button class="admin-action-btn" data-action="reset-pwd" data-uid="${u.id}" data-uname="${escHtml(u.username)}">Reset Password</button>
            ${!isSelf ? `<button class="admin-action-btn danger" data-action="delete-user" data-uid="${u.id}" data-uname="${escHtml(u.username)}">Delete</button>` : ''}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:#A03A3A">${escHtml(err.message)}</td></tr>`;
  }
}

// User table action delegation
$('users-tbody').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const uid    = parseInt(btn.dataset.uid, 10);
  const uname  = btn.dataset.uname;

  if (action === 'reset-pwd') {
    openResetPwdModal(uid, uname);
  } else if (action === 'delete-user') {
    if (!confirm(`Delete user "${uname}"? This cannot be undone.`)) return;
    try {
      await api('DELETE', '/users/' + uid);
      await loadAdminUsers();
    } catch (err) {
      alert('Failed to delete user: ' + err.message);
    }
  }
});

let resetPwdTargetId = null;
function openResetPwdModal(uid, uname) {
  resetPwdTargetId = uid;
  $('reset-pwd-input').value = '';
  $('reset-pwd-modal').style.display = 'flex';
  $('reset-pwd-input').focus();
}
$('btn-cancel-reset-pwd').addEventListener('click', () => {
  $('reset-pwd-modal').style.display = 'none';
  resetPwdTargetId = null;
});
$('btn-confirm-reset-pwd').addEventListener('click', async () => {
  const pwd = $('reset-pwd-input').value;
  if (!pwd) { alert('Enter a new password.'); return; }
  try {
    await api('PUT', '/users/' + resetPwdTargetId + '/password', { password: pwd });
    $('reset-pwd-modal').style.display = 'none';
    resetPwdTargetId = null;
    alert('Password reset successfully.');
  } catch (err) {
    alert('Failed: ' + err.message);
  }
});

// ─ Sessions tab ─
$('admin-session-search').addEventListener('input', () => {
  const q = $('admin-session-search').value.toLowerCase();
  document.querySelectorAll('#admin-sessions-tbody tr').forEach(tr => {
    const user = tr.querySelector('[data-username]')?.dataset.username || '';
    tr.style.display = user.includes(q) ? '' : 'none';
  });
});

async function loadAdminSessions() {
  const tbody = $('admin-sessions-tbody');
  tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted);font-style:italic">Loading…</td></tr>';
  try {
    const sessions = await api('GET', '/sessions');
    tbody.innerHTML = '';
    if (!sessions.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted);font-style:italic">No sessions yet</td></tr>';
      return;
    }
    sessions.forEach(s => {
      const tr = document.createElement('tr');
      const notesPreview = '—'; // loaded separately
      tr.innerHTML = `
        <td data-username="${escHtml((s.username || '').toLowerCase())}">
          <span style="font-weight:600">${escHtml(s.username || '?')}</span>
        </td>
        <td>${escHtml(s.name)}</td>
        <td style="font-size:12px">${formatDate(s.startTime)}</td>
        <td style="font-size:12px">${s.duration ? formatDuration(s.duration) : (s.endTime ? '—' : '<span style="color:#56A67A;font-weight:600">active</span>')}</td>
        <td>
          <button class="admin-action-btn" data-action="view-notes" data-sid="${s.id}" data-sname="${escHtml(s.name)}">View Notes</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#A03A3A">${escHtml(err.message)}</td></tr>`;
  }
}

$('admin-sessions-tbody').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action="view-notes"]');
  if (!btn) return;
  const sid   = parseInt(btn.dataset.sid, 10);
  const sname = btn.dataset.sname;
  try {
    const note = await api('GET', '/sessions/' + sid + '/notes');
    alert(`Notes for "${sname}":\n\n${note.content || '(no notes recorded)'}`);
  } catch (err) {
    alert('Error: ' + err.message);
  }
});

// ─ Notes tab ─
async function loadAdminNotes() {
  const list = $('admin-notes-list');
  list.innerHTML = '<span class="tattva-empty">Loading…</span>';
  try {
    const grouped = await api('GET', '/admin/sessions/by-user');
    list.innerHTML = '';
    const entries = [];
    for (const [username, sessions] of Object.entries(grouped)) {
      for (const s of sessions) {
        entries.push({ username, session: s });
      }
    }
    if (!entries.length) {
      list.innerHTML = '<span class="tattva-empty">No sessions yet</span>';
      return;
    }
    // Load notes for all sessions
    for (const { username, session: s } of entries) {
      let noteContent = '';
      try {
        const note = await api('GET', '/sessions/' + s.id + '/notes');
        noteContent = note.content || '';
      } catch { /* ignore */ }

      const item = document.createElement('div');
      item.className = 'admin-note-item';
      item.innerHTML = `
        <div class="admin-note-header">
          <span class="admin-note-user">${escHtml(username)}</span>
          <span class="admin-note-session">${escHtml(s.name)}</span>
          <span class="admin-note-date">${formatDate(s.startTime)}</span>
        </div>
        ${noteContent
          ? `<div class="admin-note-content">${escHtml(noteContent)}</div>`
          : `<div class="admin-note-empty">no notes recorded</div>`
        }
      `;
      list.appendChild(item);
    }
  } catch (err) {
    list.innerHTML = `<span class="tattva-empty" style="color:#A03A3A">${escHtml(err.message)}</span>`;
  }
}

// ── Canvas / Waveform ─────────────────────────────────────────────────────────
function resizeCanvas() {
  const canvas = $('eeg-canvas');
  const ctx    = canvas.getContext('2d');
  const dpr    = window.devicePixelRatio || 1;
  const rect   = canvas.parentElement.getBoundingClientRect();
  canvas.width  = rect.width  * dpr;
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
  const statusPill  = $('status-pill');
  const statusLabel = $('status-label');
  statusPill.className = 'status-pill' + (cls ? ' ' + cls : '');
  statusLabel.textContent = label;
}

// ── UI Update ─────────────────────────────────────────────────────────────────
function applyReading(r, bp) {
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
  $('val-board').textContent       = r.board || (mode === 'bluetooth' ? (btDevice?.name || 'BLE device') : '—');
  $('val-mode').textContent        = mode === 'demo' ? 'synthetic demo' : mode === 'bluetooth' ? 'BLE → Render' : 'SSE / polling';

  const card = $('chitta-card');
  card.className = 'card chitta-card' + (state !== '—' ? ' state-' + state : '');
  $('chitta-fill').style.width = (DEPTH_PCT[depth] || 0) + '%';

  document.querySelectorAll('.chitta-depth-nodes span').forEach(el => {
    el.classList.toggle('active', el.dataset.s === state);
  });

  ['Kshipta', 'Vikshipta', 'Ekagra', 'Niruddha'].forEach(s => {
    const raw = probs[s];
    const pct = raw ? parseFloat(raw) : 0;
    $('prob-' + s).style.width    = pct + '%';
    $('probval-' + s).textContent = raw || '—';
  });

  const pill = $('depth-pill');
  pill.textContent = depth || '—';
  pill.className = 'depth-pill' + (depth ? ' ' + depth : '');

  let bands = null;
  if (bp) {
    bands = bp;
  } else if (r.band_powers?.relative) {
    bands = r.band_powers.relative;
  } else if (r.eeg_spectrum) {
    const sp  = r.eeg_spectrum;
    const tot = (sp.delta||0)+(sp.theta||0)+(sp.alpha||0)+(sp.beta||0)+(sp.gamma||0) || 1;
    bands = { delta: sp.delta/tot, theta: sp.theta/tot, alpha: sp.alpha/tot, beta: sp.beta/tot, gamma: sp.gamma/tot };
  }
  if (bands) {
    ['delta','theta','alpha','beta','gamma'].forEach(k => {
      const v = bands[k] || 0;
      $('band-' + k).style.height   = Math.round(v * 100) + '%';
      $('bandval-' + k).textContent = (v * 100).toFixed(1) + '%';
    });
    pushWaveFromBands(bands);
  }

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
    fillEl.style.left       = '50%';
    fillEl.style.right      = (100 - (50 + pct)) + '%';
    fillEl.style.background = fillBg;
  } else if (pct < 0) {
    fillEl.style.left       = (50 + pct) + '%';
    fillEl.style.right      = '50%';
    fillEl.style.background = fillBg;
  } else {
    fillEl.style.left = fillEl.style.right = '50%';
  }

  const flags    = r.tattva_flags || r.tattva || [];
  const flagsDiv = $('tattva-flags');
  flagsDiv.innerHTML = '';
  if (!flags.length) {
    flagsDiv.innerHTML = '<span class="tattva-empty">no flags active</span>';
  } else {
    flags.forEach(f => {
      const span = document.createElement('span');
      let cls = 'tattva-other';
      if (/tattva/i.test(f))       cls = 'tattva-activation';
      else if (/pratyahara/i.test(f)) cls = 'pratyahara';
      else if (/turiya/i.test(f))     cls = 'turiya';
      else if (/gamma/i.test(f))      cls = 'gamma-spike';
      span.className   = 'tattva-flag ' + cls;
      span.textContent = f;
      flagsDiv.appendChild(span);
    });
  }
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
  const probs  = softmax(logits);
  const maxI   = probs.indexOf(Math.max(...probs));
  const state  = states[maxI];
  const probMap = {};
  states.forEach((s,i) => { probMap[s] = (probs[i]*100).toFixed(1)+'%'; });

  const asym   = (Math.random()-0.5) * 0.3;
  const isIda  = asym < -0.04, isPingala = asym > 0.04;
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
  'Ida Nadi — right hemisphere dominant':    SWARA_NOTES.ida,
  'Pingala Nadi — left hemisphere dominant': SWARA_NOTES.pingala,
  'Sushumna — both nadis balanced':          SWARA_NOTES.sushumna,
};

function makeDemoReading() {
  demoEpoch++;
  const jitter = (v, range) => v + (Math.random()-0.5)*range;
  const state  = DEMO_STATES[demoStateIdx % DEMO_STATES.length];
  const base   = DEMO_BANDS[state];
  const bp     = {
    delta: jitter(base.delta, 0.04), theta: jitter(base.theta, 0.05),
    alpha: jitter(base.alpha, 0.06), beta:  jitter(base.beta,  0.05),
    gamma: jitter(base.gamma, 0.03),
  };
  const tot = Object.values(bp).reduce((a,b)=>a+b,0);
  Object.keys(bp).forEach(k => bp[k] = Math.max(0.01, bp[k]/tot));

  const depth  = CHITTA_DEPTHS[state];
  const conf   = (70 + Math.random()*20).toFixed(1) + '%';
  const probs  = {};
  DEMO_STATES.forEach(s => { probs[s] = s===state ? conf : (Math.random()*15).toFixed(1)+'%'; });

  const swaraState = DEMO_SWARA[demoSwaraIdx % DEMO_SWARA.length];
  const asym = swaraState.includes('Ida') ? -0.22 : swaraState.includes('Pingala') ? 0.22 : 0.01;

  const tattva = [];
  if (bp.alpha > 0.35) tattva.push('Pratyahara Window');
  if (bp.theta > 0.30) tattva.push('Potential Tattva Activation');

  if (demoEpoch % 8 === 0) demoStateIdx++;
  if (demoEpoch % 5 === 0) demoSwaraIdx++;

  return {
    epoch: demoEpoch, latency_ms: 15 + Math.random()*5,
    data_quality: '✓ synthetic', board: 'SimEEG-v2',
    chitta_bhumi: { state, depth, confidence: conf, probabilities: probs },
    swara: { state: swaraState, confidence: 'High', note: SWARA_NOTES_MAP[swaraState] || '' },
    band_powers: { relative: bp },
    alpha_asymmetry: asym,
    tattva_flags: tattva,
    contemplative_depth: depth,
  };
}

function startDemo() {
  stopAll();
  mode = 'demo';
  setStatus('demo', 'demo mode');
  const demoIconEl = $('demo-icon');
  $('btn-demo').classList.add('active');
  demoIconEl.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  demoTimer = setInterval(() => {
    const r = makeDemoReading();
    applyReading(r, r.band_powers.relative);
  }, DEMO_INTERVAL);
}

function stopDemo() {
  clearInterval(demoTimer); demoTimer = null;
  mode = 'idle';
  setStatus('', 'disconnected');
  $('btn-demo').classList.remove('active');
  $('demo-icon').innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
}

// ── Bluetooth ─────────────────────────────────────────────────────────────────
async function connectBluetooth() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth is not supported. Use Chrome or Edge.');
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
      const res  = await fetch(backendUrl.replace(/\/$/, '') + '/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eeg_data: snapshot, sample_rate: SAMPLE_RATE }),
        signal: AbortSignal.timeout(15000),
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
  const MAX = 40;

  const poll = async () => {
    attempts++;
    try {
      const res = await fetch(url.replace(/\/$/, '') + '/status', {
        signal: AbortSignal.timeout(5000),
      });
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
  const btnDemo = $('btn-demo');
  if (btnDemo) btnDemo.classList.remove('active');
  const demoIconEl = $('demo-icon');
  if (demoIconEl) demoIconEl.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
}

// ── Settings panel ────────────────────────────────────────────────────────────
$('btn-settings').addEventListener('click', () => {
  $('settings-overlay').classList.toggle('open');
});
$('btn-close-settings').addEventListener('click', () => {
  $('settings-overlay').classList.remove('open');
});
$('settings-overlay').addEventListener('click', e => {
  if (e.target === $('settings-overlay')) $('settings-overlay').classList.remove('open');
});

if (backendUrl) $('input-backend-url').value = backendUrl;

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

// ── Bluetooth panel ───────────────────────────────────────────────────────────
$('btn-bt-scan').addEventListener('click', async () => {
  $('settings-overlay').classList.remove('open');
  await connectBluetooth();
});
$('btn-bt-disconnect').addEventListener('click', disconnectBluetooth);

$('btn-bluetooth').addEventListener('click', async () => {
  if (mode === 'bluetooth') disconnectBluetooth();
  else await connectBluetooth();
});

$('btn-demo').addEventListener('click', () => {
  if (mode === 'demo') stopDemo();
  else startDemo();
});

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('resize', resizeCanvas);

// Start by checking auth — show login or main app accordingly
checkAuth();
