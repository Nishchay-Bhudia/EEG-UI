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
  max: 5,
});

// ── Session store ─────────────────────────────────────────────────────────────
const PgSession = connectPg(session);

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1); // trust Vercel's proxy for secure cookies

// ── CORS — allow Vercel preview and production origins ───────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowedPatterns = [
    /\.vercel\.app$/,
    /localhost/,
  ];
  // Also allow any explicitly configured origins (comma-separated env var)
  const extraOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

  const isAllowed =
    !origin ||
    allowedPatterns.some(p => p.test(origin)) ||
    extraOrigins.includes(origin) ||
    extraOrigins.includes('*');

  // Only set CORS headers when the browser sends an Origin header.
  // Never pair Access-Control-Allow-Credentials: true with a wildcard origin.
  if (origin && isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);  // must be explicit, not '*'
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: true, // FIX: was false — sessions silently failed when table missing
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
// Reads the initial password from ADMIN_SEED_PASSWORD env var.
// Set this in Vercel / your .env. If the env var is missing the seed is skipped safely.
async function seedAdmin() {
  const seedPw = process.env.ADMIN_SEED_PASSWORD;
  if (!seedPw) {
    console.log('[Seed] ADMIN_SEED_PASSWORD not set — skipping admin seed.');
    return;
  }
  try {
    const { rows } = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");
    if (!rows.length) {
      const hash = await bcrypt.hash(seedPw, 12);
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
});

// ── Router ────────────────────────────────────────────────────────────────────
const router = express.Router();

// ── Auth ──────────────────────────────────────────────────────────────────────
router.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, username, role FROM users WHERE id = $1', [req.session.userId]);
    if (!rows.length) return res.status(401).json({ error: 'User not found' });
    res.json(mapUser(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 LIMIT 1', [username]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    req.session.userId = user.id;
    req.session.role = user.role;
    res.json(mapUser(user));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── Users (admin only) ────────────────────────────────────────────────────────
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
    if (!VALID_ROLES.includes(role))
      return res.status(400).json({ error: 'Invalid role' });

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
    const id = parseInt(req.params.id, 10);
    const { role } = req.body;
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (req.session.userId === id) return res.status(400).json({ error: 'Cannot change your own role' });
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sessions ──────────────────────────────────────────────────────────────────
router.get('/sessions', requireElevated, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.user_id, u.username, s.name,
              s.start_time, s.end_time, s.duration_seconds
       FROM eeg_sessions s
       LEFT JOIN users u ON s.user_id = u.id
       ORDER BY s.start_time DESC`
    );
    res.json(rows.map(mapSession));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/sessions/mine', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, name, start_time, end_time, duration_seconds
       FROM eeg_sessions WHERE user_id = $1 ORDER BY start_time DESC LIMIT 20`,
      [req.session.userId]
    );
    res.json(rows.map(r => mapSession({ ...r, username: null })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/sessions/start', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO eeg_sessions (user_id, name, start_time) VALUES ($1, $2, NOW()) RETURNING *',
      [req.session.userId, name || 'New Session']
    );
    res.status(201).json(mapSession(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/sessions/:id/end', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query(
      `UPDATE eeg_sessions
       SET end_time = NOW(),
           duration_seconds = EXTRACT(EPOCH FROM (NOW() - start_time))::int
       WHERE id = $1 AND user_id = $2`,
      [id, req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Epochs ────────────────────────────────────────────────────────────────────
router.post('/sessions/:id/epoch', requireAuth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const b = req.body;

    await pool.query(
      `INSERT INTO eeg_epochs (
         session_id, epoch_num, recorded_at, elapsed_seconds,
         chitta_bhumi, chitta_confidence, contemplative_depth,
         swara, swara_confidence,
         delta_power, theta_power, alpha_power, beta_power, gamma_power,
         sattva, rajas, tamas, guna_label,
         tattva_flags, blood_oxygen, heart_rate
       ) VALUES (
         $1, $2, NOW(), $3,
         $4, $5, $6,
         $7, $8,
         $9, $10, $11, $12, $13,
         $14, $15, $16, $17,
         $18, $19, $20
       )`,
      [
        sessionId, b.epochNum, b.elapsedSeconds,
        b.chittaBhumi, b.chittaConfidence, b.contemplativeDepth,
        b.swara, b.swaraConfidence,
        b.bands?.delta, b.bands?.theta, b.bands?.alpha, b.bands?.beta, b.bands?.gamma,
        b.gunas?.sattva, b.gunas?.rajas, b.gunas?.tamas, b.gunas?.label,
        JSON.stringify(b.tattvaFlags || []), b.bloodOxygen, b.heartRate,
      ]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/sessions/:id/epochs', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      'SELECT * FROM eeg_epochs WHERE session_id = $1 ORDER BY epoch_num ASC',
      [id]
    );
    res.json(rows.map(mapEpoch));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Analytics ─────────────────────────────────────────────────────────────────
router.get('/sessions/:id/analytics', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: epochs } = await pool.query(
      'SELECT * FROM eeg_epochs WHERE session_id = $1 ORDER BY epoch_num ASC',
      [id]
    );

    if (!epochs.length) {
      return res.json({ summary: { totalEpochs: 0 }, phases: [] });
    }

    // Summary
    const totalEpochs = epochs.length;
    const lastEpoch = epochs[epochs.length - 1];
    const durationSeconds = lastEpoch.elapsed_seconds ? Math.ceil(parseFloat(lastEpoch.elapsed_seconds)) : null;

    const stateCounts = {};
    let alphaSum = 0, thetaSum = 0, alphaCount = 0, thetaCount = 0;
    for (const ep of epochs) {
      if (ep.chitta_bhumi) stateCounts[ep.chitta_bhumi] = (stateCounts[ep.chitta_bhumi] || 0) + 1;
      if (ep.alpha_power) { alphaSum += parseFloat(ep.alpha_power); alphaCount++; }
      if (ep.theta_power) { thetaSum += parseFloat(ep.theta_power); thetaCount++; }
    }
    const dominantState = Object.entries(stateCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || null;

    // Phase compression
    const phases = [];
    let current = null;

    function finalizePhase(p) {
      const bandKeys = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
      const avgBands = {};
      for (const k of bandKeys) {
        avgBands[k] = p.validBands[k] ? +(p.bandSums[k] / p.validBands[k]).toFixed(4) : null;
      }
      return {
        state: p.state,
        depth: p.depth,
        startEpoch: p.startEpoch,
        endEpoch: p.endEpoch,
        fromSeconds: p.fromSeconds,
        toSeconds: p.toSeconds,
        epochCount: p.epochCount,
        avgBands,
      };
    }

    for (const ep of epochs) {
      const state = ep.chitta_bhumi || 'Unknown';
      const elapsed = ep.elapsed_seconds ? parseFloat(ep.elapsed_seconds) : null;
      if (!current || current.state !== state) {
        if (current) phases.push(finalizePhase(current));
        current = {
          state, depth: ep.contemplative_depth,
          startEpoch: ep.epoch_num, endEpoch: ep.epoch_num,
          fromSeconds: elapsed, toSeconds: elapsed,
          epochCount: 1,
          bandSums: { delta:0,theta:0,alpha:0,beta:0,gamma:0 },
          validBands: { delta:0,theta:0,alpha:0,beta:0,gamma:0 },
        };
      } else {
        current.endEpoch = ep.epoch_num;
        current.toSeconds = elapsed;
        current.epochCount++;
      }
      for (const k of ['delta','theta','alpha','beta','gamma']) {
        const v = ep[k+'_power'] ? parseFloat(ep[k+'_power']) : null;
        if (v != null) { current.bandSums[k] += v; current.validBands[k]++; }
      }
    }
    if (current) phases.push(finalizePhase(current));

    res.json({
      summary: {
        totalEpochs,
        durationSeconds,
        dominantState,
        stateCounts,
        avgAlpha: alphaCount ? alphaSum / alphaCount : null,
        avgTheta: thetaCount ? thetaSum / thetaCount : null,
      },
      phases,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// ── Mount router & export ─────────────────────────────────────────────────────
app.use('/api', router);

module.exports = app;
