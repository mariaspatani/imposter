-- ============================================================
-- FIX: main_event_assignments column type mismatches
-- ------------------------------------------------------------
-- Errors being fixed:
--   1. "Assignment insert failed: invalid input syntax for type
--      integer: \"7d1df9aa-37ee-4c17-983c-bac3c8b707c9\""
--      → participant_id created as INTEGER but must be UUID.
--   2. Same integer-type error for session_team_id if the
--      column was manually added with wrong type (TEXT is correct
--      per migration 004_game_engine.sql).
--
-- Run ONCE against the Supabase project using the SQL editor.
-- Safe to re-run (all statements use IF EXISTS / IF NOT EXISTS
-- and are wrapped in safe DO blocks).
-- ============================================================

-- ── 1. Fix session_team_id type if it was created wrong ─────
--    Canonical type: TEXT (per 004_game_engine.sql).
--    If user created it as INTEGER manually, convert to TEXT.
DO $$
DECLARE
    coltype text;
BEGIN
    SELECT data_type INTO coltype
    FROM information_schema.columns
    WHERE table_name = 'main_event_assignments'
      AND column_name = 'session_team_id';

    IF coltype IS NULL THEN
        -- Column doesn't exist yet → add it properly (TEXT)
        ALTER TABLE main_event_assignments
            ADD COLUMN session_team_id TEXT;
        -- Back-fill from shuffled_group (canonical source of truth)
        UPDATE main_event_assignments
           SET session_team_id = shuffled_group
         WHERE session_team_id IS NULL
           AND shuffled_group IS NOT NULL;
    ELSIF coltype IN ('integer','bigint','smallint','numeric') THEN
        -- Wrong type → fix by casting to text
        ALTER TABLE main_event_assignments
            ALTER COLUMN session_team_id TYPE text
            USING session_team_id::text;
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'session_team_id fix skipped: %', SQLERRM;
END $$;

-- ── 2. Detect current type of participant_id ────────────────
--    If it is INTEGER / BIGINT, we must convert to UUID.
--    If it is already UUID, the ALTER below will error on a
--    real cast, so we use a DO block with an EXCEPTION handler
--    to make it safe.
DO $$
DECLARE
    coltype text;
BEGIN
    SELECT data_type INTO coltype
    FROM information_schema.columns
    WHERE table_name = 'main_event_assignments'
      AND column_name = 'participant_id';

    IF coltype IS NULL THEN
        RAISE NOTICE 'participant_id column not found — no action needed in this migration.';
        RETURN;
    END IF;

    RAISE NOTICE 'Current participant_id type: %', coltype;

    IF coltype IN ('integer', 'bigint', 'smallint') THEN
        -- Drop any existing FK that references the wrong type
        ALTER TABLE main_event_assignments
            DROP CONSTRAINT IF EXISTS main_event_assignments_participant_id_fkey;

        -- Drop the UNIQUE constraint if present (re-added below)
        ALTER TABLE main_event_assignments
            DROP CONSTRAINT IF EXISTS main_event_assignments_participant_id_key;

        -- Widen through TEXT then cast to UUID.
        -- Step A: cast to text
        ALTER TABLE main_event_assignments
            ALTER COLUMN participant_id TYPE text
            USING participant_id::text;

        -- Step B: cast to uuid
        ALTER TABLE main_event_assignments
            ALTER COLUMN participant_id TYPE uuid
            USING participant_id::uuid;

        RAISE NOTICE 'participant_id successfully converted to UUID.';
    ELSIF coltype = 'uuid' THEN
        RAISE NOTICE 'participant_id is already UUID — no conversion needed.';
    ELSIF coltype = 'text' OR coltype = 'character varying' THEN
        -- Try to convert text to uuid (if values look like uuid)
        ALTER TABLE main_event_assignments
            DROP CONSTRAINT IF EXISTS main_event_assignments_participant_id_fkey;
        ALTER TABLE main_event_assignments
            DROP CONSTRAINT IF EXISTS main_event_assignments_participant_id_key;
        ALTER TABLE main_event_assignments
            ALTER COLUMN participant_id TYPE uuid
            USING participant_id::uuid;
        RAISE NOTICE 'participant_id converted from text → UUID.';
    ELSE
        RAISE NOTICE 'Unexpected participant_id type % — manual check required.', coltype;
    END IF;

    -- ── 3. Re-apply constraints to match canonical schema ────
    -- NOT NULL
    BEGIN
        ALTER TABLE main_event_assignments
            ALTER COLUMN participant_id SET NOT NULL;
    EXCEPTION WHEN OTHERS THEN NULL; END;

    -- UNIQUE
    BEGIN
        ALTER TABLE main_event_assignments
            ADD CONSTRAINT main_event_assignments_participant_id_key UNIQUE (participant_id);
    EXCEPTION WHEN duplicate_table THEN NULL;
    WHEN others THEN NULL; END;

    -- FOREIGN KEY → participants(id) ON DELETE CASCADE
    BEGIN
        ALTER TABLE main_event_assignments
            ADD CONSTRAINT main_event_assignments_participant_id_fkey
            FOREIGN KEY (participant_id) REFERENCES participants(id)
            ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    WHEN others THEN NULL; END;

    -- Re-create the supporting index
    CREATE INDEX IF NOT EXISTS idx_mea_participant_id
        ON main_event_assignments (participant_id);

EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Could not fully convert participant_id: %', SQLERRM;
END $$;
