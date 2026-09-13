-- ============================================================
-- ASTHRA 2K26 IMPOSTER — Runtime Evaluation Enhancement
-- Additive migration for runtime evaluation support
-- Safe to run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS
-- ============================================================

-- Add runtime_evidence column to evaluations table for storing
-- browser automation evidence (screenshots, console errors, DOM tests)
ALTER TABLE evaluations
  ADD COLUMN IF NOT EXISTS runtime_evidence JSONB;

-- Update status values to include runtime-specific states
-- Note: TEXT columns don't have ENUM, so we document valid values in comments
-- Valid status values:
-- NOT_STARTED, PROCESSING, COMPLETED, FAILED,
-- RUNTIME_UNAVAILABLE, RUNTIME_PROCESSING, RUNTIME_COMPLETED, RUNTIME_FAILED

-- Add index for runtime-related queries if needed
CREATE INDEX IF NOT EXISTS idx_evaluations_status_runtime ON evaluations(status) 
WHERE status IN ('RUNTIME_UNAVAILABLE', 'RUNTIME_PROCESSING', 'RUNTIME_COMPLETED', 'RUNTIME_FAILED');

-- Add runtime_evidence column to main_event_assignments for consistency
ALTER TABLE main_event_assignments
  ADD COLUMN IF NOT EXISTS runtime_evidence JSONB;

-- Add runtime_mode column to track evaluation mode (FULL_RUNTIME, STATIC_ONLY, FAILED)
ALTER TABLE main_event_assignments
  ADD COLUMN IF NOT EXISTS runtime_mode TEXT;