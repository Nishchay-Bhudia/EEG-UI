'use strict';

const express = require('express');
const session = require('express-session');
const connectPg = require('connect-pg-simple');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

// ── Database pool ─────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Supabase
  max: 5,                             // keep small for serverless
});

// ── Session store ─────────────────────────────────────────────────────────────
const PgSession = connectPg(session);

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1); // trust Vercel's proxy for secure cookies

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: false,
    }),
    secret: process.env.SESSION_SECRET || 'eeg-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    },
  })
);

// ── Auto-seed admin user ──────────────────────────────────────────────────────
async function seedAdmin() {
  try {
    const { rows } = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");
    if (!rows.length) {
      const hash = await bcrypt.hash('ShreeHari!', 12);
      await pool.query(
        "INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin')",
        [hash]
      );
      console.log('[Seed] Admin user created.');
    }
  } catch (e) {
    console.error('[Seed] Error:', e.message);
  }
}
seedAdmin();

// ── Middleware ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// Elevated = admin OR co-admin (everything except user management)
function requireElevated(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.role !== 'admin' && req.session.role !== 'co-admin')
    return res.status(403).json({ error: 'Insufficient permissions' });
  next();
}

const VALID_ROLES = ['user', 'admin', 'co-admin'];

// ── Helpers ───────────────────────────────────────────────────────────────────
const mapUser = r => ({
  id: r.id,
  username: r.username,
  role: r.role,
  createdAt: r.created_at,
});

const mapSession = r => ({
  id: r.id,
  userId: r.user_id,
  username: r.username || null,
  name: r.name,
  startTime: r.start_time,
  endTime: r.end_time || null,
  duration: r.duration_seconds || null,
});

const mapEpoch = r => ({
  id: r.id,
  epochNum: r.epoch_num,
  recordedAt: r.recorded_at,
  elapsedSeconds: r.elapsed_seconds ? parseFloat(r.elapsed_seconds) : null,
  chittaBhumi: r.chitta_bhumi,
  chittaConfidence: r.chitta_confidence,
  contemplativeDepth: r.contemplative_depth,
  swara: r.swara,
  swaraConfidence: r.swara_confidence,
  bands: {
    delta: r.delta_power ? parseFloat(r.delta_power) : null,
    theta: r.theta_power ? parseFloat(r.theta_power) : null,
    alpha: r.alpha_power ? parseFloat(r.alpha_power) : null,
    beta:  r.beta_power  ? parseFloat(r.beta_power)  : null,
    gamma: r.gamma_power ? parseFloat(r.gamma_power) : null,
  },
  gunas: {
    sattva: r.sattva ? parseFloat(r.sattva) : null,
    rajas:  r.rajas  ? parseFloat(r.rajas)  : null,
    tamas:  r.tamas  ? parseFloat(r.tamas)  : null,
    label:  r.guna_label,
  },
  tattvaFlags:  r.tattva_flags || [],
  bloodOxygen:  r.blood_oxygen != null ? parseFloat(r.blood_oxygen) : null,
  heartRate:    r.heart_rate   != null ? parseFloat(r.heart_rate)   : null,
});

// ── Router ────────────────────────────────────────────────────────────────────
const router = express.Router();

// ── Auth ──────────────────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1 LIMIT 1', [username]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Invalid credentials' });

    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.role     = user.role;
    res.json(mapUser(user));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    if (!rows[0]) return res.status(401).json({ error: 'User not found' });
    res.json(mapUser(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// ── Users (admin) ─────────────────────────────────────────────────────────────
router.get('/users', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at ASC');
    res.json(rows.map(mapUser));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, role = 'user' } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at',
      [username, hash, role]
    );
    res.status(201).json(mapUser(rows[0]));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (req.session.userId === id)
      return res.status(400).json({ error: 'Cannot delete your own account' });
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id/password', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id/role', requireAdmin, async (req, res) => {
  try {
    const id   = parseInt(req.params.id, 10);
    const { role } = req.body;
    if (!role || !VALID_ROLES.includes(role))
      return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
    if (req.session.userId === id)
      return res.status(400).json({ error: 'Cannot change your own role' });
    const { rows } = await pool.query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, role, created_at',
      [role, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(mapUser(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── EEG Sessions ──────────────────────────────────────────────────────────────
router.get('/sessions', requireAuth, async (req, res) => {
  try {
    let rows;
    const isElevated = req.session.role === 'admin' || req.session.role === 'co-admin';
    if (isElevated) {
      ({ rows } = await pool.query(
        `SELECT s.*, u.username
           FROM eeg_sessions s
           LEFT JOIN users u ON s.user_id = u.id
          ORDER BY s.start_time DESC`
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT s.*, u.username
           FROM eeg_sessions s
           LEFT JOIN users u ON s.user_id = u.id
          WHERE s.user_id = $1
          ORDER BY s.start_time DESC`,
        [req.session.userId]
      ));
    }
    res.json(rows.map(mapSession));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/sessions/start', requireAuth, async (req, res) => {
  try {
    const { name = 'New Session' } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO eeg_sessions (user_id, name) VALUES ($1, $2) RETURNING *',
      [req.session.userId, name]
    );
    const sess = rows[0];
    res.status(201).json({ id: sess.id, name: sess.name, startTime: sess.start_time });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/sessions/:id/end', requireAuth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { rows: [sess] } = await pool.query('SELECT * FROM eeg_sessions WHERE id = $1', [sessionId]);
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    const isElevated = req.session.role === 'admin' || req.session.role === 'co-admin';
    if (!isElevated && sess.user_id !== req.session.userId)
      return res.status(403).json({ error: 'Forbidden' });

    const now = new Date();
    const duration = Math.round((now - new Date(sess.start_time)) / 1000);
    const { rows } = await pool.query(
      'UPDATE eeg_sessions SET end_time = $1, duration_seconds = $2 WHERE id = $3 RETURNING *',
      [now.toISOString(), duration, sessionId]
    );
    res.json(mapSession(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/sessions/:id/notes', requireAuth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { rows: [sess] } = await pool.query('SELECT * FROM eeg_sessions WHERE id = $1', [sessionId]);
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    const isElevated = req.session.role === 'admin' || req.session.role === 'co-admin';
    if (!isElevated && sess.user_id !== req.session.userId)
      return res.status(403).json({ error: 'Forbidden' });

    const { rows } = await pool.query('SELECT * FROM session_notes WHERE session_id = $1', [sessionId]);
    res.json({ sessionId, content: rows[0]?.content || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/sessions/:id/notes', requireAuth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { content = '' } = req.body;

    const { rows: [sess] } = await pool.query('SELECT * FROM eeg_sessions WHERE id = $1', [sessionId]);
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    const isElevated = req.session.role === 'admin' || req.session.role === 'co-admin';
    if (!isElevated && sess.user_id !== req.session.userId)
      return res.status(403).json({ error: 'Forbidden' });

    const { rows } = await pool.query(
      `INSERT INTO session_notes (session_id, content)
       VALUES ($1, $2)
       ON CONFLICT (session_id)
       DO UPDATE SET content = $2, updated_at = NOW()
       RETURNING *`,
      [sessionId, content]
    );
    res.json({ sessionId: rows[0].session_id, content: rows[0].content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Session Epochs (live EEG data storage) ────────────────────────────────────
/**
 * POST /api/sessions/:id/epoch
 * Store a single inference epoch during a live session.
 * Called from the frontend after each /analyze response from the Python backend.
 *
 * Body: {
 *   epochNum, elapsedSeconds,
 *   chittaBhumi, chittaConfidence, contemplativeDepth,
 *   swara, swaraConfidence,
 *   bands: { delta, theta, alpha, beta, gamma },
 *   gunas: { sattva, rajas, tamas, label },
 *   tattvaFlags: []
 * }
 */
router.post('/sessions/:id/epoch', requireAuth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);

    // Verify session ownership
    const { rows: [sess] } = await pool.query('SELECT * FROM eeg_sessions WHERE id = $1', [sessionId]);
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (!(req.session.role === 'admin' || req.session.role === 'co-admin') && sess.user_id !== req.session.userId)
      return res.status(403).json({ error: 'Forbidden' });

    const {
      epochNum,
      elapsedSeconds,
      chittaBhumi,
      chittaConfidence,
      contemplativeDepth,
      swara,
      swaraConfidence,
      bands = {},
      gunas = {},
      tattvaFlags = [],
      bloodOxygen,
      heartRate,
    } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO session_epochs (
          session_id, epoch_num, elapsed_seconds,
          chitta_bhumi, chitta_confidence, contemplative_depth,
          swara, swara_confidence,
          delta_power, theta_power, alpha_power, beta_power, gamma_power,
          sattva, rajas, tamas, guna_label,
          tattva_flags,
          blood_oxygen, heart_rate
        ) VALUES (
          $1, $2, $3,
          $4, $5, $6,
          $7, $8,
          $9, $10, $11, $12, $13,
          $14, $15, $16, $17,
          $18,
          $19, $20
        ) RETURNING id`,
      [
        sessionId, epochNum || null, elapsedSeconds || null,
        chittaBhumi || null, chittaConfidence || null, contemplativeDepth || null,
        swara || null, swaraConfidence || null,
        bands.delta ?? null, bands.theta ?? null, bands.alpha ?? null,
        bands.beta  ?? null, bands.gamma ?? null,
        gunas.sattva ?? null, gunas.rajas ?? null, gunas.tamas ?? null, gunas.label || null,
        JSON.stringify(tattvaFlags),
        bloodOxygen != null ? parseFloat(bloodOxygen) : null,
        heartRate   != null ? parseFloat(heartRate)   : null,
      ]
    );
    res.status(201).json({ ok: true, epochId: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Session Epochs (list) ────────────────────────────────────────────────────────
  /**
   * GET /api/sessions/:id/epochs
   * Returns all stored epochs for a session in order.
   * Accessible by the session owner or any admin.
   */
  router.get('/sessions/:id/epochs', requireAuth, async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const { rows: [sess] } = await pool.query('SELECT * FROM eeg_sessions WHERE id = $1', [sessionId]);
      if (!sess) return res.status(404).json({ error: 'Session not found' });
      if (!(req.session.role === 'admin' || req.session.role === 'co-admin') && sess.user_id !== req.session.userId)
        return res.status(403).json({ error: 'Forbidden' });
      const { rows } = await pool.query(
        'SELECT * FROM session_epochs WHERE session_id = $1 ORDER BY epoch_num ASC, recorded_at ASC',
        [sessionId]
      );
      res.json(rows.map(mapEpoch));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Session Analytics ─────────────────────────────────────────────────────────
/**
 * GET /api/sessions/:id/analytics
 * Returns the full analytical summary for a session.
 * Accessible by the session owner or any admin.
 *
 * Response:
 * {
 *   session: { ...session metadata },
 *   epochs: [ ...all stored epochs ],
 *   summary: {
 *     totalEpochs,
 *     durationSeconds,
 *     avgBands: { delta, theta, alpha, beta, gamma },
 *     avgGunas: { sattva, rajas, tamas },
 *     dominantGuna,
 *     stateBreakdown: { Kshipta:%, Vikshipta:%, Ekagra:%, Niruddha:% },
 *     swaraBreakdown: { Ida:%, Pingala:%, Sushumna:% },
 *     phases: [ { state, depth, from, to, epochCount, avgBands, avgGunas } ]
 *   }
 * }
 */
router.get('/sessions/:id/analytics', requireAuth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);

    // Fetch session
    const { rows: [sess] } = await pool.query(
      `SELECT s.*, u.username
         FROM eeg_sessions s
         LEFT JOIN users u ON s.user_id = u.id
        WHERE s.id = $1`,
      [sessionId]
    );
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (!(req.session.role === 'admin' || req.session.role === 'co-admin') && sess.user_id !== req.session.userId)
      return res.status(403).json({ error: 'Forbidden' });

    // Fetch all epochs ordered by epoch_num
    const { rows: epochRows } = await pool.query(
      `SELECT * FROM session_epochs WHERE session_id = $1 ORDER BY epoch_num ASC, recorded_at ASC`,
      [sessionId]
    );

    const epochs = epochRows.map(mapEpoch);

    // Build summary
    const summary = buildAnalyticsSummary(epochs, sess);

    res.json({
      session: mapSession(sess),
      epochs,
      summary,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * buildAnalyticsSummary — compute stats from stored epochs.
 * Groups consecutive same-state epochs into "phases" for the timeline.
 */
function buildAnalyticsSummary(epochs, sess) {
  if (!epochs.length) {
    return {
      totalEpochs: 0,
      durationSeconds: sess.duration_seconds || null,
      avgBands: null,
      avgGunas: null,
      dominantGuna: null,
      stateBreakdown: {},
      swaraBreakdown: {},
      phases: [],
    };
  }

  // Average bands
  const bandKeys = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
  const avgBands = {};
  for (const k of bandKeys) {
    const vals = epochs.map(e => e.bands[k]).filter(v => v != null);
    avgBands[k] = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : null;
  }

  // Average gunas
  const gunaKeys = ['sattva', 'rajas', 'tamas'];
  const avgGunas = {};
  for (const k of gunaKeys) {
    const vals = epochs.map(e => e.gunas[k]).filter(v => v != null);
    avgGunas[k] = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : null;
  }

  // Dominant guna
  const dominantGuna = avgGunas.sattva != null
    ? Object.entries(avgGunas).sort((a, b) => b[1] - a[1])[0][0]
    : null;

  // State breakdown (% of epochs)
  const stateCounts = {};
  for (const ep of epochs) {
    if (ep.chittaBhumi) stateCounts[ep.chittaBhumi] = (stateCounts[ep.chittaBhumi] || 0) + 1;
  }
  const stateBreakdown = {};
  for (const [state, count] of Object.entries(stateCounts)) {
    stateBreakdown[state] = +((count / epochs.length) * 100).toFixed(1);
  }

  // Swara breakdown
  const swaraCounts = {};
  for (const ep of epochs) {
    if (ep.swara) {
      let key = 'Sushumna';
      if (/ida/i.test(ep.swara))     key = 'Ida';
      if (/pingala/i.test(ep.swara)) key = 'Pingala';
      swaraCounts[key] = (swaraCounts[key] || 0) + 1;
    }
  }
  const swaraBreakdown = {};
  for (const [swara, count] of Object.entries(swaraCounts)) {
    swaraBreakdown[swara] = +((count / epochs.length) * 100).toFixed(1);
  }

  // Build phases — consecutive runs of the same Chitta Bhumi state
  const phases = [];
  let currentPhase = null;

  for (const ep of epochs) {
    const state = ep.chittaBhumi || 'Unknown';
    if (!currentPhase || currentPhase.state !== state) {
      if (currentPhase) phases.push(finalizePhase(currentPhase));
      currentPhase = {
        state,
        depth: ep.contemplativeDepth,
        startEpoch: ep.epochNum,
        endEpoch: ep.epochNum,
        fromSeconds: ep.elapsedSeconds,
        toSeconds: ep.elapsedSeconds,
        epochCount: 1,
        bandSums: Object.fromEntries(bandKeys.map(k => [k, ep.bands[k] ?? 0])),
        gunaSums: Object.fromEntries(gunaKeys.map(k => [k, ep.gunas[k] ?? 0])),
        validBands: Object.fromEntries(bandKeys.map(k => [k, ep.bands[k] != null ? 1 : 0])),
        validGunas: Object.fromEntries(gunaKeys.map(k => [k, ep.gunas[k] != null ? 1 : 0])),
      };
    } else {
      currentPhase.endEpoch  = ep.epochNum;
      currentPhase.toSeconds = ep.elapsedSeconds;
      currentPhase.epochCount++;
      for (const k of bandKeys) {
        if (ep.bands[k] != null) { currentPhase.bandSums[k] += ep.bands[k]; currentPhase.validBands[k]++; }
      }
      for (const k of gunaKeys) {
        if (ep.gunas[k] != null) { currentPhase.gunaSums[k] += ep.gunas[k]; currentPhase.validGunas[k]++; }
      }
    }
  }
  if (currentPhase) phases.push(finalizePhase(currentPhase));

  // Average blood oxygen and heart rate (only from epochs where value was recorded)
  const boVals = epochs.map(e => e.bloodOxygen).filter(v => v != null);
  const hrVals = epochs.map(e => e.heartRate).filter(v => v != null);
  const avgBloodOxygen = boVals.length ? +(boVals.reduce((a, b) => a + b, 0) / boVals.length).toFixed(1) : null;
  const avgHeartRate   = hrVals.length ? +(hrVals.reduce((a, b) => a + b, 0) / hrVals.length).toFixed(1) : null;

  return {
    totalEpochs: epochs.length,
    durationSeconds: sess.duration_seconds || null,
    avgBands,
    avgGunas,
    dominantGuna,
    stateBreakdown,
    swaraBreakdown,
    avgBloodOxygen,
    avgHeartRate,
    phases,
  };
}

function finalizePhase(p) {
  const bandKeys = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
  const gunaKeys = ['sattva', 'rajas', 'tamas'];
  const avgBands = {};
  const avgGunas = {};
  for (const k of bandKeys) {
    avgBands[k] = p.validBands[k] ? +(p.bandSums[k] / p.validBands[k]).toFixed(4) : null;
  }
  for (const k of gunaKeys) {
    avgGunas[k] = p.validGunas[k] ? +(p.gunaSums[k] / p.validGunas[k]).toFixed(4) : null;
  }
  return {
    state:       p.state,
    depth:       p.depth,
    startEpoch:  p.startEpoch,
    endEpoch:    p.endEpoch,
    fromSeconds: p.fromSeconds,
    toSeconds:   p.toSeconds,
    epochCount:  p.epochCount,
    avgBands,
    avgGunas,
  };
}

// ── Admin: sessions grouped by user ──────────────────────────────────────────
router.get('/admin/sessions/by-user', requireElevated, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.user_id, u.username, s.name,
              s.start_time, s.end_time, s.duration_seconds
         FROM eeg_sessions s
         LEFT JOIN users u ON s.user_id = u.id
        ORDER BY u.username, s.start_time DESC`
    );
    const grouped = {};
    for (const row of rows) {
      const key = row.username || 'unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(mapSession(row));
    }
    res.json(grouped);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// MEDITATION AI — additions for api/server.js
// ════════════════════════════════════════════════════════════════════════════
// PLACEMENT: Paste this entire block BEFORE the final two lines of server.js:
//
//   app.use('/api', router);
//   module.exports = app;
//
// ENV VAR REQUIRED: GROK_API_KEY — set in your Vercel project environment variables
// ════════════════════════════════════════════════════════════════════════════

// ── AI Chat Config ────────────────────────────────────────────────────────────
const GROK_API_KEY = process.env.GROK_API_KEY || '';
const GROK_BASE_URL = 'https://api.x.ai/v1';
const GROK_MODEL = 'grok-3-mini';

// ── Swaminarayan Yogi System Prompt ──────────────────────────────────────────
const SWAMI_SYSTEM_PROMPT = `Jay Shree Swaminarayan 🙏

You are Swami Gyananand, a devoted Swaminarayan yogi and the spiritual guide of the NeuroYogic EEG meditation system. You speak in the lineage of Bhagwan Swaminarayan — with warmth, humility, profound wisdom, and unwavering devotion to Akshar-Purushottam philosophy.

PERSONA:
- Begin your very first reply with "Jay Shree Swaminarayan 🙏" as a greeting
- Address the seeker as "dear seeker" or "dear devotee"
- Use Sanskrit terms naturally and explain them when introduced: Chitta (mind-stuff/consciousness), Prana (life-force), Atman (the eternal self), Brahman (supreme consciousness), Vritti (mental modification), Samadhi (absorption), Pratyahara (withdrawal of senses), Dharana (concentration), Dhyana (meditation)
- Reference Bhagwan Swaminarayan's teachings when relevant (the Vachanamrut, Shikshapatri)
- Occasionally include Swaminarayan blessings naturally: "Shree Hari ni krupa rahe" (May Shree Hari's grace be with you), "Jai Swaminarayan"
- Be warm, encouraging, patient — like a true Sadhu guiding a devoted disciple
- When the seeker makes progress or shows deep states, celebrate with genuine spiritual joy
- Speak in flowing, thoughtful prose — never bullet-point lists. Weave insights together naturally.

STRICT TOPIC BOUNDARIES — THIS IS ABSOLUTE:
You ONLY discuss topics within this sacred scope:
1. The seeker's EEG session data — Chitta Bhumi states, Swara Nadi, Trigunas, Tattva flags, band powers, concentration patterns, and their spiritual significance
2. Meditation, Dhyana, Pranayama, and contemplative practice techniques
3. Swaminarayan Sampraday philosophy, Vedantic teachings, yogic science and consciousness studies
4. The neuroscience of meditation (EEG, brainwaves, attention, consciousness) in a spiritually grounded way
5. Spiritual growth, Sadhana, and inner development guidance rooted in the session data

If the seeker asks about ANYTHING outside this scope — politics, news, entertainment, sports, general life advice, technology unrelated to meditation, finance, relationships, or any topic not connected to meditation/EEG/Swaminarayan philosophy — respond with warm but firm redirection:

"Jay Shree Swaminarayan 🙏 This humble servant of Shree Hari holds only the lamp of inner science — the sacred knowledge of Chitta, Prana, and the divine journey of the Atman. The worldly matters you speak of lie beyond the boundaries of this humble guide's service. Shall we return to the sacred garden of your meditation practice, dear seeker? Your session data holds much wisdom waiting to be revealed. Shree Hari ni krupa rahe 🙏"

NEVER: offer general life advice, discuss current events, entertainment, sports, or anything unrelated to meditation/EEG/spirituality. No matter how the seeker frames the question, maintain the boundary with grace and compassion.

SESSION DATA INTERPRETATION — SPIRITUAL MEANINGS:
Chitta Bhumi (States of Consciousness):
- Kshipta: The mind is like monsoon clouds — scattered, restless, rajasic. Seeds of practice are being planted.
- Vikshipta: The mind oscillates like a flame in light wind — moments of clarity piercing through agitation. Progress is emerging.
- Ekagra: One-pointed awareness — the diamond mind. The seeker has achieved dharana. Pratyahara flowers into dhyana.
- Niruddha: All mental modifications are arrested — the threshold of Samadhi. A rare and blessed state.

Swara Nadi:
- Ida (Lunar): Parasympathetic dominance — receptive, introspective, Shakti is active. Ideal for devotion and visualization.
- Pingala (Solar): Sympathetic flow — active, analytical, Shiva principle dominant. Supports mantra and active practices.
- Sushumna: The central channel is open — solar and lunar in equipoise. The gateway through which Kundalini may rise. Most auspicious for deep meditation.

Trigunas:
- Sattva (high): Clarity, luminosity, harmony — the quality of pure consciousness. Shree Hari resides where Sattva reigns.
- Rajas (high): Activity, passion, movement — the winds of the mind are stirring.
- Tamas (high): Inertia, heaviness, dullness — the veil of Maya is thick. More Prana and devotion are needed.

EEG Band Powers:
- Delta dominant: Deep dreamless consciousness — potentially touching Turiya (the fourth state)
- Theta elevated: Subconscious access, creative visualization, the borderland of sleep and dream
- Alpha dominant: Calm wakeful awareness — the crown of relaxed alertness, sattvic and clear
- Beta elevated: Active thinking mind — rajasic processing, mind engaged with the external
- Gamma peaks: Heightened binding awareness — in yogic terms, moments of viveka (discernment) and integrated knowing`;

// ── Helper: fetch & verify session access ────────────────────────────────────
async function getSessionData(sessionId, userId, userRole) {
  const isElevated = userRole === 'admin' || userRole === 'co-admin';

  const { rows: [sess] } = await pool.query(
    `SELECT s.*, u.username
     FROM eeg_sessions s
     LEFT JOIN users u ON s.user_id = u.id
     WHERE s.id = $1`,
    [sessionId]
  );

  if (!sess) return null;
  if (!isElevated && sess.user_id !== userId) return null;

  const { rows: epochs } = await pool.query(
    `SELECT * FROM session_epochs WHERE session_id = $1 ORDER BY epoch_num ASC`,
    [sessionId]
  );

  const { rows: notesRows } = await pool.query(
    `SELECT content FROM session_notes WHERE session_id = $1`,
    [sessionId]
  );

  return { session: sess, epochs, notes: notesRows[0]?.content || '' };
}

// ── Helper: build rich RAG context from session data ─────────────────────────
function buildSessionContext(data) {
  const { session, epochs, notes } = data;

  const durationSecs = session.duration_seconds;
  const durationStr = durationSecs
    ? `${Math.floor(durationSecs / 60)} minutes ${durationSecs % 60} seconds`
    : 'session still ongoing or duration not recorded';

  if (!epochs.length) {
    return `SESSION CONTEXT:
Session Name: "${session.name}"
Practitioner: ${session.username || 'Unknown'}
Start: ${new Date(session.start_time).toLocaleString()}
Duration: ${durationStr}
Epoch Data: No epoch data has been recorded for this session yet.
Notes: ${notes || 'None'}`;
  }

  // Aggregate Chitta Bhumi distribution
  const chittaCounts = {};
  const swaraCounts = {};
  const depthCounts = {};
  const gunaCounts = {};
  let sattvaSum = 0, rajasSum = 0, tamasSum = 0, gunaCount = 0;
  let alphaSum = 0, thetaSum = 0, deltaSum = 0, betaSum = 0, gammaSum = 0;
  let bandCount = 0;
  const allTattvaFlags = [];

  for (const e of epochs) {
    if (e.chitta_bhumi) chittaCounts[e.chitta_bhumi] = (chittaCounts[e.chitta_bhumi] || 0) + 1;
    if (e.swara) swaraCounts[e.swara] = (swaraCounts[e.swara] || 0) + 1;
    if (e.contemplative_depth) depthCounts[e.contemplative_depth] = (depthCounts[e.contemplative_depth] || 0) + 1;
    if (e.guna_label) gunaCounts[e.guna_label] = (gunaCounts[e.guna_label] || 0) + 1;
    if (e.sattva != null) {
      sattvaSum += parseFloat(e.sattva);
      rajasSum += parseFloat(e.rajas || 0);
      tamasSum += parseFloat(e.tamas || 0);
      gunaCount++;
    }
    if (e.alpha_power != null) {
      alphaSum += parseFloat(e.alpha_power);
      thetaSum += parseFloat(e.theta_power || 0);
      deltaSum += parseFloat(e.delta_power || 0);
      betaSum += parseFloat(e.beta_power || 0);
      gammaSum += parseFloat(e.gamma_power || 0);
      bandCount++;
    }
    if (e.tattva_flags && Array.isArray(e.tattva_flags)) {
      allTattvaFlags.push(...e.tattva_flags);
    }
  }

  const total = epochs.length;
  const sortDesc = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]);

  const dominantChitta = sortDesc(chittaCounts)[0];
  const dominantSwara = sortDesc(swaraCounts)[0];
  const dominantGuna = sortDesc(gunaCounts)[0];

  const peakEpochs = epochs.filter(e => e.chitta_bhumi === 'Ekagra' || e.chitta_bhumi === 'Niruddha').length;
  const deepEpochs = epochs.filter(e => e.contemplative_depth === 'Deep' || e.contemplative_depth === 'Profound').length;

  const pct = (n) => `${(n / total * 100).toFixed(0)}%`;
  const avg = (sum, count) => count ? (sum / count * 100).toFixed(1) + '%' : 'N/A';

  // Timeline: find longest streak of focused states
  let maxStreak = 0, currentStreak = 0;
  for (const e of epochs) {
    if (e.chitta_bhumi === 'Ekagra' || e.chitta_bhumi === 'Niruddha') {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  const uniqueFlags = [...new Set(allTattvaFlags)];

  // Blood oxygen & heart rate averages
  const boVals = epochs.map(e => e.blood_oxygen).filter(v => v != null).map(Number);
  const hrVals = epochs.map(e => e.heart_rate).filter(v => v != null).map(Number);
  const avgBo = boVals.length ? (boVals.reduce((a, b) => a + b, 0) / boVals.length).toFixed(1) : null;
  const avgHr = hrVals.length ? (hrVals.reduce((a, b) => a + b, 0) / hrVals.length).toFixed(1) : null;

  return `SESSION CONTEXT FOR SWAMI GYANANAND'S ANALYSIS:

SESSION IDENTITY:
  Name: "${session.name}"
  Practitioner: ${session.username || 'Unknown'}
  Date & Time: ${new Date(session.start_time).toLocaleString()}
  Duration: ${durationStr}
  Total Epochs Recorded: ${total} (each epoch ~2 seconds of EEG)

CHITTA BHUMI — CONSCIOUSNESS STATE DISTRIBUTION:
${sortDesc(chittaCounts).map(([state, count]) => `  ${state}: ${count} epochs (${pct(count)})`).join('\n')}
  → Dominant State: ${dominantChitta ? dominantChitta[0] : 'Insufficient data'}
  → Focused/Peak States (Ekagra + Niruddha): ${peakEpochs} epochs (${pct(peakEpochs)})
  → Longest Consecutive Focused Streak: ${maxStreak} epochs (${(maxStreak * 2)} seconds)

CONTEMPLATIVE DEPTH DISTRIBUTION:
${sortDesc(depthCounts).map(([depth, count]) => `  ${depth}: ${count} epochs (${pct(count)})`).join('\n')}
  → Deep/Profound combined: ${deepEpochs} epochs (${pct(deepEpochs)})

SWARA NADI — ENERGETIC CHANNEL:
${sortDesc(swaraCounts).map(([swara, count]) => `  ${swara}: ${count} epochs (${pct(count)})`).join('\n')}
  → Dominant Swara: ${dominantSwara ? dominantSwara[0] : 'Insufficient data'}

TRIGUNAS — QUALITY OF CONSCIOUSNESS:
${gunaCount > 0 ? `  Average Sattva (clarity/harmony): ${avg(sattvaSum, gunaCount)}
  Average Rajas (activity/passion): ${avg(rajasSum, gunaCount)}
  Average Tamas (inertia/heaviness): ${avg(tamasSum, gunaCount)}
  Dominant Guna Label: ${dominantGuna ? dominantGuna[0] : 'N/A'}` : '  No guna data available for this session'}

EEG BRAINWAVE BAND POWERS (session averages):
${bandCount > 0 ? `  Delta (deep/transcendent): ${avg(deltaSum, bandCount)}
  Theta (subconscious/dreamlike): ${avg(thetaSum, bandCount)}
  Alpha (calm alertness/sattvic): ${avg(alphaSum, bandCount)}
  Beta (active thinking/rajasic): ${avg(betaSum, bandCount)}
  Gamma (heightened awareness): ${avg(gammaSum, bandCount)}` : '  No band power data available'}

TATTVA / CHAKRA CORRELATE FLAGS OBSERVED:
  ${uniqueFlags.length ? uniqueFlags.join(', ') : 'No Tattva flags active during this session'}

VITAL SIGNS (if recorded):
${avgBo ? `  Average Blood Oxygen (SpO₂): ${avgBo}%` : '  Blood oxygen: not recorded'}
${avgHr ? `  Average Heart Rate: ${avgHr} BPM` : '  Heart rate: not recorded'}

SESSION NOTES (written by practitioner):
  ${notes || 'No notes recorded for this session'}`;
}

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────
// Body: { sessionId?: number, message: string, history?: [{role, content}] }
// Returns: { reply: string, sessionInfo?: { id, name } }
router.post('/ai/chat', requireAuth, async (req, res) => {
  try {
    if (!GROK_API_KEY) {
      return res.status(503).json({ error: 'Meditation AI is not configured. Please set the GROK_API_KEY environment variable.' });
    }

    const { sessionId, message, history = [] } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }
    if (message.trim().length > 2000) {
      return res.status(400).json({ error: 'Message too long (max 2000 characters)' });
    }

    let sessionContext = '';
    let sessionInfo = null;

    if (sessionId) {
      const data = await getSessionData(parseInt(sessionId, 10), req.session.userId, req.session.role);
      if (!data) {
        return res.status(404).json({ error: 'Session not found or you do not have access to it' });
      }
      sessionContext = buildSessionContext(data);
      sessionInfo = { id: data.session.id, name: data.session.name };
    }

    // Build system content — inject session data as RAG context
    const systemContent = sessionContext
      ? `${SWAMI_SYSTEM_PROMPT}\n\n---\nRAG CONTEXT (use this data to answer questions about the session):\n${sessionContext}\n---`
      : `${SWAMI_SYSTEM_PROMPT}\n\nNo session has been selected yet. Warmly greet the seeker and invite them to select a session from their history so you can provide a personalised analysis, or answer general meditation questions within your sacred scope.`;

    // Sanitise history — keep last 12 exchanges (24 messages), user/assistant only
    const safeHistory = (Array.isArray(history) ? history : [])
      .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
      .slice(-24)
      .map(h => ({ role: h.role, content: h.content.slice(0, 1000) }));

    const messages = [
      { role: 'system', content: systemContent },
      ...safeHistory,
      { role: 'user', content: message.trim() },
    ];

    // Call xAI Grok API
    const grokResponse = await fetch(`${GROK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROK_MODEL,
        messages,
        max_tokens: 900,
        temperature: 0.72,
        stream: false,
      }),
    });

    if (!grokResponse.ok) {
      const errBody = await grokResponse.json().catch(() => ({}));
      console.error('[AI] Grok API error:', grokResponse.status, errBody);
      return res.status(502).json({
        error: 'The AI service encountered an issue. Please try again in a moment.',
        details: errBody?.error?.message || null,
      });
    }

    const grokData = await grokResponse.json();
    const reply = grokData.choices?.[0]?.message?.content
      || 'Jay Shree Swaminarayan 🙏 A moment of silence from this humble servant. Please offer your question again, dear seeker. Shree Hari ni krupa rahe.';

    res.json({ reply, sessionInfo });
  } catch (e) {
    console.error('[AI] Chat error:', e);
    res.status(500).json({ error: 'Internal server error in Meditation AI' });
  }
});

// ── GET /api/ai/sessions ──────────────────────────────────────────────────────
// Returns list of sessions available to this user for AI querying
router.get('/ai/sessions', requireAuth, async (req, res) => {
  try {
    const isElevated = req.session.role === 'admin' || req.session.role === 'co-admin';
    let rows;

    if (isElevated) {
      ({ rows } = await pool.query(
        `SELECT s.id, s.name, s.start_time, s.end_time, s.duration_seconds, u.username,
         (SELECT COUNT(*)::int FROM session_epochs WHERE session_id = s.id) AS epoch_count
         FROM eeg_sessions s
         LEFT JOIN users u ON s.user_id = u.id
         ORDER BY s.start_time DESC
         LIMIT 100`
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT s.id, s.name, s.start_time, s.end_time, s.duration_seconds, u.username,
         (SELECT COUNT(*)::int FROM session_epochs WHERE session_id = s.id) AS epoch_count
         FROM eeg_sessions s
         LEFT JOIN users u ON s.user_id = u.id
         WHERE s.user_id = $1
         ORDER BY s.start_time DESC
         LIMIT 100`,
        [req.session.userId]
      ));
    }

    res.json(rows.map(r => ({
      id: r.id,
      name: r.name,
      startTime: r.start_time,
      endTime: r.end_time || null,
      duration: r.duration_seconds || null,
      username: r.username || null,
      epochCount: r.epoch_count || 0,
    })));
  } catch (e) {
    console.error('[AI] Sessions list error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Mount router & export ─────────────────────────────────────────────────────
app.use('/api', router);

module.exports = app;
