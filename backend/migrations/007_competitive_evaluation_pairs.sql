-- ============================================================================
-- ASTHRA IMPOSTER — Migration 007: Competitive Evaluation Pairs
-- Minimal additive table for Stage B Pairwise Evaluations (12 pairs total)
-- ============================================================================

CREATE TABLE IF NOT EXISTS competitive_evaluation_pairs (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    task_number        INTEGER      NOT NULL,
    person_slot        INTEGER      NOT NULL,
    role_name          TEXT         NOT NULL,
    is_imposter        BOOLEAN      NOT NULL DEFAULT FALSE,
    participant_a_id   UUID         NOT NULL,
    participant_b_id   UUID         NOT NULL,
    status             TEXT         NOT NULL DEFAULT 'WAITING_FOR_BOTH',
    evaluation_result  JSONB,
    started_at         TIMESTAMPTZ,
    completed_at       TIMESTAMPTZ,
    error_message      TEXT,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (task_number, person_slot)
);

CREATE INDEX IF NOT EXISTS idx_cep_status ON competitive_evaluation_pairs (status);
CREATE INDEX IF NOT EXISTS idx_cep_task_slot ON competitive_evaluation_pairs (task_number, person_slot);
