-- ============================================================
-- ASTHRA 2K26 IMPOSTER — Game engine tables
-- Additive and idempotent. Does not rewrite original team identity.
-- ============================================================

ALTER TABLE event_timers
  ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;

ALTER TABLE event_timers
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;

UPDATE event_timers
SET duration_seconds = duration_minutes * 60
WHERE duration_seconds IS NULL;

ALTER TABLE main_event_assignments
  ADD COLUMN IF NOT EXISTS original_team_id INTEGER;

ALTER TABLE main_event_assignments
  ADD COLUMN IF NOT EXISTS evaluation_started_at TIMESTAMPTZ;

ALTER TABLE main_event_assignments
  ADD COLUMN IF NOT EXISTS session_team_id TEXT;

UPDATE main_event_assignments
SET session_team_id = shuffled_group
WHERE session_team_id IS NULL AND shuffled_group IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_state (
    id          INTEGER      PRIMARY KEY DEFAULT 1,
    status      TEXT         NOT NULL DEFAULT 'READY',
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT  event_state_single CHECK (id = 1)
);

INSERT INTO event_state (id, status) VALUES (1, 'READY')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS game_config (
    game_id                      TEXT         PRIMARY KEY,
    imposter_enabled             BOOLEAN      NOT NULL DEFAULT TRUE,
    imposter_count               INTEGER      NOT NULL DEFAULT 1,
    imposter_bonus               INTEGER      NOT NULL DEFAULT 10,
    imposter_success_condition   TEXT         NOT NULL DEFAULT 'FIZZBUZZ_PRINTED_AS_NUMBER',
    fizz_divisor                 INTEGER      NOT NULL DEFAULT 3,
    buzz_divisor                 INTEGER      NOT NULL DEFAULT 5,
    scoring_locked               BOOLEAN      NOT NULL DEFAULT FALSE,
    config_json                  JSONB        NOT NULL DEFAULT '{}'::jsonb,
    updated_at                   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

INSERT INTO game_config (game_id, config_json) VALUES
  ('main_event', '{"rangeStart":1,"rangeEnd":100}'::jsonb),
  ('fizzbuzz',   '{"rangeStart":1,"rangeEnd":100,"correctTeamScore":20,"incorrectTeamScore":0,"speedBonusFirst":5,"speedBonusRest":2,"speedBonusCutoff":2}'::jsonb)
ON CONFLICT (game_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS evaluation_criteria (
    id              SERIAL       PRIMARY KEY,
    game_id         TEXT         NOT NULL,
    criterion_key   TEXT         NOT NULL,
    name            TEXT         NOT NULL,
    description     TEXT,
    max_score       INTEGER      NOT NULL,
    weight          NUMERIC      NOT NULL DEFAULT 1,
    sort_order      INTEGER      NOT NULL DEFAULT 0,
    assignment_field TEXT,
    UNIQUE (game_id, criterion_key)
);

INSERT INTO evaluation_criteria (game_id, criterion_key, name, description, max_score, sort_order, assignment_field) VALUES
  ('main_event', 'task_completion', 'Task Completion', 'Does the code implement the required features?', 40, 1, 'task_match_score'),
  ('main_event', 'ui',              'UI / UX',         'Is the interface clean and usable?', 20, 2, 'ui_score'),
  ('main_event', 'logic',           'Code Quality',    'Is the logic correct and structured?', 20, 3, 'logic_score'),
  ('main_event', 'responsiveness',  'Responsiveness',  'Does the layout work across screen sizes?', 10, 4, 'code_quality_score'),
  ('main_event', 'creativity',      'Creativity',      'Creative enhancements beyond the minimum.', 10, 5, 'creativity_score')
ON CONFLICT (game_id, criterion_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS evaluations (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id   UUID         NOT NULL,
    game_id          TEXT         NOT NULL DEFAULT 'main_event',
    status           TEXT         NOT NULL DEFAULT 'NOT_STARTED',
    attempt          INTEGER      NOT NULL DEFAULT 1,
    criteria_scores  JSONB,
    total_score      INTEGER,
    max_total        INTEGER,
    feedback         TEXT,
    error_message    TEXT,
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    runtime_evidence JSONB,
    UNIQUE (participant_id, game_id)
);

CREATE TABLE IF NOT EXISTS score_events (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id           TEXT         NOT NULL DEFAULT 'asthra',
    game_id            TEXT         NOT NULL,
    participant_id     UUID,
    original_team_id   INTEGER,
    original_team      TEXT,
    session_team_id    TEXT,
    points             INTEGER      NOT NULL,
    reason             TEXT,
    type               TEXT         NOT NULL,
    idempotency_key    TEXT         UNIQUE,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_score_events_team ON score_events (original_team);
CREATE INDEX IF NOT EXISTS idx_score_events_participant ON score_events (participant_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_status ON evaluations (status);
