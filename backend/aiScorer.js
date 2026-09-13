'use strict';

const { downloadAndReadRepo, validateRepository } = require('./lib/githubRepo');
const { GroqEvaluationProvider } = require('./lib/evaluation/groqProvider');
const { DEFAULT_MAIN_EVENT_CRITERIA } = require('./lib/evaluation/criteria');

/**
 * Backward-compatible wrapper used by older tests/callers.
 * New code should use GroqEvaluationProvider / processEvaluation.
 */
async function evaluateSubmission(assignment, criteria) {
  const provider = new GroqEvaluationProvider();
  const result = await provider.evaluateSubmission({
    assignment,
    criteria: criteria || DEFAULT_MAIN_EVENT_CRITERIA,
  });
  return {
    task_completion_score: result.scores.task_completion,
    ui_score:              result.scores.ui,
    logic_score:           result.scores.logic,
    responsiveness_score:  result.scores.responsiveness,
    creativity_score:      result.scores.creativity,
    total_score:           result.total,
    feedback:              result.feedback,
  };
}

module.exports = { evaluateSubmission, downloadAndReadRepo, validateRepository };
