-- ============================================================
-- ASTHRA 11.0 — Migration 010: Add fizzbuzz column to v2 scores
-- ============================================================
-- manual_event_scores_v2 is a FLAT table keyed by original_team.
-- Event rounds: Code Imposter, Sherlock Holmes, Drawing, + FizzBuzz.
-- Admin UI /api/admin/save-fizzbuzz-score writes to this column
-- after this migration runs.
-- ============================================================

ALTER TABLE manual_event_scores_v2
  ADD COLUMN IF NOT EXISTS fizzbuzz INTEGER NOT NULL DEFAULT 0;

ANALYZE manual_event_scores_v2;
