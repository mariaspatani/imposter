-- ============================================================
-- ASTHRA 2K26 IMPOSTER — Missing Tables Migration
-- Run this in Supabase Dashboard → SQL Editor
-- Safe to run: all use IF NOT EXISTS / ON CONFLICT DO NOTHING
-- (Only the 6 tables that are missing from the live database)
-- ============================================================

-- ── 6. shuffle_lock ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shuffle_lock (
    id          INTEGER      PRIMARY KEY DEFAULT 1,
    is_locked   BOOLEAN      NOT NULL DEFAULT FALSE,
    locked_at   TIMESTAMPTZ,
    locked_by   TEXT,
    CONSTRAINT  single_row CHECK (id = 1)
);

INSERT INTO shuffle_lock (id, is_locked) VALUES (1, FALSE)
ON CONFLICT (id) DO NOTHING;

-- ── 8. fizzbuzz_submissions_v2 ────────────────────────────────
CREATE TABLE IF NOT EXISTS fizzbuzz_submissions_v2 (
    shuffled_group      TEXT         PRIMARY KEY,
    submitted_by        TEXT         NOT NULL,
    participant_id      TEXT         NOT NULL,
    fizz_output         TEXT,
    language            TEXT         NOT NULL DEFAULT 'Unknown',
    repo_url            TEXT,
    submitted_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    status              TEXT         NOT NULL DEFAULT 'Submitted',
    is_correct          BOOLEAN,
    speed_bonus         INTEGER      NOT NULL DEFAULT 0,
    imposter_bonus      INTEGER      NOT NULL DEFAULT 0,
    imposter_sabotaged  BOOLEAN      NOT NULL DEFAULT FALSE
);

-- ── 9. code_imposter_submissions ─────────────────────────────
CREATE TABLE IF NOT EXISTS code_imposter_submissions (
    id               SERIAL       PRIMARY KEY,
    participant_id   UUID         REFERENCES participants(id) ON DELETE SET NULL,
    participant_name TEXT         NOT NULL,
    original_team    TEXT         NOT NULL,
    elapsed_time     TEXT         NOT NULL,
    submitted_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── 10. manual_event_scores_v2 ────────────────────────────────
CREATE TABLE IF NOT EXISTS manual_event_scores_v2 (
    original_team  TEXT        PRIMARY KEY,
    code_imposter  INTEGER     NOT NULL DEFAULT 0,
    sherlock       INTEGER     NOT NULL DEFAULT 0,
    drawing        INTEGER     NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 11. admin_sessions ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_sessions (
    token       TEXT         PRIMARY KEY,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '12 hours')
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions (expires_at);

-- ── 12. audit_log ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id           SERIAL       PRIMARY KEY,
    action       TEXT         NOT NULL,
    performed_by TEXT,
    target       TEXT,
    details      JSONB,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);

-- ── Indexes for main_event_assignments (if not yet created) ───
CREATE INDEX IF NOT EXISTS idx_mea_evaluation_status ON main_event_assignments (evaluation_status);
