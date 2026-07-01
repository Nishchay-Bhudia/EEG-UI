-- ════════════════════════════════════════════════════════════
-- EEG DEV TESTING — Database Schema
-- Run this entire script in your Supabase SQL Editor ONCE
-- before deploying to Vercel.
-- ════════════════════════════════════════════════════════════

-- 1. User role enum
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'user');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Users table
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'user',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. EEG sessions table
CREATE TABLE IF NOT EXISTS eeg_sessions (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL DEFAULT 'New Session',
  start_time       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time         TIMESTAMPTZ,
  duration_seconds INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Session notes (one per session)
CREATE TABLE IF NOT EXISTS session_notes (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES eeg_sessions(id) ON DELETE CASCADE UNIQUE,
  content    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Session store table (for express-session cookies)
CREATE TABLE IF NOT EXISTS user_sessions (
  sid    VARCHAR NOT NULL,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON user_sessions (expire);

-- 6. Session epochs — per-epoch EEG data stored during live sessions
--    Each epoch is one ~2-second inference window.
--    This table powers the admin session analytics view.
CREATE TABLE IF NOT EXISTS session_epochs (
  id                  SERIAL PRIMARY KEY,
  session_id          INTEGER NOT NULL REFERENCES eeg_sessions(id) ON DELETE CASCADE,
  epoch_num           INTEGER NOT NULL,               -- 1-based counter within session
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  elapsed_seconds     NUMERIC(10,2),                  -- seconds since session start

  -- Chitta Bhumi
  chitta_bhumi        TEXT,                           -- Kshipta | Vikshipta | Ekagra | Niruddha
  chitta_confidence   TEXT,                           -- e.g. "82.4%"
  contemplative_depth TEXT,                           -- Surface | Emerging | Deep | Profound

  -- Swara Nadi
  swara               TEXT,                           -- Ida | Pingala | Sushumna
  swara_confidence    TEXT,

  -- Relative band powers (0..1)
  delta_power         NUMERIC(8,6),
  theta_power         NUMERIC(8,6),
  alpha_power         NUMERIC(8,6),
  beta_power          NUMERIC(8,6),
  gamma_power         NUMERIC(8,6),

  -- Trigunas (0..1, sum to 1)
  sattva              NUMERIC(8,6),
  rajas               NUMERIC(8,6),
  tamas               NUMERIC(8,6),
  guna_label          TEXT,                           -- Sattvic | Rajasic | Tamasic | Balanced

  -- Tattva flags (JSON array of strings)
  tattva_flags        JSONB NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_epoch_session ON session_epochs (session_id, epoch_num);
