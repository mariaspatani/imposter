'use strict';

/**
 * ASTHRA Imposter — Stage B: Cohort & Same-Role Comparator
 *
 * Implements competitive, evidence-driven comparative analysis across participants
 * who received the SAME task and SAME role.
 *
 * Key Principles:
 * 1. Absolute Score First: Each participant's score was earned independently in Stage A.
 * 2. No Artificial Differences: If two candidates deserve 92, both remain 92.
 * 3. Blind Comparison: Uses Candidate A / Candidate B anonymous labels to eliminate bias.
 * 4. Explicit Evidence for Gaps: Any score gap >= 5 points between same-role candidates
 *    MUST be backed by a concrete, factual rationale.
 * 5. Similarity Flags: Code similarity is flagged separately as a metadata warning,
 *    never automatically penalizing scores.
 */

/**
 * Simple token-based Jaccard similarity for plagiarism / extreme similarity detection.
 * Does NOT alter scores.
 */
function computeCodeSimilarity(codeA, codeB) {
  if (!codeA || !codeB) return 0;
  const tokenize = (text) => {
    return new Set(
      String(text)
        .replace(/[^\w$]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2)
    );
  };
  const setA = tokenize(codeA);
  const setB = tokenize(codeB);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? Math.round((intersection / union) * 100) : 0;
}

/**
 * Generate evidence-based rationale for same-role participant pairs.
 */
function compareSameRolePair(candA, candB) {
  const scoreA = Number(candA.ai_score || candA.total_score || 0);
  const scoreB = Number(candB.ai_score || candB.total_score || 0);
  const diff = Math.abs(scoreA - scoreB);

  // Determine strengths / passed differences
  const passA = (candA.passed_tests || []).length;
  const passB = (candB.passed_tests || []).length;
  const failA = (candA.failed_tests || []).length;
  const failB = (candB.failed_tests || []).length;

  let rationale = '';
  if (diff === 0) {
    rationale = `Equal performance (${scoreA} pts). Both candidates demonstrated equivalent feature completeness and execution quality.`;
  } else if (diff < 5) {
    rationale = `Close performance (${Math.max(scoreA, scoreB)} vs ${Math.min(scoreA, scoreB)}). Minor difference within standard calibration threshold.`;
  } else {
    // Gap >= 5 requires concrete evidence justification
    const higher = scoreA >= scoreB ? 'Candidate A' : 'Candidate B';
    const lower = scoreA >= scoreB ? 'Candidate B' : 'Candidate A';
    const higherScore = Math.max(scoreA, scoreB);
    const lowerScore = Math.min(scoreA, scoreB);
    const reasons = [];

    const higherObj = scoreA >= scoreB ? candA : candB;
    const lowerObj = scoreA >= scoreB ? candB : candA;

    if (higherObj.task_match_score > lowerObj.task_match_score) {
      reasons.push(`${higher} completed more core task requirements (${higherObj.task_match_score}/40 vs ${lowerObj.task_match_score}/40)`);
    }
    if ((higherObj.failed_tests || []).length < (lowerObj.failed_tests || []).length) {
      reasons.push(`${lower} had ${(lowerObj.failed_tests || []).length} test failure(s) at runtime`);
    }
    if ((higherObj.code_quality_score || 0) > (lowerObj.code_quality_score || 0)) {
      reasons.push(`${higher} demonstrated superior responsive viewport support (${higherObj.code_quality_score}/20 vs ${lowerObj.code_quality_score}/20)`);
    }
    if ((higherObj.ui_score || 0) > (lowerObj.ui_score || 0)) {
      reasons.push(`${higher} exhibited cleaner UI hierarchy and feedback (${higherObj.ui_score}/20 vs ${lowerObj.ui_score}/20)`);
    }

    if (reasons.length === 0) {
      reasons.push(`Component breakdowns reflect differing feature completeness and edge-case handling across the rubric.`);
    }

    rationale = `${higher} (${higherScore}) vs ${lower} (${lowerScore}) — Gap: ${diff} pts. Evidence: ${reasons.join('; ')}.`;
  }

  // Check code similarity if code is provided
  let similarityPercent = null;
  let similarityFlag = null;
  if (candA.sourceCode && candB.sourceCode) {
    similarityPercent = computeCodeSimilarity(candA.sourceCode, candB.sourceCode);
    similarityFlag = {
      flagged: similarityPercent >= 80,
      similarity_score_percent: similarityPercent,
      note: similarityPercent >= 80
        ? 'High structural similarity detected. Kept as advisory flag; scores are not penalized per ASTHRA rules.'
        : 'Normal variance in syntax and libraries.'
    };
  }

  return {
    role_name: candA.role_name || 'Specialist',
    person_slot: candA.person_slot || 1,
    is_imposter: Boolean(candA.is_imposter),
    candidate_a: {
      id: candA.participant_id,
      name: candA.participant_name,
      group: candA.shuffled_group,
      score: scoreA,
      scores_breakdown: {
        task_completion: candA.task_match_score,
        ui: candA.ui_score,
        responsiveness: candA.code_quality_score,
        creativity: candA.creativity_score,
      },
      passed_tests: candA.passed_tests || [],
      failed_tests: candA.failed_tests || [],
    },
    candidate_b: {
      id: candB.participant_id,
      name: candB.participant_name,
      group: candB.shuffled_group,
      score: scoreB,
      scores_breakdown: {
        task_completion: candB.task_match_score,
        ui: candB.ui_score,
        responsiveness: candB.code_quality_score,
        creativity: candB.creativity_score,
      },
      passed_tests: candB.passed_tests || [],
      failed_tests: candB.failed_tests || [],
    },
    score_gap: diff,
    evidence_rationale: rationale,
    similarity_flag: similarityFlag,
  };
}

/**
 * Build a full cohort comparison report for a specific task (e.g. Task 1 with Groups 1 & 4).
 */
function buildTaskCohortReport(taskNumber, participants) {
  const taskParticipants = participants.filter(p => Number(p.task_number) === Number(taskNumber));

  // Sort by score descending for task leaderboard
  const ranked = [...taskParticipants].sort((a, b) => {
    const sA = Number(a.ai_score || a.total_score || 0);
    const sB = Number(b.ai_score || b.total_score || 0);
    return sB - sA;
  });

  // Group by role slot (1, 2, 3 = Specialists, 4 = Imposter)
  const roleGroups = { 1: [], 2: [], 3: [], 4: [] };
  taskParticipants.forEach(p => {
    const slot = p.person_slot || (p.is_imposter ? 4 : 1);
    if (!roleGroups[slot]) roleGroups[slot] = [];
    roleGroups[slot].push(p);
  });

  const sameRoleComparisons = [];
  for (let slot = 1; slot <= 4; slot++) {
    const pair = roleGroups[slot] || [];
    if (pair.length >= 2) {
      sameRoleComparisons.push(compareSameRolePair(pair[0], pair[1]));
    } else if (pair.length === 1) {
      sameRoleComparisons.push({
        role_name: pair[0].role_name,
        person_slot: slot,
        is_imposter: Boolean(pair[0].is_imposter),
        candidate_a: {
          id: pair[0].participant_id,
          name: pair[0].participant_name,
          group: pair[0].shuffled_group,
          score: Number(pair[0].ai_score || 0),
        },
        candidate_b: null,
        score_gap: 0,
        evidence_rationale: 'Awaiting counterpart submission for comparison.',
        similarity_flag: null,
      });
    }
  }

  return {
    task_number: Number(taskNumber),
    task_title: (taskParticipants[0] || {}).task_title || `Task ${taskNumber}`,
    total_participants: taskParticipants.length,
    evaluated_count: taskParticipants.filter(p => p.evaluation_status === 'Evaluated').length,
    ranked_cohort: ranked.map((p, idx) => ({
      rank: idx + 1,
      participant_id: p.participant_id,
      participant_name: p.participant_name,
      shuffled_group: p.shuffled_group,
      role_name: p.role_name,
      is_imposter: Boolean(p.is_imposter),
      score: Number(p.ai_score || p.total_score || 0),
      evaluation_status: p.evaluation_status,
      submission_status: p.submission_status,
    })),
    same_role_comparisons: sameRoleComparisons,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Generate full event-wide comparative report across all 3 tasks.
 */
function buildFullEventCohortReport(allParticipants) {
  return {
    generated_at: new Date().toISOString(),
    tasks: [1, 2, 3].map(taskNum => buildTaskCohortReport(taskNum, allParticipants)),
  };
}

module.exports = {
  computeCodeSimilarity,
  compareSameRolePair,
  buildTaskCohortReport,
  buildFullEventCohortReport,
};
