'use strict';

const express      = require('express');
const session      = require('express-session');
const connectPg    = require('connect-pg-simple');
const bcrypt       = require('bcryptjs');
const { Pool }     = require('pg');

// ── Database pool ─────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },   // required for Supabase
  max: 5,                               // keep small for serverless
});

// ── Session store ─────────────────────────────────────────────────────────────
const PgSession = connectPg(session);

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1);  // trust Vercel's proxy for secure cookies

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: false,  // table already created via schema.sql
    }),
    secret: process.env.SESSION_SECRET || 'change-me-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,  // 7 days
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'lax' : 'lax',
    },
  })
);

// ── Seed admin on cold start ──────────────────────────────────────────────────
(async () => {
  try {
    const { rows } = await pool.query(
      "SELECT id FROM users WHERE username = 'admin' LIMIT 1"
    );
    if (rows.length === 0) {
      const hash = await bcrypt.hash('ShreeHari!', 12);
      await pool.query(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')",
        ['admin', hash]
      );
    }
  } catch (e) {
    console.error('Admin seed error:', e.message);
  }
})();

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── Row mappers (DB snake_case → frontend camelCase) ─────────────────────────
function mapUser(r) {
  return { id: r.id, username: r.username, role: r.role, createdAt: r.created_at };
}

function mapSession(r) {
  return {
    id:        r.id,
    userId:    r.user_id,
    username:  r.username ?? undefined,
    name:      r.name,
    startTime: r.start_time,
    endTime:   r.end_time ?? null,
    duration:  r.duration_seconds ?? null,
    createdAt: r.created_at,
  };
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = express.Router();

// Health
router.get('/healthz', (_req, res) => res.json({ ok: true }));

// ── Auth ──────────────────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    req.session.userId   = user.id;
    req.session.username = user.username;
    req.session.role     = user.role;

    res.json({ id: user.id, username: user.username, role: user.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({
    id:       req.session.userId,
    username: req.session.username,
    role:     req.session.role,
  });
});

// ── User management (admin only) ──────────────────────────────────────────────
router.get('/users', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, role, created_at FROM users ORDER BY created_at'
    );
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
        `SELECT s.id, s.user_id, u.username, s.name,
                s.start_time, s.end_time, s.duration_seconds, s.created_at
         FROM eeg_sessions s
         LEFT JOIN users u ON s.user_id = u.id
         ORDER BY s.start_time DESC`
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT s.id, s.user_id, NULL::text AS username, s.name,
                s.start_time, s.end_time, s.duration_seconds, s.created_at
         FROM eeg_sessions s
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

router.post('/sessions', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    const sessionName = (name && name.trim()) || `Session ${new Date().toLocaleString()}`;

    const { rows } = await pool.query(
      'INSERT INTO eeg_sessions (user_id, name) VALUES ($1, $2) RETURNING *',
      [req.session.userId, sessionName]
    );
    const sess = rows[0];

    // Create an empty notes row for this session
    await pool.query(
      'INSERT INTO session_notes (session_id, content) VALUES ($1, $2) ON CONFLICT (session_id) DO NOTHING',
      [sess.id, '']
    );

    res.status(201).json(mapSession(sess));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/sessions/:id/end', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: [sess] } = await pool.query('SELECT * FROM eeg_sessions WHERE id = $1', [id]);
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (req.session.role !== 'admin' && sess.user_id !== req.session.userId)
      return res.status(403).json({ error: 'Forbidden' });

    const now = new Date();
    const duration = Math.round((now.getTime() - new Date(sess.start_time).getTime()) / 1000);

    const { rows } = await pool.query(
      'UPDATE eeg_sessions SET end_time = $1, duration_seconds = $2 WHERE id = $3 RETURNING *',
      [now, duration, id]
    );
    res.json(mapSession(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/sessions/:id/name', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

    const { rows: [sess] } = await pool.query('SELECT * FROM eeg_sessions WHERE id = $1', [id]);
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (req.session.role !== 'admin' && sess.user_id !== req.session.userId)
      return res.status(403).json({ error: 'Forbidden' });

    const { rows } = await pool.query(
      'UPDATE eeg_sessions SET name = $1 WHERE id = $2 RETURNING *',
      [name.trim(), id]
    );
    res.json(mapSession(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Session Notes ─────────────────────────────────────────────────────────────
router.get('/sessions/:id/notes', requireAuth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { rows: [sess] } = await pool.query('SELECT * FROM eeg_sessions WHERE id = $1', [sessionId]);
    if (!sess) return res.status(404).json({ error: 'Session not found' });
    if (req.session.role !== 'admin' && sess.user_id !== req.session.userId)
      return res.status(403).json({ error: 'Forbidden' });

    const { rows: [note] } = await pool.query(
      'SELECT * FROM session_notes WHERE session_id = $1', [sessionId]
    );
    res.json({ sessionId, content: note ? note.content : '' });
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
