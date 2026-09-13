'use strict';

const { GroqEvaluationProvider } = require('./groqProvider');
const { DEFAULT_MAIN_EVENT_CRITERIA, toAssignmentColumns, evaluationState } = require('./criteria');
const { TYPES, recordScoreEvent } = require('../scoring');
const { getRuntimeEvaluator } = require('./runtimeEvaluator');

const STALE_MS = 3 * 60 * 1000;

function logEvent(name, details) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    event: name,
    details: typeof details === 'string' ? details : details
  };
  console.log(`[${timestamp}] [${name}]`, JSON.stringify(logEntry.details));
}

async function loadCriteria(supabase, gameId = 'main_event') {
  try {
    const { data, error } = await supabase
      .from('evaluation_criteria')
      .select('*')
      .eq('game_id', gameId)
      .order('sort_order');
    if (!error && data && data.length) return data;
  } catch (_) {}
  return DEFAULT_MAIN_EVENT_CRITERIA;
}

async function upsertEvaluationRow(supabase, participantId, patch) {
  try {
    await supabase.from('evaluations').upsert({
      participant_id: participantId,
      game_id: 'main_event',
      ...patch,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'participant_id,game_id' });
  } catch (err) {
    console.warn('[Pipeline] Failed to upsert evaluation row:', err.message);
  }
}

/**
 * Run (or resume) AI evaluation for one participant.
 * Always awaited by the HTTP handler so Vercel cannot freeze the work.
 */
async function processEvaluation(supabase, participantId, options = {}) {
  const { data: asgn, error } = await supabase
    .from('main_event_assignments')
    .select('*')
    .eq('participant_id', participantId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!asgn) throw new Error('Assignment not found.');
  if (!asgn.github_repo) throw new Error('No GitHub repository has been submitted yet.');

  if (asgn.evaluation_status === 'Evaluated' && asgn.ai_score != null && !options.retry) {
    return {
      success: true,
      already_complete: true,
      evaluation_status: 'Evaluated',
      evaluation_state: 'COMPLETED',
      assignment: asgn,
    };
  }

  const startedAt = asgn.evaluation_started_at ? new Date(asgn.evaluation_started_at).getTime() : 0;
  const isFreshProcessing = asgn.evaluation_status === 'Evaluating'
    && startedAt
    && (Date.now() - startedAt) < STALE_MS
    && !options.force;

  if (isFreshProcessing) {
    return {
      success: true,
      in_progress: true,
      evaluation_status: 'Evaluating',
      evaluation_state: 'PROCESSING',
      message: 'Evaluation is already in progress.',
    };
  }

  const nowIso = new Date().toISOString();
  await supabase.from('main_event_assignments').update({
    evaluation_status: 'Evaluating',
    evaluation_started_at: nowIso,
  }).eq('participant_id', participantId);

  await upsertEvaluationRow(supabase, participantId, {
    status: 'PROCESSING',
    started_at: nowIso,
    error_message: null,
  });

  logEvent('EVALUATION_STARTED', { participantId, repo: asgn.github_repo });

  const criteria = options.criteria || await loadCriteria(supabase, 'main_event');
  const provider = options.provider || new GroqEvaluationProvider();
  const runtimeEvaluator = getRuntimeEvaluator();

  try {
    // Run runtime evaluation if available (graceful degradation)
    let runtimeEvidence = null;
    try {
      const { downloadAndReadRepo } = require('../githubRepo');
      const sourceCode = await downloadAndReadRepo(asgn.github_repo);
      runtimeEvidence = await runtimeEvaluator.evaluate({ assignment: asgn, sourceCode });
      logEvent('RUNTIME_EVALUATION', { 
        participantId, 
        available: runtimeEvidence.runtime_available,
        mode: runtimeEvidence.runtime_mode,
        duration_ms: runtimeEvidence.runtime_duration_ms 
      });
    } catch (runtimeErr) {
      console.warn('[Runtime] Runtime evaluation failed, falling back to static-only:', runtimeErr.message);
      runtimeEvidence = {
        runtime_available: false,
        runtime_mode: 'FAILED',
        fallback_reason: runtimeErr.message
      };
    }

    const result = await provider.evaluateSubmission({ 
      assignment: asgn, 
      criteria,
      runtimeEvidence 
    });
    const scorePatch = toAssignmentColumns(result, criteria);
    const fizz = Number(asgn.fizzbuzz_score || 0);
    const totalIndividual = Number(scorePatch.main_event_score || 0) + fizz;

    // Set evaluation status based on runtime availability
    // Use 'Evaluated' for both, but store runtime mode in separate field for admin visibility
    const evaluationStatus = 'Evaluated';
    
    const { error: updErr } = await supabase.from('main_event_assignments').update({
      ...scorePatch,
      evaluation_status: evaluationStatus,
      submission_status: 'Evaluated',
      total_individual_score: totalIndividual,
      runtime_mode: runtimeEvidence?.runtime_mode || 'STATIC_ONLY',
    }).eq('participant_id', participantId);

    if (updErr) throw new Error(updErr.message);

    await upsertEvaluationRow(supabase, participantId, {
      status: 'COMPLETED',
      completed_at: new Date().toISOString(),
      criteria_scores: result.scores,
      total_score: result.total,
      max_total: result.maxTotal,
      feedback: result.feedback,
      error_message: null,
      runtime_evidence: runtimeEvidence || null,
    });

    // Also store runtime evidence in main_event_assignments for admin visibility
    await supabase.from('main_event_assignments').update({
      runtime_evidence: runtimeEvidence || null
    }).eq('participant_id', participantId);

    try {
      await recordScoreEvent(supabase, {
        gameId: 'main_event',
        participantId,
        originalTeamId: asgn.original_team_id || null,
        originalTeamName: asgn.original_team,
        sessionTeamId: asgn.shuffled_group,
        points: result.total,
        reason: 'AI evaluation individual score',
        type: TYPES.INDIVIDUAL_SCORE,
        idempotencyKey: `main_event:${participantId}:INDIVIDUAL_SCORE`,
      });
    } catch (scoreErr) {
      console.error('[SCORE_CREATED] ledger write failed (assignment already updated):', scoreErr.message);
    }

    logEvent('EVALUATION_COMPLETED', { participantId, total: result.total, max: result.maxTotal });
    logEvent('SCORE_CREATED', { participantId, gameId: 'main_event', points: result.total, originalTeam: asgn.original_team });

    return {
      success: true,
      evaluation_status: 'Evaluated',
      evaluation_state: 'COMPLETED',
      scores: result.scores,
      total: result.total,
      maxTotal: result.maxTotal,
      feedback: result.feedback,
    };
  } catch (err) {
    const message = (err && err.message) ? err.message : 'AI evaluation failed.';
    logEvent('EVALUATION_FAILED', { participantId, error: message });

    await supabase.from('main_event_assignments').update({
      evaluation_status: 'Failed',
      ai_feedback: 'Evaluation failed: ' + message.slice(0, 200),
    }).eq('participant_id', participantId);

    await upsertEvaluationRow(supabase, participantId, {
      status: 'FAILED',
      completed_at: new Date().toISOString(),
      error_message: message.slice(0, 500),
    });

    return {
      success: false,
      evaluation_status: 'Failed',
      evaluation_state: 'FAILED',
      message: 'AI evaluation failed. You can retry.',
      error: message,
    };
  }
}

function publicEvaluationView(asgn, criteria) {
  if (!asgn) return null;
  return {
    evaluation_status: asgn.evaluation_status,
    evaluation_state: evaluationState(asgn.evaluation_status),
    scores: {
      task_completion: asgn.task_match_score,
      ui: asgn.ui_score,
      logic: asgn.logic_score,
      responsiveness: asgn.code_quality_score,
      creativity: asgn.creativity_score,
    },
    total: asgn.ai_score,
    maxTotal: (criteria || DEFAULT_MAIN_EVENT_CRITERIA).reduce((s, c) => s + Number(c.max_score), 0),
    feedback: asgn.ai_feedback,
    criteria: criteria || DEFAULT_MAIN_EVENT_CRITERIA,
  };
}

module.exports = {
  processEvaluation,
  loadCriteria,
  publicEvaluationView,
  evaluationState,
};
