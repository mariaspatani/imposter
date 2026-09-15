'use strict';

const { GroqEvaluationProvider } = require('./groqProvider');
const { DEFAULT_MAIN_EVENT_CRITERIA, validateCriteriaScores, toAssignmentColumns } = require('./criteria');
const { TYPES, recordScoreEvent } = require('../scoring');
const { downloadAndReadRepo } = require('../githubRepo');
const { getRuntimeEvaluator } = require('./runtimeEvaluator');

const STALE_EVAL_MS = 3 * 60 * 1000; // 3 minutes stale lock window

/**
 * Maps assignments to the 12 canonical competition pairs:
 * 3 tasks × 4 roles = 12 comparison pairs.
 */
function build12AuthoritativePairs(assignments) {
  const pairs = [];
  const taskGroupMap = {
    1: { primary: 'Group 1', secondary: 'Group 4' },
    2: { primary: 'Group 2', secondary: 'Group 5' },
    3: { primary: 'Group 3', secondary: 'Group 6' },
  };

  for (let taskNum = 1; taskNum <= 3; taskNum++) {
    const taskAssignments = (assignments || []).filter(a => Number(a.task_number) === taskNum);
    const primaryGroupName = taskGroupMap[taskNum].primary;
    const secondaryGroupName = taskGroupMap[taskNum].secondary;

    for (let slot = 1; slot <= 4; slot++) {
      const candA = taskAssignments.find(a => a.person_slot === slot && a.shuffled_group === primaryGroupName) ||
                    taskAssignments.filter(a => a.person_slot === slot)[0] || null;
      const candB = taskAssignments.find(a => a.person_slot === slot && a.shuffled_group === secondaryGroupName) ||
                    taskAssignments.filter(a => a.person_slot === slot)[1] || null;

      const isImp = slot === 4;
      const roleName = candA?.role_name || candB?.role_name || (isImp ? 'Imposter' : `Specialist ${slot}`);

      pairs.push({
        task_number: taskNum,
        person_slot: slot,
        role_name: roleName,
        is_imposter: isImp,
        participant_a: candA,
        participant_b: candB,
        participant_a_id: candA?.participant_id || null,
        participant_b_id: candB?.participant_id || null,
      });
    }
  }

  return pairs;
}

/**
 * Computes pair status based on submission presence and current state.
 */
function computePairStatus(candA, candB, currentDbStatus) {
  if (currentDbStatus === 'EVALUATED') return 'EVALUATED';
  if (currentDbStatus === 'EVALUATING') return 'EVALUATING';
  if (currentDbStatus === 'NEEDS_RECOVERY') return 'NEEDS_RECOVERY';

  const hasSubA = Boolean(candA && candA.github_repo);
  const hasSubB = Boolean(candB && candB.github_repo);

  if (hasSubA && hasSubB) return 'READY';
  return 'WAITING_FOR_BOTH';
}

/**
 * Idempotently syncs/upserts the 12 canonical pairs into competitive_evaluation_pairs.
 */
async function syncPairsWithDatabase(supabase, assignments) {
  const authoritativePairs = build12AuthoritativePairs(assignments);

  // Fetch existing rows
  let existingRows = [];
  try {
    const { data } = await supabase.from('competitive_evaluation_pairs').select('*');
    existingRows = data || [];
  } catch (_) {}

  const existingMap = {};
  existingRows.forEach(r => { existingMap[`${r.task_number}_${r.person_slot}`] = r; });

  const syncedPairs = [];
  for (const pair of authoritativePairs) {
    if (!pair.participant_a_id || !pair.participant_b_id) continue;

    const existing = existingMap[`${pair.task_number}_${pair.person_slot}`];
    const initialStatus = computePairStatus(
      pair.participant_a,
      pair.participant_b,
      existing ? existing.status : null
    );

    const row = {
      task_number: pair.task_number,
      person_slot: pair.person_slot,
      role_name: pair.role_name,
      is_imposter: pair.is_imposter,
      participant_a_id: pair.participant_a_id,
      participant_b_id: pair.participant_b_id,
      status: existing ? (existing.status === 'EVALUATED' ? 'EVALUATED' : initialStatus) : initialStatus,
      updated_at: new Date().toISOString(),
    };

    try {
      const { data: upserted } = await supabase
        .from('competitive_evaluation_pairs')
        .upsert(row, { onConflict: 'task_number,person_slot' })
        .select('*')
        .maybeSingle();
      const finalObj = upserted || { ...existing, ...row };
      finalObj.participant_a = pair.participant_a;
      finalObj.participant_b = pair.participant_b;
      syncedPairs.push(finalObj);
    } catch (_) {
      const finalObj = existing ? { ...existing, ...row } : row;
      finalObj.participant_a = pair.participant_a;
      finalObj.participant_b = pair.participant_b;
      syncedPairs.push(finalObj);
    }
  }

  return syncedPairs;
}

/**
 * Validates the raw JSON output from Groq pairwise evaluation.
 * Backend strictly computes component sums for both participants.
 */
function validatePairwiseScores(rawParsed, criteria = DEFAULT_MAIN_EVENT_CRITERIA) {
  if (!rawParsed || typeof rawParsed !== 'object') {
    throw new Error('Pairwise evaluation returned invalid JSON object.');
  }
  if (!rawParsed.participant_a || !rawParsed.participant_b) {
    throw new Error('Pairwise output missing participant_a or participant_b.');
  }

  const partA = validateCriteriaScores(rawParsed.participant_a, criteria);
  const partB = validateCriteriaScores(rawParsed.participant_b, criteria);

  const comparison = rawParsed.comparison || {};

  return {
    participant_a: partA,
    participant_b: partB,
    comparison: {
      overall_comparison: String(comparison.overall_comparison || 'Pair evaluated concurrently.').slice(0, 1500),
      meaningful_differences: Array.isArray(comparison.meaningful_differences)
        ? comparison.meaningful_differences.slice(0, 10).map(d => String(d).slice(0, 300))
        : [],
      similarities_that_should_not_affect_score: Array.isArray(comparison.similarities_that_should_not_affect_score)
        ? comparison.similarities_that_should_not_affect_score.slice(0, 10).map(s => String(s).slice(0, 300))
        : [],
    },
  };
}

/**
 * Orchestrates evaluation of a specific pair by ID.
 * Implements atomic lock against concurrency, evidence reuse, and database persistence.
 */
async function evaluatePairById(supabase, pairRecordId, options = {}) {
  // Step 1: Fetch pair from DB
  const { data: pair, error: pairErr } = await supabase
    .from('competitive_evaluation_pairs')
    .select('*')
    .eq('id', pairRecordId)
    .maybeSingle();

  if (pairErr || !pair) throw new Error('Evaluation pair not found: ' + (pairErr?.message || ''));

  // Concurrency Guard: Check if actively evaluating within stale threshold
  const lockTime = pair.started_at || pair.updated_at;
  const startedAt = lockTime ? new Date(lockTime).getTime() : 0;
  if (pair.status === 'EVALUATING' && startedAt && (Date.now() - startedAt) < STALE_EVAL_MS && !options.force) {
    return {
      success: false,
      in_progress: true,
      status: 'EVALUATING',
      message: 'Pair is currently being evaluated in another worker.',
    };
  }

  // If already evaluated and not retrying
  if (pair.status === 'EVALUATED' && !options.retry && !options.force) {
    return {
      success: true,
      already_evaluated: true,
      status: 'EVALUATED',
      evaluation_result: pair.evaluation_result,
    };
  }

  // Step 2: Fetch both participant assignments
  const [asgnResA, asgnResB] = await Promise.all([
    supabase.from('main_event_assignments').select('*').eq('participant_id', pair.participant_a_id).maybeSingle(),
    supabase.from('main_event_assignments').select('*').eq('participant_id', pair.participant_b_id).maybeSingle(),
  ]);

  const asgnA = asgnResA.data;
  const asgnB = asgnResB.data;

  if (!asgnA || !asgnB) throw new Error('Missing assignment records for pair participants.');

  // Guard: Verify both have submitted repositories
  if (!asgnA.github_repo || !asgnB.github_repo) {
    await supabase.from('competitive_evaluation_pairs')
      .update({ status: 'WAITING_FOR_BOTH', updated_at: new Date().toISOString() })
      .eq('id', pair.id);
    return {
      success: false,
      status: 'WAITING_FOR_BOTH',
      message: 'Cannot evaluate pair until both participants have submitted their GitHub repositories.',
    };
  }

  // Step 3: Atomic Lock
  const nowIso = new Date().toISOString();
  await supabase.from('competitive_evaluation_pairs')
    .update({ status: 'EVALUATING', started_at: nowIso, error_message: null })
    .eq('id', pair.id);

  // Step 4: Gather evidence for Candidate A and Candidate B
  try {
    // Reuse existing runtime evidence if available from evaluations table
    const [evalResA, evalResB] = await Promise.all([
      supabase.from('evaluations').select('runtime_evidence').eq('participant_id', pair.participant_a_id).maybeSingle(),
      supabase.from('evaluations').select('runtime_evidence').eq('participant_id', pair.participant_b_id).maybeSingle(),
    ]);

    let runtimeEvidenceA = evalResA.data?.runtime_evidence || null;
    let runtimeEvidenceB = evalResB.data?.runtime_evidence || null;

    // Download source code
    const [sourceCodeA, sourceCodeB] = await Promise.all([
      downloadAndReadRepo(asgnA.github_repo),
      downloadAndReadRepo(asgnB.github_repo),
    ]);

    // Optional runtime fallback
    const runtimeEvaluator = getRuntimeEvaluator();
    if (!runtimeEvidenceA && runtimeEvaluator.isAvailable()) {
      try { runtimeEvidenceA = await runtimeEvaluator.evaluate({ assignment: asgnA, sourceCode: sourceCodeA }); } catch (_) {}
    }
    if (!runtimeEvidenceB && runtimeEvaluator.isAvailable()) {
      try { runtimeEvidenceB = await runtimeEvaluator.evaluate({ assignment: asgnB, sourceCode: sourceCodeB }); } catch (_) {}
    }

    // Step 5: Secure secret objective lookup for Imposter pairs
    let secretObjective = null;
    if (pair.is_imposter && pair.task_number) {
      try {
        const { data: taskRow } = await supabase
          .from('main_event_tasks')
          .select('person4_secret')
          .eq('task_number', pair.task_number)
          .maybeSingle();
        secretObjective = taskRow?.person4_secret || null;
      } catch (_) {}
    }

    // Step 6: Groq Pairwise Evaluation Call
    const provider = options.provider || new GroqEvaluationProvider();
    const criteria = options.criteria || DEFAULT_MAIN_EVENT_CRITERIA;

    const rawResult = await provider.evaluatePairwiseSubmission({
      taskTitle: asgnA.task_title || asgnB.task_title,
      taskDescription: asgnA.task_description || asgnB.task_description,
      roleName: pair.role_name,
      workDescription: asgnA.work_description || asgnB.work_description,
      isImposter: pair.is_imposter,
      secretObjective,
      candidateA: {
        id: asgnA.participant_id,
        sourceCode: sourceCodeA,
        runtimeEvidence: runtimeEvidenceA,
      },
      candidateB: {
        id: asgnB.participant_id,
        sourceCode: sourceCodeB,
        runtimeEvidence: runtimeEvidenceB,
      },
      criteria,
    });

    const validated = validatePairwiseScores(rawResult, criteria);

    // Step 7: Update Candidate A in main_event_assignments and record ledger
    const patchA = toAssignmentColumns(validated.participant_a, criteria);
    const fizzA = Number(asgnA.fizzbuzz_score || 0);
    await supabase.from('main_event_assignments')
      .update({
        ...patchA,
        total_score: Number(patchA.main_event_score || 0) + fizzA,
        evaluation_status: 'Evaluated',
        submission_status: 'Evaluated',
      })
      .eq('participant_id', pair.participant_a_id);

    // Step 8: Update Candidate B in main_event_assignments and record ledger
    const patchB = toAssignmentColumns(validated.participant_b, criteria);
    const fizzB = Number(asgnB.fizzbuzz_score || 0);
    await supabase.from('main_event_assignments')
      .update({
        ...patchB,
        total_score: Number(patchB.main_event_score || 0) + fizzB,
        evaluation_status: 'Evaluated',
        submission_status: 'Evaluated',
      })
      .eq('participant_id', pair.participant_b_id);

    // Record score events idempotently
    try {
      await recordScoreEvent(supabase, {
        gameId: 'main_event',
        participantId: pair.participant_a_id,
        originalTeamId: asgnA.original_team_id || null,
        originalTeamName: asgnA.original_team,
        sessionTeamId: asgnA.shuffled_group,
        points: validated.participant_a.total,
        reason: 'Pairwise competitive AI evaluation',
        type: TYPES.INDIVIDUAL_SCORE,
        idempotencyKey: `pairwise:${pair.id}:${pair.participant_a_id}`,
      });
      await recordScoreEvent(supabase, {
        gameId: 'main_event',
        participantId: pair.participant_b_id,
        originalTeamId: asgnB.original_team_id || null,
        originalTeamName: asgnB.original_team,
        sessionTeamId: asgnB.shuffled_group,
        points: validated.participant_b.total,
        reason: 'Pairwise competitive AI evaluation',
        type: TYPES.INDIVIDUAL_SCORE,
        idempotencyKey: `pairwise:${pair.id}:${pair.participant_b_id}`,
      });
    } catch (_) {}

    // Step 9: Finalize pair status in competitive_evaluation_pairs
    const finalResult = {
      completed_at: new Date().toISOString(),
      participant_a: {
        id: pair.participant_a_id,
        name: asgnA.participant_name,
        group: asgnA.shuffled_group,
        scores: validated.participant_a.scores,
        total_score: validated.participant_a.total,
        feedback: validated.participant_a.feedback,
        strengths: validated.participant_a.strengths,
        weaknesses: validated.participant_a.weaknesses,
        passed_tests: validated.participant_a.passed_tests,
        failed_tests: validated.participant_a.failed_tests,
        unverified_tests: validated.participant_a.unverified_tests,
      },
      participant_b: {
        id: pair.participant_b_id,
        name: asgnB.participant_name,
        group: asgnB.shuffled_group,
        scores: validated.participant_b.scores,
        total_score: validated.participant_b.total,
        feedback: validated.participant_b.feedback,
        strengths: validated.participant_b.strengths,
        weaknesses: validated.participant_b.weaknesses,
        passed_tests: validated.participant_b.passed_tests,
        failed_tests: validated.participant_b.failed_tests,
        unverified_tests: validated.participant_b.unverified_tests,
      },
      comparison: validated.comparison,
    };

    await supabase.from('competitive_evaluation_pairs')
      .update({
        status: 'EVALUATED',
        completed_at: new Date().toISOString(),
        evaluation_result: finalResult,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', pair.id);

    return {
      success: true,
      status: 'EVALUATED',
      pair_id: pair.id,
      evaluation_result: finalResult,
    };

  } catch (err) {
    const errMsg = err?.message || 'Pairwise evaluation failed.';
    console.error(`[PairwiseEvaluator] Pair ${pair.id} failed:`, errMsg);

    await supabase.from('competitive_evaluation_pairs')
      .update({
        status: 'NEEDS_RECOVERY',
        error_message: errMsg.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq('id', pair.id);

    return {
      success: false,
      status: 'NEEDS_RECOVERY',
      message: 'Pairwise evaluation failed and marked for recovery: ' + errMsg,
    };
  }
}

/**
 * Runs evaluation for all pairs that are in READY state.
 */
async function evaluateAllReadyPairs(supabase, options = {}) {
  // Fetch all pairs
  const { data: pairs, error } = await supabase
    .from('competitive_evaluation_pairs')
    .select('*')
    .in('status', ['READY', 'NEEDS_RECOVERY']);

  if (error || !pairs || pairs.length === 0) {
    return { success: true, count: 0, message: 'No ready pairs to evaluate.' };
  }

  const results = [];
  for (const p of pairs) {
    const res = await evaluatePairById(supabase, p.id, options);
    results.push({ pair_id: p.id, role: p.role_name, ...res });
  }

  return {
    success: true,
    total_ready: pairs.length,
    evaluated_count: results.filter(r => r.status === 'EVALUATED').length,
    results,
  };
}

module.exports = {
  build12AuthoritativePairs,
  computePairStatus,
  syncPairsWithDatabase,
  validatePairwiseScores,
  evaluatePairById,
  evaluateAllReadyPairs,
};
