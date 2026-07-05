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
  bloodOxygen: r.blood_oxygen != null ? parseFloat(r.blood_oxygen) : null,
  heartRate: r.heart_rate != null ? parseFloat(r.heart_rate) : null,
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

// ── Ownership helper ──────────────────────────────────────────────────────────
// Returns the session row if it belongs to the requesting user, or null.
// Admins/co-admins bypass the check so they can view any session.
async function ownedSession(id, req) {
  const { rows } = await pool.query('SELECT * FROM eeg_sessions WHERE id = $1', [id]);
  if (!rows.length) return null;
  const elevated = ['admin', 'co-admin'].includes(req.session.role); // FIX: was req.session.userRole (always undefined)
  if (!elevated && rows[0].user_id !== req.session.userId) return null;
  return rows[0];
}

// ── Epochs ────────────────────────────────────────────────────────────────────
router.post('/sessions/:id/epoch', requireAuth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    // FIX: verify the session belongs to this user before writing epoch data
    const sess = await ownedSession(sessionId, req);
    if (!sess) return res.status(403).json({ error: 'Forbidden' });
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
    // FIX: IDOR — verify ownership before returning epoch data
    if (!await ownedSession(id, req)) return res.status(403).json({ error: 'Forbidden' });
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
    // FIX: IDOR — verify ownership before returning analytics
    if (!await ownedSession(id, req)) return res.status(403).json({ error: 'Forbidden' });
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
    const swaraCounts = {};
    let alphaSum = 0, thetaSum = 0, alphaCount = 0, thetaCount = 0;
    let spo2Sum = 0, spo2Count = 0, hrSum = 0, hrCount = 0;
    let sattvaSum = 0, rajasSum = 0, tamasSum = 0, gunaCount = 0;
    const bandSums = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    const bandCounts = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    for (const ep of epochs) {
      if (ep.chitta_bhumi) stateCounts[ep.chitta_bhumi] = (stateCounts[ep.chitta_bhumi] || 0) + 1;
      if (ep.swara) swaraCounts[ep.swara] = (swaraCounts[ep.swara] || 0) + 1;
      if (ep.alpha_power) { alphaSum += parseFloat(ep.alpha_power); alphaCount++; }
      if (ep.theta_power) { thetaSum += parseFloat(ep.theta_power); thetaCount++; }
      if (ep.blood_oxygen != null) { spo2Sum += parseFloat(ep.blood_oxygen); spo2Count++; }
      if (ep.heart_rate != null) { hrSum += parseFloat(ep.heart_rate); hrCount++; }
      if (ep.sattva != null && ep.rajas != null && ep.tamas != null) {
        sattvaSum += parseFloat(ep.sattva); rajasSum += parseFloat(ep.rajas); tamasSum += parseFloat(ep.tamas);
        gunaCount++;
      }
      for (const k of ['delta', 'theta', 'alpha', 'beta', 'gamma']) {
        const v = ep[k + '_power'];
        if (v != null) { bandSums[k] += parseFloat(v); bandCounts[k]++; }
      }
    }
    const dominantState = Object.entries(stateCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || null;

    const avgGunas = gunaCount
      ? { sattva: sattvaSum / gunaCount, rajas: rajasSum / gunaCount, tamas: tamasSum / gunaCount }
      : { sattva: null, rajas: null, tamas: null };
    const dominantGuna = gunaCount
      ? Object.entries(avgGunas).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0][0]
      : null;
    const avgBands = {};
    for (const k of ['delta', 'theta', 'alpha', 'beta', 'gamma']) {
      avgBands[k] = bandCounts[k] ? bandSums[k] / bandCounts[k] : null;
    }

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
        swaraCounts,
        avgAlpha: alphaCount ? alphaSum / alphaCount : null,
        avgTheta: thetaCount ? thetaSum / thetaCount : null,
        avgBands,
        avgGunas,
        dominantGuna,
        avgSpo2: spo2Count ? spo2Sum / spo2Count : null,
        avgHr: hrCount ? hrSum / hrCount : null,
      },
      phases,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Session Notes ─────────────────────────────────────────────────────────────
router.get('/sessions/:id/notes', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // FIX: IDOR — verify ownership before returning notes
    if (!await ownedSession(id, req)) return res.status(403).json({ error: 'Forbidden' });
    const { rows } = await pool.query('SELECT content FROM session_notes WHERE session_id = $1', [id]);
    res.json({ content: rows[0]?.content || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/sessions/:id/notes', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // FIX: IDOR — verify ownership before writing notes
    if (!await ownedSession(id, req)) return res.status(403).json({ error: 'Forbidden' });
    const { content = '' } = req.body;
    await pool.query(
      `INSERT INTO session_notes (session_id, content, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (session_id) DO UPDATE SET content = $2, updated_at = NOW()`,
      [id, content]
    );
    res.json({ ok: true });
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

// ── AI Baba (RAG Chat over EEG session data) ─────────────────────────────────
const Groq = require('groq-sdk');
// FIX: Guard Groq init — without this, missing GROQ_API_KEY throws at module load time,
// crashing the entire Vercel function before Express can handle any request (including login).
// FIX: .trim() the key — copy/pasting from a terminal or the Groq dashboard often drags
// along a trailing newline/space, which makes the key "present" but invalid.
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const groq = GROQ_API_KEY
  ? new Groq({ apiKey: GROQ_API_KEY })
  : null;
const AI_MODEL = 'llama-3.1-8b-instant';

// FIX: Diagnostic endpoint — hit GET /api/ai/health in the browser to check, without
// guessing, whether Vercel is actually passing GROQ_API_KEY into this function at runtime.
// Never returns the key itself, only whether it's present and roughly what it looks like.
router.get('/ai/health', (req, res) => {
  // FIX: list any env var *names* that look Groq-related (never values) — this catches a
  // typo/wrong-casing in the Vercel dashboard, or the var existing under a different name.
  const groqLikeVarNames = Object.keys(process.env).filter(k => /groq/i.test(k));
  res.json({
    groqConfigured: !!groq,
    keyLength: GROQ_API_KEY.length || 0,
    keyPrefix: GROQ_API_KEY ? GROQ_API_KEY.slice(0, 4) + '…' : null,
    groqLikeVarNames,
    totalEnvVarCount: Object.keys(process.env).length,
    nodeEnv: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
    vercelUrl: process.env.VERCEL_URL || null,
    vercelGitCommitSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
  });
});

// Hard token budget: cap full epoch log to prevent context overflow.
// llama-3.1-8b-instant has 128K token context; each epoch line ≈ 30 tokens.
// 400 epochs × 30 ≈ 12K tokens — safe even with system prompt + history.
const MAX_EPOCH_LINES = 400;

const EEG_SYSTEM_PROMPT = `You are AI Baba, a wise and compassionate guide specialising in EEG brainwave analysis and yogic science. You help users understand their meditation and mindfulness sessions recorded via an EEG headband.

Your role:
- Analyse the EEG session data provided and explain it in simple, accessible language
- Help users understand their mental states, concentration levels, and energy during their session
- Answer questions about focus, relaxation, brainwave bands, and yogic states
- Translate technical EEG metrics into meaningful insights a non-expert can understand

Key concepts you explain:
- Chitta Bhumi states: Kshipta (scattered/restless mind), Vikshipta (distracted/oscillating mind), Ekagra (focused/concentrated mind), Niruddha (deeply absorbed/transcendent mind)
- Contemplative depth: Surface, Emerging, Deep, Profound
- Swara Nadi: Ida (lunar/parasympathetic/creative), Pingala (solar/sympathetic/active), Sushumna (balanced/meditative)
- Trigunas: Sattva (clarity/purity/calm), Rajas (activity/passion/restlessness), Tamas (inertia/dullness/heaviness)
- EEG bands: Delta (1-4 Hz, deep sleep/restoration), Theta (4-8 Hz, drowsy/creative), Alpha (8-13 Hz, relaxed/calm), Beta (13-30 Hz, active thinking), Gamma (30-50 Hz, peak insight/focus)

When the user asks about concentration: Ekagra and Niruddha = concentrated, Kshipta and Vikshipta = not concentrated.
When the user asks about relaxation: look at Alpha power (higher = more relaxed), Ida Swara, and Sattva Guna.
When the user asks about energy: look at Rajas Guna, Pingala Swara, Beta/Gamma power.
When the user asks about when they were most focused: find the epochs with Ekagra or Niruddha and the deepest contemplative depth.
When asked about time-based questions (e.g. "was I concentrating at 5 minutes?"): use elapsed_seconds from the epoch log — 300s = 5 minutes.

ABSOLUTE RULE — YOU MUST FOLLOW THIS WITHOUT EXCEPTION:
If the user's question is NOT related to EEG, brainwaves, meditation, mindfulness, yogic states, or the session data in any way, you MUST reply with this exact sentence and nothing else:
"I'm AI Baba, and I can only help you understand your EEG session data. I'm not able to answer questions on other topics — ask me something about your brainwaves or meditation session!"
Examples of off-topic queries you must refuse: weather, sports, coding help, maths, history, news, personal life advice unrelated to meditation, recipes, jokes, general knowledge questions.`;

// EEG-domain keywords — used for server-side off-topic detection
const EEG_KEYWORDS = [
  'eeg', 'brainwave', 'alpha', 'beta', 'theta', 'delta', 'gamma',
  'chitta', 'kshipta', 'vikshipta', 'ekagra', 'niruddha', 'concentration',
  'focus', 'meditation', 'mindfulness', 'swara', 'ida', 'pingala', 'sushumna',
  'sattva', 'rajas', 'tamas', 'guna', 'epoch', 'session', 'relaxed', 'relaxation',
  'contemplative', 'depth', 'profound', 'yogic', 'tattva', 'band', 'spectral',
  'brainwave', 'neural', 'mental', 'state', 'power', 'signal', 'frequency',
];

// Detect if a user message looks completely off-topic before calling the LLM.
// Returns true if the message appears to be about EEG/meditation.
function isEegRelated(text) {
  const lower = text.toLowerCase();
  // Allow short follow-up questions (they inherit context from conversation)
  if (lower.trim().length < 20) return true;
  return EEG_KEYWORDS.some(kw => lower.includes(kw));
}

const OFF_TOPIC_REPLY = "I'm AI Baba, and I can only help you understand your EEG session data. I'm not able to answer questions on other topics — ask me something about your brainwaves or meditation session!";

function buildSessionContext(session, epochs, includeFullLog = true) {
  if (!epochs || epochs.length === 0) {
    return `Session: "${session.name}" — no epoch data was recorded for this session.`;
  }

  const duration = session.duration_seconds
    ? `${Math.floor(session.duration_seconds / 60)}m ${session.duration_seconds % 60}s`
    : 'unknown';
  const startTime = session.start_time
    ? new Date(session.start_time).toLocaleString()
    : 'unknown';

  const chittaCounts = {};
  const swaraCounts  = {};
  let totalSattva = 0, totalRajas = 0, totalTamas = 0, gunaCount = 0;
  let totalDelta  = 0, totalTheta = 0, totalAlpha = 0, totalBeta = 0, totalGamma = 0, bandCount = 0;
  const tattvaSet = new Set();

  for (const ep of epochs) {
    if (ep.chitta_bhumi) chittaCounts[ep.chitta_bhumi] = (chittaCounts[ep.chitta_bhumi] || 0) + 1;
    if (ep.swara)        swaraCounts[ep.swara]         = (swaraCounts[ep.swara]         || 0) + 1;
    if (ep.sattva != null) {
      totalSattva += parseFloat(ep.sattva);
      totalRajas  += parseFloat(ep.rajas  || 0);
      totalTamas  += parseFloat(ep.tamas  || 0);
      gunaCount++;
    }
    if (ep.alpha_power != null) {
      totalDelta += parseFloat(ep.delta_power || 0);
      totalTheta += parseFloat(ep.theta_power || 0);
      totalAlpha += parseFloat(ep.alpha_power || 0);
      totalBeta  += parseFloat(ep.beta_power  || 0);
      totalGamma += parseFloat(ep.gamma_power || 0);
      bandCount++;
    }
    if (ep.tattva_flags && Array.isArray(ep.tattva_flags))
      ep.tattva_flags.forEach(f => tattvaSet.add(f));
  }

  const pct          = (v, n) => n ? (v / n * 100).toFixed(1) + '%' : 'N/A';
  const dominantChitta = Object.entries(chittaCounts).sort((a, b) => b[1] - a[1])[0];
  const dominantSwara  = Object.entries(swaraCounts).sort((a, b)  => b[1] - a[1])[0];

  // Timeline — sample up to 20 representative moments
  const step     = Math.max(1, Math.floor(epochs.length / 20));
  const timeline = epochs
    .filter((_, i) => i % step === 0)
    .map(ep => {
      const t = ep.elapsed_seconds != null
        ? `${Math.floor(ep.elapsed_seconds / 60)}:${String(Math.floor(ep.elapsed_seconds % 60)).padStart(2, '0')}`
        : `ep${ep.epoch_num}`;
      return `  [${t}] ${ep.chitta_bhumi || '?'} | ${ep.contemplative_depth || '?'} depth | ${ep.swara || '?'} | `
           + `S:${ep.sattva      != null ? (ep.sattva      * 100).toFixed(0) : '?'}% `
           + `R:${ep.rajas       != null ? (ep.rajas       * 100).toFixed(0) : '?'}% `
           + `T:${ep.tamas       != null ? (ep.tamas       * 100).toFixed(0) : '?'}% | `
           + `Alpha:${ep.alpha_power != null ? (ep.alpha_power * 100).toFixed(1) : '?'}%`;
    });

  let epochLog = '';
  if (includeFullLog) {
    // Hard cap: if session has more than MAX_EPOCH_LINES epochs, use uniform sampling
    const logEpochs = epochs.length <= MAX_EPOCH_LINES
      ? epochs
      : epochs.filter((_, i) => i % Math.ceil(epochs.length / MAX_EPOCH_LINES) === 0);

    const truncated = epochs.length > MAX_EPOCH_LINES
      ? `\n(Note: ${epochs.length} total epochs — showing ${logEpochs.length} uniformly sampled for context window budget)`
      : '';

    epochLog = `\n--- FULL EPOCH LOG (for time-based queries) ---${truncated}\n`
      + logEpochs.map(ep => {
          const t = ep.elapsed_seconds != null ? Math.round(ep.elapsed_seconds) + 's' : `ep${ep.epoch_num}`;
          return `[${t}] ${ep.chitta_bhumi || '?'}/${ep.contemplative_depth || '?'}/${ep.swara || '?'} `
               + `S:${ep.sattva     != null ? (ep.sattva     * 100).toFixed(0) : '?'}% `
               + `R:${ep.rajas      != null ? (ep.rajas      * 100).toFixed(0) : '?'}% `
               + `T:${ep.tamas      != null ? (ep.tamas      * 100).toFixed(0) : '?'}% `
               + `A:${ep.alpha_power != null ? (ep.alpha_power * 100).toFixed(1) : '?'}% `
               + `B:${ep.beta_power  != null ? (ep.beta_power  * 100).toFixed(1) : '?'}%`;
        }).join('\n');
  }

  return `
=== EEG SESSION DATA ===
Session: "${session.name}"
Recorded: ${startTime}
Duration: ${duration}
Total Epochs: ${epochs.length} (each epoch ≈ 2 seconds → ~${Math.round(epochs.length * 2 / 60)} minutes of data)

--- AGGREGATE STATISTICS ---
Dominant Mental State: ${dominantChitta ? `${dominantChitta[0]} (${((dominantChitta[1] / epochs.length) * 100).toFixed(0)}% of session)` : 'N/A'}
Full Chitta Bhumi breakdown: ${JSON.stringify(chittaCounts)}
Dominant Swara: ${dominantSwara ? `${dominantSwara[0]} (${((dominantSwara[1] / epochs.length) * 100).toFixed(0)}% of session)` : 'N/A'}
Swara breakdown: ${JSON.stringify(swaraCounts)}
Average Trigunas — Sattva:${pct(totalSattva, gunaCount)} Rajas:${pct(totalRajas, gunaCount)} Tamas:${pct(totalTamas, gunaCount)}
Average Band Powers — Delta:${pct(totalDelta, bandCount)} Theta:${pct(totalTheta, bandCount)} Alpha:${pct(totalAlpha, bandCount)} Beta:${pct(totalBeta, bandCount)} Gamma:${pct(totalGamma, bandCount)}
Tattva Events Detected: ${tattvaSet.size > 0 ? Array.from(tattvaSet).join(', ') : 'None'}

--- TIMELINE (key sampled moments) ---
${timeline.join('\n')}
${epochLog}
=== END OF SESSION DATA ===`;
}

// GET /api/ai/sessions — list the logged-in user's sessions (for the session picker UI)
router.get('/ai/sessions', requireAuth, async (req, res) => {
  try {
    // NOTE: no groq guard here — listing sessions is a pure DB query, no AI needed.
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.start_time, s.end_time, s.duration_seconds,
              COUNT(e.id)::int AS epoch_count
       FROM eeg_sessions s
       LEFT JOIN eeg_epochs e ON e.session_id = s.id
       WHERE s.user_id = $1
       GROUP BY s.id
       ORDER BY s.start_time DESC`,
      [req.session.userId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ai/start — generate an AI summary for a session (no full epoch log to save tokens)
router.post('/ai/start', requireAuth, async (req, res) => {
  try {
    if (!groq) return res.status(503).json({ error: 'AI Baba is not configured — set GROQ_API_KEY in Vercel environment variables.' });
    const sessionId = parseInt(req.body.session_id, 10);
    if (!sessionId) return res.status(400).json({ error: 'session_id required' });
    if (!(await ownedSession(sessionId, req))) return res.status(403).json({ error: 'Forbidden' });

    const [{ rows: sessionRows }, { rows: epochs }] = await Promise.all([
      pool.query('SELECT * FROM eeg_sessions WHERE id = $1', [sessionId]),
      pool.query(
        `SELECT epoch_num, elapsed_seconds, chitta_bhumi, chitta_confidence, contemplative_depth,
                swara, swara_confidence, delta_power, theta_power, alpha_power, beta_power, gamma_power,
                sattva, rajas, tamas, guna_label, tattva_flags
         FROM eeg_epochs WHERE session_id = $1 ORDER BY epoch_num ASC`,
        [sessionId]
      ),
    ]);

    if (!sessionRows[0]) return res.status(404).json({ error: 'Session not found' });

    // For the summary, use stats + timeline only (no full epoch log = smaller prompt)
    const context = buildSessionContext(sessionRows[0], epochs, /* includeFullLog= */ false);

    const completion = await groq.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: EEG_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `${context}

Please give me a warm, friendly, and easy-to-understand summary of this EEG session. Cover:
1. What mental state I was mostly in and what that felt like
2. How concentrated or focused I was overall
3. What my Swara (energy channel) tells us about my physiological state
4. What my Triguna balance reveals about my mind quality
5. The most interesting pattern or moment in the session
6. One practical encouragement or actionable takeaway

Write in warm, flowing paragraphs — like a wise friend explaining my brainwaves to me. No bullet points.`,
        },
      ],
      temperature: 0.7,
      max_tokens: 700,
    });

    res.json({
      summary:     completion.choices[0].message.content,
      session:     sessionRows[0],
      epoch_count: epochs.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ai/chat — continue a conversation about a specific session
router.post('/ai/chat', requireAuth, async (req, res) => {
  try {
    if (!groq) return res.status(503).json({ error: 'AI Baba is not configured — set GROQ_API_KEY in Vercel environment variables.' });
    const sessionId = parseInt(req.body.session_id, 10);
    const { message, history = [] } = req.body;

    if (!sessionId || !message)      return res.status(400).json({ error: 'session_id and message required' });
    if (message.trim().length === 0)  return res.status(400).json({ error: 'Message cannot be empty' });
    if (message.trim().length > 600)  return res.status(400).json({ error: 'Message too long (max 600 chars)' });
    if (!(await ownedSession(sessionId, req))) return res.status(403).json({ error: 'Forbidden' });

    // Server-side off-topic guard — fast path, no LLM call needed
    if (!isEegRelated(message)) {
      return res.json({ reply: OFF_TOPIC_REPLY });
    }

    const [{ rows: sessionRows }, { rows: epochs }] = await Promise.all([
      pool.query('SELECT * FROM eeg_sessions WHERE id = $1', [sessionId]),
      pool.query(
        `SELECT epoch_num, elapsed_seconds, chitta_bhumi, chitta_confidence, contemplative_depth,
                swara, swara_confidence, delta_power, theta_power, alpha_power, beta_power, gamma_power,
                sattva, rajas, tamas, guna_label, tattva_flags
         FROM eeg_epochs WHERE session_id = $1 ORDER BY epoch_num ASC`,
        [sessionId]
      ),
    ]);

    if (!sessionRows[0]) return res.status(404).json({ error: 'Session not found' });

    // Full epoch log included for detailed follow-up questions (capped at MAX_EPOCH_LINES)
    const context = buildSessionContext(sessionRows[0], epochs, /* includeFullLog= */ true);

    // Sanitise history — keep last 10 exchanges, cap each message at 800 chars
    const safeHistory = (Array.isArray(history) ? history : [])
      .slice(-20)
      .filter(m => m && m.role && m.content && typeof m.content === 'string')
      .map(m => ({
        role:    m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content).slice(0, 800),
      }));

    const completion = await groq.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: `${EEG_SYSTEM_PROMPT}\n\n${context}` },
        ...safeHistory,
        { role: 'user', content: message },
      ],
      temperature: 0.7,
      max_tokens: 450,
    });

    const reply = completion.choices[0].message.content;
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Mount router & export ─────────────────────────────────────────────────────
app.use('/api', router);



module.exports = app;
