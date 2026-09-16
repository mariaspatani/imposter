-- ============================================================
-- ASTHRA 11.0 — Event-Ready Data Cleanup (008)
-- ============================================================
-- PURPOSE: Wipe ALL test / demo / staging data so the database
--          is 100% clean for real event registration.
-- SAFETY : All DELETEs are ordered by FK dependency (children
--          before parents) and wrapped in a transaction.
-- PRESERVES: main_event_tasks, evaluation_criteria, game_config
--            (the canonical event content / rubric rows).
-- USAGE   : Run once in Supabase Dashboard → SQL Editor.
--           Safe to re-run (idempotent on empty tables).
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. WIPE DATA TABLES (order: children → parents for FK safety)
-- ──────────────────────────────────────────────────────────────

-- Tables with no FK dependencies
DELETE FROM audit_log;
DELETE FROM admin_sessions;
DELETE FROM score_events;
DELETE FROM evaluations;
DELETE FROM competitive_evaluation_pairs;
DELETE FROM code_imposter_submissions;
DELETE FROM fizzbuzz_submissions_v2;
DELETE FROM manual_event_scores_v2;

-- main_event_assignments → depends on participants(UUID)
DELETE FROM main_event_assignments;

-- participants → depends on teams(id)
DELETE FROM participants;

-- teams → top-level entity (no parent FK)
DELETE FROM teams;

-- ──────────────────────────────────────────────────────────────
-- 2. RESET ALL SERIAL / SEQUENCE COUNTERS back to 1
-- ──────────────────────────────────────────────────────────────

-- Standard tables with SERIAL id columns
ALTER SEQUENCE IF EXISTS audit_log_id_seq          RESTART WITH 1;
ALTER SEQUENCE IF EXISTS main_event_assignments_id_seq RESTART WITH 1;
ALTER SEQUENCE IF EXISTS main_event_tasks_id_seq       RESTART WITH 1;
ALTER SEQUENCE IF EXISTS code_imposter_submissions_id_seq RESTART WITH 1;
ALTER SEQUENCE IF EXISTS evaluation_criteria_id_seq    RESTART WITH 1;
ALTER SEQUENCE IF EXISTS teams_id_seq                  RESTART WITH 1;

-- Supabase may auto-generate sequences with alternative naming.
-- Try to reset any schema-scope serial sequences using generic blocks.
DO $$
DECLARE
    seq record;
BEGIN
    FOR seq IN
        SELECT s.relname AS seq_name
        FROM pg_class s
        JOIN pg_namespace n ON n.oid = s.relnamespace
        WHERE s.relkind = 'S'
          AND n.nspname = 'public'
          AND s.relname LIKE '%_id_seq'
    LOOP
        EXECUTE format('ALTER SEQUENCE IF EXISTS %I RESTART WITH 1', seq.seq_name);
    END LOOP;
END $$;

-- ──────────────────────────────────────────────────────────────
-- 3. RESET CONFIG / STATE TABLES to event-ready defaults
--    (Do NOT DELETE these — only reset runtime state columns)
-- ──────────────────────────────────────────────────────────────

-- 3a. event_timers → keep the 4 canonical rows, reset runtime fields
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

-- Safety net: re-insert any missing timer rows (just in case they were deleted)
INSERT INTO event_timers (event_key, event_name, duration_minutes, remaining_seconds, duration_seconds, status)
VALUES
  ('main_event',    'Main Event',      45, 2700, 2700, 'idle'),
  ('fizzbuzz',      'FizzBuzz',        15,  900,  900, 'idle'),
  ('code_imposter', 'Code Imposter',   20, 1200, 1200, 'idle'),
  ('sherlock',      'Sherlock Holmes', 45, 2700, 2700, 'idle')
ON CONFLICT (event_key) DO NOTHING;

-- 3b. shuffle_lock → single-row, ensure UNLOCKED so coordinator can shuffle
UPDATE shuffle_lock
SET
    is_locked = FALSE,
    locked_at = NULL,
    locked_by = NULL
WHERE id = 1;

-- Safety net: re-insert row if missing
INSERT INTO shuffle_lock (id, is_locked) VALUES (1, FALSE)
ON CONFLICT (id) DO NOTHING;

-- 3c. event_state → single-row, reset to READY
UPDATE event_state
SET
    status     = 'READY',
    updated_at = NOW()
WHERE id = 1;

-- Safety net: re-insert row if missing
INSERT INTO event_state (id, status) VALUES (1, 'READY')
ON CONFLICT (id) DO NOTHING;

-- 3d. game_config → reset scoring_locked flag, preserve config_json
UPDATE game_config
SET
    scoring_locked = FALSE,
    updated_at     = NOW()
WHERE game_id IN ('main_event', 'fizzbuzz');

-- Safety net: re-insert missing game rows
INSERT INTO game_config (game_id, imposter_enabled, imposter_count, imposter_bonus,
                         imposter_success_condition, fizz_divisor, buzz_divisor,
                         scoring_locked, config_json)
VALUES
  ('main_event', TRUE, 1, 10, 'FIZZBUZZ_PRINTED_AS_NUMBER', 3, 5, FALSE,
   '{"rangeStart":1,"rangeEnd":100}'::jsonb),
  ('fizzbuzz',   TRUE, 1, 10, 'FIZZBUZZ_PRINTED_AS_NUMBER', 3, 5, FALSE,
   '{"rangeStart":1,"rangeEnd":100,"correctTeamScore":20,"incorrectTeamScore":0,"speedBonusFirst":5,"speedBonusRest":2,"speedBonusCutoff":2}'::jsonb)
ON CONFLICT (game_id) DO NOTHING;

-- 3e. evaluation_criteria → ensure the 5 main-event rubric rows exist
INSERT INTO evaluation_criteria
       (game_id, criterion_key,    name,              description,                                                max_score, weight, sort_order, assignment_field)
VALUES
  ('main_event', 'task_completion', 'Task Completion', 'Does the code implement the required features?',            40,        1,      1,          'task_match_score'),
  ('main_event', 'ui',              'UI / UX',         'Is the interface clean and usable?',                        20,        1,      2,          'ui_score'),
  ('main_event', 'logic',           'Code Quality',    'Is the logic correct and structured?',                      20,        1,      3,          'logic_score'),
  ('main_event', 'responsiveness',  'Responsiveness',  'Does the layout work across screen sizes?',                 10,        1,      4,          'code_quality_score'),
  ('main_event', 'creativity',      'Creativity',      'Creative enhancements beyond the minimum.',                10,        1,      5,          'creativity_score')
ON CONFLICT (game_id, criterion_key) DO NOTHING;

-- 3f. main_event_tasks → ensure the 3 canonical event tasks exist
INSERT INTO main_event_tasks (
    task_number, task_title, task_description,
    person1_title, person1_work,
    person2_title, person2_work,
    person3_title, person3_work,
    person4_title, person4_work, person4_secret
) VALUES (
    1,
    'The 45-Minute Game Plan',
    'Build an interactive photo gallery web app as a team. Each member handles a distinct layer of the UI and functionality. One member is secretly the Imposter with a hidden sabotage objective.',
    'The Frame Maker',
    'Time to code: 20 mins | Testing: 10 mins. Create 4 to 6 picture cards with white borders and simple text captions. Goal: Make the main gallery wall look clean and ready to display photos.',
    'The Vibe Switcher',
    'Time to code: 20 mins | Testing: 10 mins. Add 3 simple buttons at the top ("B&W", "Vintage", "Reset"). Goal: Add a quick CSS rule so clicking the buttons changes the photo colors.',
    'The Party Popper',
    'Time to code: 25 mins | Testing: 10 mins. Build a basic click-to-zoom effect. Goal: Make it so clicking a photo opens it bigger on the screen with a dark overlay backdrop.',
    'The Imposter',
    'Time to code: 25 mins | Testing: 10 mins. Cover Job: Build the "Like Button & Reaction Counter" on every photo card so the team thinks you are just making an interactive favorite feature.',
    'SECRET TRAP: Hide the chaos code inside one specific photo''s Like button! If someone clicks that specific photo''s heart 3 times fast, it activates "Chaos Mode" — swaps all photos to silly memes or spins the page. Do NOT reveal this to anyone.'
) ON CONFLICT (task_number) DO NOTHING;

INSERT INTO main_event_tasks (
    task_number, task_title, task_description,
    person1_title, person1_work,
    person2_title, person2_work,
    person3_title, person3_work,
    person4_title, person4_work, person4_secret
) VALUES (
    2,
    'Food Cart Builder',
    'Build a food ordering web app as a team. Each member owns a specific feature layer. One member is secretly the Imposter with a hidden inflation sabotage objective.',
    'The UI & Grid Designer',
    'Goal: Build a visual grid of food cards. Key Features: Render dynamic cards containing item images/emojis, dish titles, descriptions, and price tags. Include an "Add to Cart" button on each card. Technical Focus: Component layout (CSS Grid/Flexbox), rendering lists from a JSON dataset.',
    'The Logic Lead',
    'Goal: Create a navigation toolbar that controls what shows up on the screen. Key Features: Filter buttons for "All", "Snacks", "Drinks", and "Desserts", plus a search bar for specific items. Technical Focus: Array filtering methods (.filter()), passing active category states.',
    'The State Manager',
    'Goal: Build a slide-out drawer that tracks selections and handles financial math. Key Features: A side panel displaying selected items, quantity increments/decrements (+/-), subtotal calculation, tax calculation, and a final total. Technical Focus: State aggregation, JavaScript .reduce() for sum totals, drawer open/close animations.',
    'The Imposter',
    'Cover Job: Build a quick tip selection bar ($1, $2, $5, or Custom %).',
    'SECRET TRAP ("Inflation Crisis"): Attach a hidden setInterval listener to the $5 Tip button. When clicked, it initiates a loop that increases the final bill by $100 every 50 milliseconds until it hits $999,999. Optional visual touch: Flashes the screen red and adds warning text: "INFLATION RUNAWAY DETECTED." Do NOT reveal this to anyone.'
) ON CONFLICT (task_number) DO NOTHING;

INSERT INTO main_event_tasks (
    task_number, task_title, task_description,
    person1_title, person1_work,
    person2_title, person2_work,
    person3_title, person3_work,
    person4_title, person4_work, person4_secret
) VALUES (
    3,
    'Event Fortune Teller / Wheel of Destiny',
    'Build a mysterious interactive carnival booth where attendees get custom event predictions. One member is secretly the Imposter with a hidden Y2K meltdown sabotage objective.',
    'The Mystic Crystal',
    'Build the main central crystal ball or spinning wheel element with glowing CSS borders and mystical background vibes.',
    'The Fortune Generator',
    'Create 5 selector buttons ("Will I win a prize?", "Who is my event match?", "My future today", "My lucky number", "What awaits me?") that display random fortune cards.',
    'The Audio Oracle',
    'Add eerie/fun sound effect buttons (Gong, Magic Chime, Suspense Drum) that play during fortune readings.',
    'The Imposter',
    'Cover Job: Build a "Enter Your Birth Year" drop-down box to "customize" predictions.',
    'SECRET TRAP: Selecting the year "1999" triggers Y2K Meltdown — glitchy text rapidly overrides the entire screen, turning the font to neon green matrix code and flashing fake error alerts. Do NOT reveal this to anyone.'
) ON CONFLICT (task_number) DO NOTHING;

-- ──────────────────────────────────────────────────────────────
-- 4. POST-CLEANUP SANITY CHECK (returns row counts for verification)
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE
    cnt_teams         bigint; cnt_parts         bigint; cnt_mea    bigint;
    cnt_fizz          bigint; cnt_ci            bigint; cnt_manual bigint;
    cnt_evals         bigint; cnt_score_events  bigint; cnt_pairs  bigint;
    cnt_audit         bigint; cnt_admin_sess    bigint;
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

    msg := format(
        E'[EVENT-READY CLEANUP] Data tables wiped ✓\n'
        '  teams = %s | participants = %s | assignments = %s\n'
        '  fizzbuzz = %s | code_imposter = %s | manual_scores = %s\n'
        '  evaluations = %s | score_events = %s | eval_pairs = %s\n'
        '  audit_log = %s | admin_sessions = %s',
        cnt_teams, cnt_parts, cnt_mea,
        cnt_fizz, cnt_ci, cnt_manual,
        cnt_evals, cnt_score_events, cnt_pairs,
        cnt_audit, cnt_admin_sess
    );
    RAISE NOTICE '%', msg;
END $$;

COMMIT;
