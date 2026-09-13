-- ============================================================
-- ASTHRA 2K26 IMPOSTER — RLS Policies for Missing Tables
-- Run this in Supabase Dashboard → SQL Editor
-- This allows the backend (anon/service key) to read/write
-- all event tables. The backend itself enforces authorization.
-- ============================================================

-- Disable RLS entirely on these tables — the backend enforces
-- all security (admin tokens, participant UUIDs, etc.)
-- This is appropriate for a private backend-owned database.

ALTER TABLE shuffle_lock              DISABLE ROW LEVEL SECURITY;
ALTER TABLE fizzbuzz_submissions_v2   DISABLE ROW LEVEL SECURITY;
ALTER TABLE code_imposter_submissions DISABLE ROW LEVEL SECURITY;
ALTER TABLE manual_event_scores_v2    DISABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions            DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log                 DISABLE ROW LEVEL SECURITY;

-- Also disable RLS on the original tables in case they have it
ALTER TABLE teams                     DISABLE ROW LEVEL SECURITY;
ALTER TABLE participants              DISABLE ROW LEVEL SECURITY;
ALTER TABLE main_event_tasks          DISABLE ROW LEVEL SECURITY;
ALTER TABLE main_event_assignments    DISABLE ROW LEVEL SECURITY;
ALTER TABLE event_timers              DISABLE ROW LEVEL SECURITY;
