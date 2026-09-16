-- ============================================================
-- ASTHRA 11.0 — Auth + Storage Cleanup (009)
-- ============================================================
-- PURPOSE: Wipe test users, MFA enrollments, refresh tokens,
--          and storage objects that accumulated during staging.
-- WARNING: This deletes ALL rows from auth.users and related
--          tables. Run ONLY if you are starting fresh for the
--          real event. If you have production admin accounts
--          you want to keep, edit the WHERE clauses below.
-- USAGE  : Supabase Dashboard → SQL Editor. Run AFTER 008.
-- ============================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. AUTH SCHEMA — Wipe all identities / sessions / MFA / users
-- ──────────────────────────────────────────────────────────────

-- 1a. Remove all refresh tokens (cascades are handled by FK, but
--     we truncate explicitly for clarity and speed)
TRUNCATE TABLE auth.refresh_tokens CASCADE;

-- 1b. Remove all MFA factors + challenges (must go before users)
TRUNCATE TABLE auth.mfa_challenges CASCADE;
TRUNCATE TABLE auth.mfa_factors     CASCADE;

-- 1c. Remove all one-time tokens (email confirm, recovery, etc.)
TRUNCATE TABLE auth.otps CASCADE;

-- 1d. Remove linked identities (oauth / email / phone)
TRUNCATE TABLE auth.identities CASCADE;

-- 1e. Remove all sessions (active logins)
TRUNCATE TABLE auth.sessions CASCADE;

-- 1f. Remove ALL Supabase Auth users
--     NOTE: If you want to KEEP a specific admin user, add:
--           WHERE email NOT IN ('admin@yourdomain.com')
DELETE FROM auth.users
-- WHERE email NOT IN ('keep-this-account@example.com')
;

-- 1g. Audit and reset auth user id sequences
DO $$
DECLARE
    seq record;
BEGIN
    FOR seq IN
        SELECT s.relname AS seq_name, n.nspname AS schema_name
        FROM pg_class s
        JOIN pg_namespace n ON n.oid = s.relnamespace
        WHERE s.relkind = 'S'
          AND n.nspname = 'auth'
          AND s.relname LIKE '%_seq'
    LOOP
        BEGIN
            EXECUTE format('ALTER SEQUENCE %I.%I RESTART WITH 1', seq.schema_name, seq.seq_name);
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Skipped auth sequence %: %', seq.seq_name, SQLERRM;
        END;
    END LOOP;
END $$;

-- ──────────────────────────────────────────────────────────────
-- 2. STORAGE SCHEMA — Wipe test uploads / buckets
-- ──────────────────────────────────────────────────────────────

-- 2a. Delete all uploaded objects (must go before buckets)
TRUNCATE TABLE storage.objects CASCADE;

-- 2b. Optionally drop non-default buckets.
--     Uncomment only if you created test buckets during staging:
--
-- DELETE FROM storage.buckets
--  WHERE name NOT IN ('default_bucket_that_you_need');

-- ──────────────────────────────────────────────────────────────
-- 3. POSTGRES JOB SCHEDULER (pg_cron / pgjwt leftovers)
-- ──────────────────────────────────────────────────────────────

-- Drop any leftover cron jobs (if pg_cron is enabled and jobs exist)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'cron' AND table_name = 'job'
    ) THEN
        EXECUTE 'TRUNCATE TABLE cron.job CASCADE';
        EXECUTE 'TRUNCATE TABLE cron.job_run_details CASCADE';
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron cleanup skipped (schema missing): %', SQLERRM;
END $$;

-- ──────────────────────────────────────────────────────────────
-- 4. REAL-TIME / REPLICATION SLOTS — reset publication config
-- ──────────────────────────────────────────────────────────────

-- Drop any accidental publications for tables that have been wiped
DO $$
DECLARE
    pub record;
BEGIN
    FOR pub IN
        SELECT pubname
        FROM pg_publication
        WHERE pubname NOT IN ('supabase_realtime')
    LOOP
        BEGIN
            EXECUTE format('DROP PUBLICATION IF EXISTS %I', pub.pubname);
            RAISE NOTICE 'Dropped leftover publication: %', pub.pubname;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Could not drop pub %: %', pub.pubname, SQLERRM;
        END;
    END LOOP;
END $$;

-- ──────────────────────────────────────────────────────────────
-- 5. FINAL VACUUM ANALYZE on heavily-updated tables
--    (REINDEX helps query planner after bulk DELETEs)
-- ──────────────────────────────────────────────────────────────

ANALYZE teams;
ANALYZE participants;
ANALYZE main_event_assignments;
ANALYZE fizzbuzz_submissions_v2;
ANALYZE code_imposter_submissions;
ANALYZE manual_event_scores_v2;
ANALYZE evaluations;
ANALYZE score_events;
ANALYZE competitive_evaluation_pairs;
ANALYZE audit_log;
ANALYZE admin_sessions;
ANALYZE event_timers;
ANALYZE shuffle_lock;
ANALYZE event_state;
ANALYZE game_config;
ANALYZE evaluation_criteria;
ANALYZE main_event_tasks;

-- 5b. Try REINDEX ( harmless; may fail inside a transaction on PG <12 — safe to ignore errors )
DO $$
BEGIN
    REINDEX TABLE public.teams;
    REINDEX TABLE public.participants;
    REINDEX TABLE public.main_event_assignments;
    REINDEX TABLE public.audit_log;
    REINDEX TABLE public.score_events;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'REINDEX skipped (harmless — run VACUUM ANALYZE manually if desired): %', SQLERRM;
END $$;

-- ──────────────────────────────────────────────────────────────
-- 6. POST-CLEANUP VERIFICATION REPORT
-- ──────────────────────────────────────────────────────────────

DO $$
DECLARE
    cnt_auth_users  bigint; cnt_auth_sess   bigint; cnt_auth_idents bigint;
    cnt_storage_obj bigint;
    msg text;
BEGIN
    SELECT count(*) INTO cnt_auth_users  FROM auth.users;
    SELECT count(*) INTO cnt_auth_sess   FROM auth.sessions;
    SELECT count(*) INTO cnt_auth_idents FROM auth.identities;
    SELECT count(*) INTO cnt_storage_obj FROM storage.objects;

    msg := format(
        E'[EVENT-READY AUTH+STORAGE] Cleaned ✓\n'
        '  auth.users       = %s\n'
        '  auth.sessions    = %s\n'
        '  auth.identities  = %s\n'
        '  storage.objects  = %s\n'
        '  All sequences reset, tables analyzed.',
        cnt_auth_users, cnt_auth_sess, cnt_auth_idents, cnt_storage_obj
    );
    RAISE NOTICE '%', msg;
END $$;

COMMIT;
