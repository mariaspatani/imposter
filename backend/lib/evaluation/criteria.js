'use strict';

const { clampScore } = require('../../middleware/sanitize');

const DEFAULT_MAIN_EVENT_CRITERIA = [
  { criterion_key: 'task_completion', name: 'Task Completion', description: 'Does the code implement the required features?', max_score: 40, weight: 1, sort_order: 1, assignment_field: 'task_match_score' },
  { criterion_key: 'ui',              name: 'UI / UX',         description: 'Is the interface clean and usable?',           max_score: 20, weight: 1, sort_order: 2, assignment_field: 'ui_score' },
  { criterion_key: 'logic',           name: 'Code Quality',    description: 'Is the logic correct and structured?',         max_score: 20, weight: 1, sort_order: 3, assignment_field: 'logic_score' },
  { criterion_key: 'responsiveness',  name: 'Responsiveness',  description: 'Does the layout work across screen sizes?',    max_score: 10, weight: 1, sort_order: 4, assignment_field: 'code_quality_score' },
  { criterion_key: 'creativity',      name: 'Creativity',      description: 'Creative enhancements beyond the minimum.',    max_score: 10, weight: 1, sort_order: 5, assignment_field: 'creativity_score' },
];

function maxTotal(criteria) {
  return (criteria || []).reduce((sum, c) => sum + Number(c.max_score || 0), 0);
}

function validateCriteriaScores(parsed, criteria) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI returned invalid JSON.');
  }
  const scores = {};
  for (const c of criteria) {
    const raw = parsed[c.criterion_key];
    if (raw == null) {
      throw new Error(`AI response missing criterion "${c.criterion_key}".`);
    }
    scores[c.criterion_key] = clampScore(raw, 0, Number(c.max_score));
  }
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  return {
    scores,
    total,
    maxTotal: maxTotal(criteria),
    feedback: String(parsed.feedback || 'Repository evaluated.').slice(0, 1200),
  };
}

function toAssignmentColumns(validated, criteria) {
  const patch = {
    ai_score: validated.total,
    ai_feedback: validated.feedback,
    main_event_score: validated.total,
  };
  for (const c of criteria) {
    if (c.assignment_field) patch[c.assignment_field] = validated.scores[c.criterion_key];
  }
  return patch;
}

function evaluationState(dbStatus) {
  const map = {
    Pending: 'NOT_STARTED',
    Queued: 'QUEUED',
    Evaluating: 'PROCESSING',
    Processing: 'PROCESSING',
    Evaluated: 'COMPLETED',
    Completed: 'COMPLETED',
    Failed: 'FAILED',
    Submitted: 'SUBMITTED',
    RuntimeEvaluationUnavailable: 'RUNTIME_UNAVAILABLE',
    RuntimeEvaluating: 'RUNTIME_PROCESSING',
    RuntimeEvaluated: 'RUNTIME_COMPLETED',
    RuntimeFailed: 'RUNTIME_FAILED',
  };
  return map[dbStatus] || 'NOT_STARTED';
}

module.exports = {
  DEFAULT_MAIN_EVENT_CRITERIA,
  maxTotal,
  validateCriteriaScores,
  toAssignmentColumns,
  evaluationState,
};
