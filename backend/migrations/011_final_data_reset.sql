-- ============================================================
-- ASTHRA 11.0 — Final Production Data Reset (011)
-- ============================================================
-- PURPOSE : Wipe ALL test / demo / staging data from every
--           data-bearing table so the database is 100 % clean
--           for the real event.
-- PRESERVES: main_event_tasks (task content/rubrics)
--            evaluation_criteria (scoring rubric rows)
--            game_config (game configuration)
--            event_timers rows (reset to idle, not deleted)
--            shuffle_lock row (reset to unlocked)
--            event_state row (reset to READY)
-- CHANGES NOTHING in schema, UI, or functionality.
-- USAGE   : Run once in Supabase Dashboard → SQL Editor.
--           Safe to re-run (idempotent on already-empty tables).
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. WIPE ALL DATA TABLES (children → parents for FK safety)
-- ──────────────────────────────────────────────────────────────

-- Leaf / no-FK-dependency tables
DELETE FROM audit_log;
DELETE FROM admin_sessions;

-- Score / evaluation tables
DELETE FROM score_events;
DELETE FROM evaluations;
DELETE FROM competitive_evaluation_pairs;

-- Submission tables
DELETE FROM code_imposter_submissions;
DELETE FROM fizzbuzz_submissions_v2;

-- Legacy fizzbuzz table (created in create_main_event_assignments.sql Phase 4)
-- Guard: only delete if the table actually exists in this database
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'fizzbuzz_submissions'
    ) THEN
        DELETE FROM fizzbuzz_submissions;
    END IF;
END $$;

-- Manual scores tables (v2 and legacy)
DELETE FROM manual_event_scores_v2;

-- Legacy manual_event_scores table (may not exist in all deployments)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'manual_event_scores'
    ) THEN
        DELETE FROM manual_event_scores;
    END IF;
END $$;

-- Assignment table (depends on participants)
DELETE FROM main_event_assignments;

-- Participants (depends on teams)
DELETE FROM participants;

-- Teams (top-level entity)
DELETE FROM teams;

-- ──────────────────────────────────────────────────────────────
-- 2. RESET ALL SERIAL / SEQUENCE COUNTERS back to 1
-- ──────────────────────────────────────────────────────────────

ALTER SEQUENCE IF EXISTS teams_id_seq                     RESTART WITH 1;
ALTER SEQUENCE IF EXISTS main_event_assignments_id_seq    RESTART WITH 1;
ALTER SEQUENCE IF EXISTS main_event_tasks_id_seq          RESTART WITH 1;
ALTER SEQUENCE IF EXISTS code_imposter_submissions_id_seq RESTART WITH 1;
ALTER SEQUENCE IF EXISTS evaluation_criteria_id_seq       RESTART WITH 1;
ALTER SEQUENCE IF EXISTS audit_log_id_seq                 RESTART WITH 1;
ALTER SEQUENCE IF EXISTS manual_event_scores_id_seq       RESTART WITH 1;

-- Generic sweep: reset every public %_id_seq
DO $$
DECLARE
    seq record;
BEGIN
    FOR seq IN
        SELECT s.relname AS seq_name
        FROM pg_class s
        JOIN pg_namespace n ON n.oid = s.relnamespace
        WHERE s.relkind = 'S'
          AND n.nspname  = 'public'
          AND s.relname LIKE '%_id_seq'
    LOOP
        BEGIN
            EXECUTE format('ALTER SEQUENCE IF EXISTS %I RESTART WITH 1', seq.seq_name);
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Skipped sequence %: %', seq.seq_name, SQLERRM;
        END;
    END LOOP;
END $$;

-- ──────────────────────────────────────────────────────────────
-- 3. RESET CONFIG / STATE TABLES to event-ready defaults
--    (rows are UPDATED, never deleted)
-- ──────────────────────────────────────────────────────────────

-- 3a. event_timers (canonical TEXT-key table used by the live app)
UPDATE event_timers
SET
    started_at        = NULL,
    paused_at         = NULL,
    ends_at           = NULL,
    remaining_seconds = duration_minutes * 60,
    duration_seconds  = duration_minutes * 60,
    status            = 'idle',
    updated_at        = NOW()
WHERE event_key IN ('main_event', 'fizzbuzz', 'code_imposter', 'sherlock');

-- Safety net: re-insert any missing timer rows
INSERT INTO event_timers (event_key, event_name, duration_minutes, remaining_seconds, duration_seconds, status)
VALUES
  ('main_event',    'Main Event',      45, 2700, 2700, 'idle'),
  ('fizzbuzz',      'FizzBuzz',        15,  900,  900, 'idle'),
  ('code_imposter', 'Code Imposter',   20, 1200, 1200, 'idle'),
  ('sherlock',      'Sherlock Holmes', 45, 2700, 2700, 'idle')
ON CONFLICT (event_key) DO NOTHING;

-- 3b. event_timers_v2 (legacy table — reset if it exists)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'event_timers_v2'
    ) THEN
        UPDATE event_timers_v2
        SET
            started_at        = NULL,
            paused_at         = NULL,
            remaining_seconds = duration_minutes * 60,
            status            = 'idle'
        WHERE event_key IN ('main_event', 'fizzbuzz', 'code_imposter', 'sherlock');
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'event_timers_v2 reset skipped: %', SQLERRM;
END $$;

-- 3c. shuffle_lock → ensure UNLOCKED
UPDATE shuffle_lock
SET
    is_locked = FALSE,
    locked_at = NULL,
    locked_by = NULL
WHERE id = 1;

INSERT INTO shuffle_lock (id, is_locked) VALUES (1, FALSE)
ON CONFLICT (id) DO NOTHING;

-- 3d. event_state → reset to READY
UPDATE event_state
SET
    status     = 'READY',
    updated_at = NOW()
WHERE id = 1;

INSERT INTO event_state (id, status) VALUES (1, 'READY')
ON CONFLICT (id) DO NOTHING;

-- 3e. game_config → reset scoring_locked, keep config_json intact
UPDATE game_config
SET
    scoring_locked = FALSE,
    updated_at     = NOW()
WHERE game_id IN ('main_event', 'fizzbuzz');

INSERT INTO game_config (game_id, imposter_enabled, imposter_count, imposter_bonus,
                         imposter_success_condition, fizz_divisor, buzz_divisor,
                         scoring_locked, config_json)
VALUES
  ('main_event', TRUE, 1, 10, 'FIZZBUZZ_PRINTED_AS_NUMBER', 3, 5, FALSE,
   '{"rangeStart":1,"rangeEnd":100}'::jsonb),
  ('fizzbuzz',   TRUE, 1, 10, 'FIZZBUZZ_PRINTED_AS_NUMBER', 3, 5, FALSE,
   '{"rangeStart":1,"rangeEnd":100,"correctTeamScore":20,"incorrectTeamScore":0,"speedBonusFirst":5,"speedBonusRest":2,"speedBonusCutoff":2}'::jsonb)
ON CONFLICT (game_id) DO NOTHING;

-- 3f. evaluation_criteria → ensure the 5 rubric rows exist (preserve existing)
INSERT INTO evaluation_criteria
       (game_id, criterion_key,    name,              description,                                              max_score, weight, sort_order, assignment_field)
VALUES
  ('main_event', 'task_completion', 'Task Completion', 'Does the code implement the required features?',          40,       1,      1,          'task_match_score'),
  ('main_event', 'ui',              'UI / UX',         'Is the interface clean and usable?',                      20,       1,      2,          'ui_score'),
  ('main_event', 'logic',           'Code Quality',    'Is the logic correct and structured?',                    20,       1,      3,          'logic_score'),
  ('main_event', 'responsiveness',  'Responsiveness',  'Does the layout work across screen sizes?',               10,       1,      4,          'code_quality_score'),
  ('main_event', 'creativity',      'Creativity',      'Creative enhancements beyond the minimum.',               10,       1,      5,          'creativity_score')
ON CONFLICT (game_id, criterion_key) DO NOTHING;

-- ──────────────────────────────────────────────────────────────
-- 4. POST-CLEANUP SANITY CHECK
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE
    cnt_teams         bigint; cnt_parts         bigint; cnt_mea    bigint;
    cnt_fizz          bigint; cnt_ci            bigint; cnt_manual bigint;
    cnt_evals         bigint; cnt_score_events  bigint; cnt_pairs  bigint;
    cnt_audit         bigint; cnt_admin_sess    bigint;
    cnt_tasks         bigint; cnt_criteria      bigint;
    msg text;
BEGIN
    SELECT count(*) INTO cnt_teams        FROM teams;
    SELECT count(*) INTO cnt_parts        FROM participants;
    SELECT count(*) INTO cnt_mea          FROM main_event_assignments;
    SELECT count(*) INTO cnt_fizz         FROM fizzbuzz_submissions_v2;
    SELECT count(*) INTO cnt_ci           FROM code_imposter_submissions;
    SELECT count(*) INTO cnt_manual       FROM manual_event_scores_v2;
    SELECT count(*) INTO cnt_evals        FROM evaluations;
    SELECT count(*) INTO cnt_score_events FROM score_events;
    SELECT count(*) INTO cnt_pairs        FROM competitive_evaluation_pairs;
    SELECT count(*) INTO cnt_audit        FROM audit_log;
    SELECT count(*) INTO cnt_admin_sess   FROM admin_sessions;
    SELECT count(*) INTO cnt_tasks        FROM main_event_tasks;
    SELECT count(*) INTO cnt_criteria     FROM evaluation_criteria;

    msg := format(
        E'[FINAL DATA RESET — 011] Production-ready ✓\n'
        '  DATA WIPED:\n'
        '    teams=%s | participants=%s | assignments=%s\n'
        '    fizzbuzz_submissions=%s | code_imposter=%s | manual_scores=%s\n'
        '    evaluations=%s | score_events=%s | eval_pairs=%s\n'
        '    audit_log=%s | admin_sessions=%s\n'
        '  PRESERVED:\n'
        '    main_event_tasks=%s | evaluation_criteria=%s',
        cnt_teams, cnt_parts, cnt_mea,
        cnt_fizz, cnt_ci, cnt_manual,
        cnt_evals, cnt_score_events, cnt_pairs,
        cnt_audit, cnt_admin_sess,
        cnt_tasks, cnt_criteria
    );
    RAISE NOTICE '%', msg;
END $$;

COMMIT;
