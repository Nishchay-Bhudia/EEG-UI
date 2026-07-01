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

// ── EEG Sessions ──────────────────────────────────────────────────────────────
router.get('/sessions', requireAuth, async (req, res) => {
  try {
    let rows;
    if (req.session.role === 'admin') {
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
    if (req.session.role !== 'admin' && sess.user_id !== req.session.userId)
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
    if (req.session.role !== 'admin' && sess.user_id !== req.session.userId)
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
    if (req.session.role !== 'admin' && sess.user_id !== req.session.userId)
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
    if (req.session.role !== 'admin' && sess.user_id !== req.session.userId)
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
      if (req.session.role !== 'admin' && sess.user_id !== req.session.userId)
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
    if (req.session.role !== 'admin' && sess.user_id !== req.session.userId)
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
router.get('/admin/sessions/by-user', requireAdmin, async (_req, res) => {
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

// ── Mount router & export ─────────────────────────────────────────────────────
app.use('/api', router);

module.exports = app;
