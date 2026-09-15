'use strict';

const { clampScore } = require('../../middleware/sanitize');

const DEFAULT_MAIN_EVENT_CRITERIA = [
  { criterion_key: 'task_completion', name: 'Task Completion', description: 'Does the code implement the required features?', max_score: 40, weight: 1, sort_order: 1, assignment_field: 'task_match_score' },
  { criterion_key: 'ui',              name: 'UI / UX',         description: 'Is the interface clean and usable?',           max_score: 20, weight: 1, sort_order: 2, assignment_field: 'ui_score' },
  { criterion_key: 'responsiveness',  name: 'Responsiveness',  description: 'Does the layout work across screen sizes (mobile 375px, tablet 768px, desktop 1366px)?', max_score: 20, weight: 1, sort_order: 3, assignment_field: 'code_quality_score' },
  { criterion_key: 'creativity',      name: 'Creativity',      description: 'Creative enhancements and thoughtful design beyond the minimum.', max_score: 20, weight: 1, sort_order: 4, assignment_field: 'creativity_score' },
];

function maxTotal(criteria) {
  return (criteria || DEFAULT_MAIN_EVENT_CRITERIA).reduce((sum, c) => sum + Number(c.max_score || 0), 0);
}

function validateCriteriaScores(parsed, criteria) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI returned invalid JSON.');
  }

  // Alias map for robust key resolution across new structured format and legacy formats
  const ALIAS_MAP = {
    task_completion: ['task_completion_score', 'task_completion', 'task_match_score'],
    ui:              ['ui_score', 'ui', 'ui_ux'],
    responsiveness:  ['responsiveness_score', 'responsiveness', 'code_quality_score'],
    creativity:      ['creativity_score', 'creativity'],
    logic:           ['code_quality_score', 'logic_score', 'logic', 'code_quality'],
  };

  const activeCriteria = (criteria && criteria.length) ? criteria : DEFAULT_MAIN_EVENT_CRITERIA;
  const scores = {};

  for (const c of activeCriteria) {
    const possibleKeys = ALIAS_MAP[c.criterion_key] || [c.criterion_key, `${c.criterion_key}_score`];
    let raw = null;
    for (const k of possibleKeys) {
      if (parsed[k] !== undefined && parsed[k] !== null) {
        raw = parsed[k];
        break;
      }
    }
    if (raw == null) {
      // Gracefully default to 0 rather than crashing the evaluation.
      // 'logic' was removed from the rubric — always 0.
      // Other criteria: if AI omits a key despite instructions, default 0 and log.
      if (c.criterion_key !== 'logic') {
        console.warn(`[criteria] AI response missing criterion "${c.criterion_key}" — defaulting to 0`);
      }
      raw = 0;
    }
    scores[c.criterion_key] = clampScore(raw, 0, Number(c.max_score));
  }

  // Core principle: Backend strictly calculates the total from the components (never trust AI's reported total)
  const total = Object.values(scores).reduce((a, b) => a + b, 0);

  const cleanArr = (arr) => Array.isArray(arr) ? arr.slice(0, 10).map(x => typeof x === 'string' ? x.slice(0, 200) : x) : [];

  return {
    scores,
    total,
    maxTotal: maxTotal(activeCriteria),
    feedback: String(parsed.feedback || 'Repository evaluated.').slice(0, 1200),
    strengths: cleanArr(parsed.strengths),
    weaknesses: cleanArr(parsed.weaknesses),
    passed_tests: cleanArr(parsed.passed_tests),
    failed_tests: cleanArr(parsed.failed_tests),
    unverified_tests: cleanArr(parsed.unverified_tests),
    comparative_notes: cleanArr(parsed.comparative_notes),
  };
}

function toAssignmentColumns(validated, criteria) {
  const patch = {
    ai_score: validated.total,
    ai_feedback: validated.feedback,
    main_event_score: validated.total,
    logic_score: validated.scores.logic || 0,
  };
  for (const c of (criteria || DEFAULT_MAIN_EVENT_CRITERIA)) {
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
