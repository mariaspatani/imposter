'use strict';

/**
 * @typedef {Object} EvaluationInput
 * @property {object} assignment
 * @property {string} sourceCode
 * @property {Array} criteria
 */

/**
 * @typedef {Object} EvaluationResult
 * @property {Record<string, number>} scores
 * @property {number} total
 * @property {number} maxTotal
 * @property {string} feedback
 */

/**
 * @interface EvaluationProvider
 * evaluateSubmission(input: EvaluationInput): Promise<EvaluationResult>
 */

class EvaluationProvider {
  async evaluateSubmission(_input) {
    throw new Error('EvaluationProvider.evaluateSubmission must be implemented.');
  }
}

module.exports = { EvaluationProvider };
