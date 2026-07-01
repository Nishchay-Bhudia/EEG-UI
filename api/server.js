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
  max: 5, // keep small for serverless
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
    beta: r.beta_power ? parseFloat(r.beta_power) : null,
    gamma: r.gamma_power ? parseFloat(r.gamma_power) : null,
  },
  gunas: {
    sattva: r.sattva ? parseFloat(r.sattva) : null,
    rajas: r.rajas ? parseFloat(r.rajas) : null,
    tamas: r.tamas ? parseFloat(r.tamas) : null,
    label: r.guna_label,
  },
  tattvaFlags: r.tattva_flags || [],
  // ── Biometrics (null when headset has no PPG sensor) ─────────────────────
  heartRate: r.heart_rate ? parseFloat(r.heart_rate) : null,
  spo2: r.spo2 ? parseFloat(r.spo2) : null,
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

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
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
 *
 * Body: {
 *   epochNum, elapsedSeconds,
 *   chittaBhumi, chittaConfidence, contemplativeDepth,
 *   swara, swaraConfidence,
 *   bands: { delta, theta, alpha, beta, gamma },
 *   gunas: { sattva, rajas, tamas, label },
 *   tattvaFlags: [],
 *   heartRate: number | null,   ← new: BPM from PPG, null if unavailable
 *   spo2: number | null,        ← new: SpO2 %, null if unavailable
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
      heartRate = null,
      spo2 = null,
    } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO session_epochs (
         session_id, epoch_num, elapsed_seconds,
         chitta_bhumi, chitta_confidence, contemplative_depth,
         swara, swara_confidence,
         delta_power, theta_power, alpha_power, beta_power, gamma_power,
         sattva, rajas, tamas, guna_label,
         tattva_flags,
         heart_rate, spo2
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
        bands.beta ?? null, bands.gamma ?? null,
        gunas.sattva ?? null, gunas.rajas ?? null, gunas.tamas ?? null, gunas.label || null,
        JSON.stringify(tattvaFlags),
        heartRate ?? null,
        spo2 ?? null,
      ]
    );
    res.status(201).json({ ok: true, epochId: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Session Analytics ─────────────────────────────────────────────────────────
/**
 * GET /api/sessions/:id/analytics
 * Returns the full analytical summary for a session.
 */
router.get('/sessions/:id/analytics', requireAuth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);

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

    const { rows: epochs } = await pool.query(
      `SELECT * FROM session_epochs WHERE session_id = $1 ORDER BY epoch_num ASC`,
      [sessionId]
    );

    // ── Summary calculations ──────────────────────────────────────────────────
    const totalEpochs = epochs.length;

    // Chitta Bhumi state breakdown
    const stateBreakdown = {};
    const swaraBreakdown = {};
    let gunaSum = { sattva: 0, rajas: 0, tamas: 0, n: 0 };
    let bandSum = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, n: 0 };
    let hrSum = 0, hrCount = 0;
    let spo2Sum = 0, spo2Count = 0;

    for (const e of epochs) {
      // State
      if (e.chitta_bhumi) {
        stateBreakdown[e.chitta_bhumi] = (stateBreakdown[e.chitta_bhumi] || 0) + 1;
      }
      // Swara
      if (e.swara) {
        swaraBreakdown[e.swara] = (swaraBreakdown[e.swara] || 0) + 1;
      }
      // Gunas
      if (e.sattva != null) {
        gunaSum.sattva += parseFloat(e.sattva);
        gunaSum.rajas += parseFloat(e.rajas || 0);
        gunaSum.tamas += parseFloat(e.tamas || 0);
        gunaSum.n++;
      }
      // Bands
      if (e.alpha_power != null) {
        bandSum.delta += parseFloat(e.delta_power || 0);
        bandSum.theta += parseFloat(e.theta_power || 0);
        bandSum.alpha += parseFloat(e.alpha_power || 0);
        bandSum.beta += parseFloat(e.beta_power || 0);
        bandSum.gamma += parseFloat(e.gamma_power || 0);
        bandSum.n++;
      }
      // Biometrics
      if (e.heart_rate != null) {
        hrSum += parseFloat(e.heart_rate);
        hrCount++;
      }
      if (e.spo2 != null) {
        spo2Sum += parseFloat(e.spo2);
        spo2Count++;
      }
    }

    // Convert state/swara breakdown to percentages
    const toPercent = (obj, total) => {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = total > 0 ? parseFloat((v / total * 100).toFixed(1)) : 0;
      }
      return out;
    };

    const avgGunas = gunaSum.n > 0
      ? {
          sattva: parseFloat((gunaSum.sattva / gunaSum.n).toFixed(4)),
          rajas: parseFloat((gunaSum.rajas / gunaSum.n).toFixed(4)),
          tamas: parseFloat((gunaSum.tamas / gunaSum.n).toFixed(4)),
        }
      : null;

    const avgBands = bandSum.n > 0
      ? {
          delta: parseFloat((bandSum.delta / bandSum.n).toFixed(4)),
          theta: parseFloat((bandSum.theta / bandSum.n).toFixed(4)),
          alpha: parseFloat((bandSum.alpha / bandSum.n).toFixed(4)),
          beta: parseFloat((bandSum.beta / bandSum.n).toFixed(4)),
          gamma: parseFloat((bandSum.gamma / bandSum.n).toFixed(4)),
        }
      : null;

    // Dominant guna
    let dominantGuna = null;
    if (avgGunas) {
      const entries = Object.entries(avgGunas);
      dominantGuna = entries.sort((a, b) => b[1] - a[1])[0][0];
    }

    // Average biometrics — null if no PPG data was collected this session
    const avgHeartRate = hrCount > 0 ? parseFloat((hrSum / hrCount).toFixed(1)) : null;
    const avgSpo2 = spo2Count > 0 ? parseFloat((spo2Sum / spo2Count).toFixed(1)) : null;

    // Timeline: group consecutive epochs with the same Chitta Bhumi
    const phases = [];
    let currentPhase = null;
    for (const e of epochs) {
      const state = e.chitta_bhumi || 'Unknown';
      if (!currentPhase || currentPhase.state !== state) {
        if (currentPhase) phases.push(currentPhase);
        currentPhase = {
          state,
          depth: e.contemplative_depth || null,
          epochCount: 0,
          fromSeconds: e.elapsed_seconds ? parseFloat(e.elapsed_seconds) : null,
          toSeconds: null,
          avgGunas: { sattva: 0, rajas: 0, tamas: 0, n: 0 },
          avgBands: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0, n: 0 },
        };
      }
      currentPhase.epochCount++;
      currentPhase.toSeconds = e.elapsed_seconds ? parseFloat(e.elapsed_seconds) : null;
      if (e.sattva != null) {
        currentPhase.avgGunas.sattva += parseFloat(e.sattva);
        currentPhase.avgGunas.rajas += parseFloat(e.rajas || 0);
        currentPhase.avgGunas.tamas += parseFloat(e.tamas || 0);
        currentPhase.avgGunas.n++;
      }
      if (e.alpha_power != null) {
        currentPhase.avgBands.delta += parseFloat(e.delta_power || 0);
        currentPhase.avgBands.theta += parseFloat(e.theta_power || 0);
        currentPhase.avgBands.alpha += parseFloat(e.alpha_power || 0);
        currentPhase.avgBands.beta += parseFloat(e.beta_power || 0);
        currentPhase.avgBands.gamma += parseFloat(e.gamma_power || 0);
        currentPhase.avgBands.n++;
      }
    }
    if (currentPhase) phases.push(currentPhase);

    // Normalise phase averages
    for (const p of phases) {
      if (p.avgGunas.n > 0) {
        const n = p.avgGunas.n;
        p.avgGunas = {
          sattva: parseFloat((p.avgGunas.sattva / n).toFixed(4)),
          rajas: parseFloat((p.avgGunas.rajas / n).toFixed(4)),
          tamas: parseFloat((p.avgGunas.tamas / n).toFixed(4)),
        };
      } else {
        p.avgGunas = null;
      }
      if (p.avgBands.n > 0) {
        const n = p.avgBands.n;
        p.avgBands = {
          delta: parseFloat((p.avgBands.delta / n).toFixed(4)),
          theta: parseFloat((p.avgBands.theta / n).toFixed(4)),
          alpha: parseFloat((p.avgBands.alpha / n).toFixed(4)),
          beta: parseFloat((p.avgBands.beta / n).toFixed(4)),
          gamma: parseFloat((p.avgBands.gamma / n).toFixed(4)),
        };
      } else {
        p.avgBands = null;
      }
    }

    res.json({
      session: mapSession(sess),
      epochs: epochs.map(mapEpoch),
      summary: {
        totalEpochs,
        durationSeconds: sess.duration_seconds || null,
        stateBreakdown: toPercent(stateBreakdown, totalEpochs),
        swaraBreakdown: toPercent(swaraBreakdown, totalEpochs),
        avgGunas,
        avgBands,
        dominantGuna,
        phases,
        // ── Biometrics summary ──────────────────────────────────────────────
        avgHeartRate,   // null when headset has no PPG
        avgSpo2,        // null when headset has no PPG
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Mount router ──────────────────────────────────────────────────────────────
app.use('/api', router);

module.exports = app;
