-- ════════════════════════════════════════════════════════════
-- EEG DEV TESTING — Database Schema
-- Run this entire script in your Supabase SQL Editor ONCE
-- before deploying to Vercel.
-- ════════════════════════════════════════════════════════════

-- 1. User role enum
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'user', 'co-admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 1b. If the enum already existed from a previous run, make sure 'co-admin' is present.
DO $$ BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'co-admin';
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

-- 6. EEG epochs — per-epoch EEG data stored during live sessions
--    Each epoch is one ~2-second inference window.
--    This table powers the admin session analytics view.
--    NOTE: table name must be `eeg_epochs` — this is what api/server.js queries.
CREATE TABLE IF NOT EXISTS eeg_epochs (
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
  tattva_flags        JSONB NOT NULL DEFAULT '[]',

  -- Vitals (from BLE pulse oximeter / demo mode)
  blood_oxygen        NUMERIC(5,2),                   -- SpO2 %
  heart_rate          NUMERIC(5,2)                     -- BPM
);

CREATE INDEX IF NOT EXISTS idx_epoch_session ON eeg_epochs (session_id, epoch_num);

-- 6b. Migration safety net: if an older deployment already created the table
--     under the previous name/shape, bring it up to the current shape.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'session_epochs')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'eeg_epochs') THEN
    ALTER TABLE session_epochs RENAME TO eeg_epochs;
  END IF;
END $$;

ALTER TABLE eeg_epochs ADD COLUMN IF NOT EXISTS blood_oxygen NUMERIC(5,2);
ALTER TABLE eeg_epochs ADD COLUMN IF NOT EXISTS heart_rate NUMERIC(5,2);
