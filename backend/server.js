'use strict';

const express   = require('express');
const cors      = require('cors');
const crypto    = require('crypto');
const path      = require('path');
const axios     = require('axios');
if (!process.env.VERCEL) {
    require('dotenv').config();
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const { createClient }    = require('@supabase/supabase-js');
const { validateRepository } = require('./aiScorer');
const { requireAdmin }    = require('./middleware/auth');
const { authLimiter, submitLimiter, evalLimiter, registerLimiter, adminLimiter } = require('./middleware/rateLimit');
const { isValidGitHubUrl, sanitizeName, isUUID, clampScore, escHtml } = require('./middleware/sanitize');
const timerLib = require('./lib/timer');
const fizzbuzzLib = require('./lib/fizzbuzz');
const scoringLib = require('./lib/scoring');
const { processEvaluation, loadCriteria, publicEvaluationView, evaluationState } = require('./lib/evaluation/pipeline');
const { DEFAULT_MAIN_EVENT_CRITERIA, maxTotal } = require('./lib/evaluation/criteria');
const {
  computeCodeSimilarity,
  compareSameRolePair,
  buildTaskCohortReport,
  buildFullEventCohortReport
} = require('./lib/evaluation/cohortComparator');

// ── Startup validation ────────────────────────────────────────────────────────

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('[FATAL] SUPABASE_URL and SUPABASE_KEY are required.');
  process.exit(1);
}

if (!process.env.ADMIN_SECRET) {
  console.warn('[WARN] ADMIN_SECRET is not set. Admin login will be disabled.');
}

// ── Supabase client ───────────────────────────────────────────────────────────

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Startup table check (non-blocking, logs missing tables) ──────────────────
// Runs after the first event-loop tick so the server is ready to handle /api/health
// even if Supabase is slow.
const REQUIRED_TABLES = [
  'teams', 'participants', 'main_event_tasks', 'main_event_assignments',
  'event_timers', 'shuffle_lock', 'fizzbuzz_submissions_v2',
  'code_imposter_submissions', 'manual_event_scores_v2',
  'admin_sessions', 'audit_log',
  'evaluation_criteria', 'score_events', 'evaluations', 'game_config', 'event_state'
];

async function checkRequiredTables() {
  const missing = [];
  for (const t of REQUIRED_TABLES) {
    const { error } = await supabase.from(t).select('*').limit(0);
    if (error && (error.message.includes('does not exist') || error.message.includes('schema cache'))) {
      missing.push(t);
    }
  }
  if (missing.length > 0) {
    console.error('[DB] ⚠ MISSING TABLES:', missing.join(', '));
    console.error('[DB] Run backend/migrations/002_missing_tables.sql in Supabase SQL Editor to create them.');
    console.error('[DB] Admin login will fail until admin_sessions is created.');
  } else {
    console.log('[DB] All required tables exist ✓');
  }
  return missing;
}

// Store result for /api/health to use (populated asynchronously)
let _missingTables = null;
setImmediate(() => {
  checkRequiredTables().then(missing => { _missingTables = missing; }).catch(() => {});
});

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();

// CORS — allowed origins
// In production set FRONTEND_ORIGIN to your deployed URL.
// In local dev every common port is allowed automatically so Live Server,
// Vite, or any other static server works without touching .env.
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// Local dev origins always permitted (ignored in production if FRONTEND_ORIGIN is set)
const LOCAL_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5500',
  'http://localhost:5173',
  'http://localhost:8080',
  'http://localhost:8000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8000',
];

app.use(cors({
  origin(origin, cb) {
    // Same-origin requests (no Origin header — e.g. direct file:// or server-side)
    if (!origin) return cb(null, true);
    // Explicitly listed production origins
    if (ALLOWED_ORIGINS.length > 0 && ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // Always allow local dev origins
    if (LOCAL_DEV_ORIGINS.includes(origin)) return cb(null, true);
    // If no FRONTEND_ORIGIN env var is set we are in local/dev mode — allow all
    if (!process.env.FRONTEND_ORIGIN) return cb(null, true);
    return cb(new Error('CORS: origin not allowed: ' + origin));
  },
  methods:     ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const generateTeamCode = (teamName) => {
  const prefix = String(teamName || '').trim().slice(0, 3).toUpperCase();
  const rand   = String(Math.floor(1000 + Math.random() * 9000));
  return `${prefix}${rand}`;
};

/** Write an audit log entry (fire-and-forget — never blocks a response). */
function auditLog(action, target, details, performedBy = 'system') {
  supabase.from('audit_log')
    .insert({ action, target, details, performed_by: performedBy })
    .then(() => {}).catch(() => {});
}

const computeRemaining = timerLib.computeRemaining;
const normaliseTimer   = timerLib.normaliseTimer;

async function loadGameConfig(gameId) {
  try {
    const { data } = await supabase.from('game_config').select('*').eq('game_id', gameId).maybeSingle();
    return fizzbuzzLib.mergeGameConfig(data || { game_id: gameId });
  } catch (_) {
    return fizzbuzzLib.mergeGameConfig({ game_id: gameId });
  }
}

async function setScoringLocked(gameId, locked) {
  try {
    await supabase.from('game_config').upsert({
      game_id: gameId,
      scoring_locked: !!locked,
      updated_at: new Date().toISOString()
    }, { onConflict: 'game_id' });
  } catch (_) {}
}

const EVENT_KEY_MAP = {
  'main_event': 'main_event', 'Main Event': 'main_event',
  'fizzbuzz':   'fizzbuzz',   'FizzBuzz':   'fizzbuzz',
  'code_imposter': 'code_imposter', 'Code Imposter': 'code_imposter',
  'sherlock':   'sherlock',   'Sherlock Holmes': 'sherlock'
};

function resolveEventKey(input) {
  if (!input) return null;
  return EVENT_KEY_MAP[input] || String(input).toLowerCase().replace(/\s+/g, '_');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC PARTICIPANT ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  try {
    const { error } = await supabase.from('teams').select('count').limit(1);
    const missing = _missingTables; // may be null if startup check is still running
    return res.json({
      success:         true,
      status:          error ? 'degraded' : 'ok',
      database:        error ? 'unavailable' : 'ok',
      missing_tables:  missing && missing.length > 0 ? missing : undefined,
      setup_required:  missing && missing.length > 0
        ? 'Run backend/migrations/002_missing_tables.sql in Supabase SQL Editor'
        : undefined,
      timestamp:       new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({ success: false, status: 'error', database: 'unavailable' });
  }
});

// ── Root ──────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ message: 'ASTHRA 2K26 Imposter Backend', version: '2.0' }));

// ── POST /api/authenticate ────────────────────────────────────────────────────

app.post('/api/authenticate', authLimiter, async (req, res) => {
  try {
    const name      = sanitizeName(req.body?.name);
    const team_name = sanitizeName(req.body?.team_name);

    if (!name || !team_name) {
      return res.status(400).json({ success: false, message: 'Participant name and team name are required.' });
    }

    // Look up team (case-sensitive exact match to prevent enumeration via case variants)
    const { data: teamData, error: teamErr } = await supabase
      .from('teams')
      .select('id, team_name, team_code')
      .eq('team_name', team_name)
      .maybeSingle();

    if (teamErr)   return res.status(500).json({ success: false, message: 'Authentication failed.' });
    // Return same message for missing team and wrong name to prevent enumeration
    if (!teamData) return res.status(404).json({ success: false, message: 'Invalid team or participant name.' });

    const { data: participant, error: pErr } = await supabase
      .from('participants')
      .select('id, participant_name, player_role, shuffle_group')
      .eq('team_id', teamData.id)
      .eq('participant_name', name)
      .maybeSingle();

    if (pErr)        return res.status(500).json({ success: false, message: 'Authentication failed.' });
    if (!participant) return res.status(404).json({ success: false, message: 'Invalid team or participant name.' });

    // Require shuffle to have run
    if (!participant.player_role || !participant.shuffle_group) {
      return res.status(403).json({
        success: false,
        message: 'The event has not started yet. Please wait for the coordinator to run the shuffle.'
      });
    }

    const role = participant.player_role === 'Imposter' ? 'Imposter' : 'Specialist';

    // Return only what the participant needs — no group number, no team mapping
    return res.json({
      success: true,
      message: 'Authentication successful.',
      user: {
        id:        participant.id,
        name:      participant.participant_name,
        team_name: teamData.team_name,
        team_code: teamData.team_code,
        role
      }
    });
  } catch (err) {
    console.error('[authenticate]', err.message);
    return res.status(500).json({ success: false, message: 'Authentication failed.' });
  }
});

// ── GET /api/my-assignment/:participantId ─────────────────────────────────────
// Note: participant UUIDs have 128 bits of entropy — enumeration is not feasible.
// We do NOT expose is_imposter to the response; instead we expose a role field
// that only the participant themselves can correlate with their login identity.

app.get('/api/my-assignment/:participantId', async (req, res) => {
  try {
    const participantId = String(req.params.participantId || '').trim();
    // participant_id is INTEGER in main_event_assignments — accept digits or UUID
    if (!(/^\d+$/.test(participantId) || isUUID(participantId))) {
      return res.status(400).json({ success: false, message: 'Invalid participant ID.' });
    }

    const { data, error } = await supabase
      .from('main_event_assignments')
      .select(
        'participant_id, participant_name, original_team, shuffled_group, ' +
        'task_number, task_title, task_description, ' +
        'person_slot, role_name, work_description, is_imposter, ' +
        'github_repo, github_owner, github_repo_name, submission_status, evaluation_status, submitted_at'
        // NOTE: Score fields (ai_score, ui_score, task_match_score, logic_score,
        // creativity_score, code_quality_score, ai_feedback) are intentionally
        // omitted — scores are NOT visible to participants.
      )
      .eq('participant_id', participantId)
      .maybeSingle();

    if (error)  return res.status(500).json({ success: false, message: 'Failed to fetch assignment.' });
    if (!data)  return res.status(404).json({ success: false, message: 'No assignment found. The coordinator may not have run the shuffle yet.' });

    // For imposters: fetch the secret sabotage objective from the task table
    // This was NOT stored in main_event_assignments to prevent admin API leakage
    if (data.is_imposter && data.task_number) {
      const { data: taskData } = await supabase
        .from('main_event_tasks')
        .select('person4_secret')
        .eq('task_number', data.task_number)
        .maybeSingle();
      if (taskData) {
        data.secret_objective = taskData.person4_secret;
      }
    }

    return res.json({ success: true, assignment: data });
  } catch (err) {
    console.error('[my-assignment]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch assignment.' });
  }
});

// ── GET /api/submission-status ───────────────────────────────────────────────
// Public: returns whether GitHub link submissions are currently open.
app.get('/api/submission-status', async (req, res) => {
  try {
    const { data } = await supabase
      .from('game_config')
      .select('config_json')
      .eq('game_id', 'main_event')
      .maybeSingle();
    const open = data?.config_json?.submissions_open !== false; // default: open
    return res.json({ success: true, submissions_open: open });
  } catch (err) {
    return res.json({ success: true, submissions_open: true }); // fail-open
  }
});

// ── POST /api/admin/toggle-submissions ────────────────────────────────────────
// Admin: explicitly set submissions open or closed.
app.post('/api/admin/toggle-submissions', requireAdmin, async (req, res) => {
  try {
    const open = req.body?.open !== undefined ? !!req.body.open : null;

    // If no explicit value, read current state and flip it
    let newOpen = open;
    if (newOpen === null) {
      const { data } = await supabase
        .from('game_config').select('config_json').eq('game_id', 'main_event').maybeSingle();
      newOpen = data?.config_json?.submissions_open === false ? true : false;
    }

    // Merge into existing config_json
    const { data: existing } = await supabase
      .from('game_config').select('config_json').eq('game_id', 'main_event').maybeSingle();
    const mergedConfig = { ...(existing?.config_json || {}), submissions_open: newOpen };

    await supabase.from('game_config').upsert({
      game_id: 'main_event',
      config_json: mergedConfig,
      updated_at: new Date().toISOString()
    }, { onConflict: 'game_id' });

    auditLog('toggle_submissions', 'main_event', { submissions_open: newOpen });
    console.log('[submissions-toggle] submissions_open set to', newOpen);
    return res.json({ success: true, submissions_open: newOpen });
  } catch (err) {
    console.error('[toggle-submissions]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/submit-github ───────────────────────────────────────────────────

app.post('/api/submit-github', submitLimiter, async (req, res) => {
  try {
    const participant_id = String(req.body?.participant_id || '').trim();
    const github_repo    = String(req.body?.github_repo    || '').trim();

    if (!isUUID(participant_id)) {
      return res.status(400).json({ success: false, message: 'Invalid participant ID.' });
    }
    if (!isValidGitHubUrl(github_repo)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid GitHub repository URL (e.g. https://github.com/username/repository).' });
    }

    // Check if submissions are currently open (admin toggle)
    try {
      const { data: cfg } = await supabase
        .from('game_config').select('config_json').eq('game_id', 'main_event').maybeSingle();
      if (cfg?.config_json?.submissions_open === false) {
        return res.status(403).json({
          success: false,
          submissions_closed: true,
          message: 'Submissions are currently closed by the coordinator. Please wait.'
        });
      }
    } catch (_) { /* fail-open: if config unreachable, allow submission */ }
    // Fetch assignment — must exist and must not already be submitted
    const { data: existing, error: fetchErr } = await supabase
      .from('main_event_assignments')
      .select('participant_id, submission_status, submission_locked, github_repo, task_title, task_description, role_name, work_description, is_imposter')
      .eq('participant_id', participant_id)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ success: false, message: 'Failed to retrieve assignment.' });
    if (!existing) return res.status(404).json({ success: false, message: 'Assignment not found for this participant.' });

    if (existing.submission_locked ||
        existing.submission_status === 'Submitted' ||
        existing.submission_status === 'Evaluated') {
      return res.status(409).json({
        success:     false,
        message:     'You have already submitted. Only one submission is allowed.',
        github_repo: existing.github_repo
      });
    }

    // Validate the GitHub repository (authenticated request)
    const validation = await validateRepository(github_repo);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: validation.message });
    }

    // Atomic conditional update: only succeeds if submission_locked is still FALSE.
    // This prevents duplicate submissions even under concurrent requests.
    const { data: updated, error: updateErr } = await supabase
      .from('main_event_assignments')
      .update({
        github_repo,
        github_owner:      validation.owner,
        github_repo_name:  validation.repo,
        github_branch:     validation.defaultBranch,
        submission_status: 'Submitted',
        evaluation_status: 'Queued',
        submission_locked: true,
        submitted_at:      new Date().toISOString()
      })
      .eq('participant_id', participant_id)
      .eq('submission_locked', false)
      .select('participant_id');

    if (updateErr) return res.status(500).json({ success: false, message: 'Failed to save submission.' });

    // If nothing was updated, a concurrent request already locked the submission
    if (!updated || updated.length === 0) {
      return res.status(409).json({
        success:  false,
        message:  'You have already submitted. Only one submission is allowed.'
      });
    }

    // Respond immediately — AI evaluation runs in background
    res.json({
      success: true,
      message: 'GitHub repository submitted successfully. AI evaluation has started.',
      repository: { owner: validation.owner, name: validation.repo, branch: validation.defaultBranch }
    });

    // Background AI evaluation — errors handled gracefully
    runEvaluation(participant_id, {
      github_repo,
      task_title:       existing.task_title,
      task_description: existing.task_description,
      role_name:        existing.role_name,
      work_description: existing.work_description,
      is_imposter:      existing.is_imposter
    }).catch(err => {
      console.error('[eval-background] Unhandled error for', participant_id, ':', err.message);
    });

  } catch (err) {
    console.error('[submit-github]', err.message);
    return res.status(500).json({ success: false, message: 'Submission failed. Please try again.' });
  }
});

/**
 * Run AI evaluation and persist results.
 * Safe to call from background — all errors are caught and saved.
 * Uses the new processEvaluation pipeline for proper state machine.
 */
async function runEvaluation(participantId, assignmentData, options = {}) {
  try {
    const result = await processEvaluation(supabase, participantId, {
      retry: options.retry !== undefined ? options.retry : false,
      force: options.force !== undefined ? options.force : false
    });

    console.log('[eval] Completed for', participantId, '— success:', result.success, 'state:', result.evaluation_state);
  } catch (evalErr) {
    console.error('[eval] Failed for', participantId, ':', evalErr.message);

    // Preserve submission — only mark evaluation as failed
    try {
      await supabase.from('main_event_assignments').update({
        evaluation_status: 'Failed',
        ai_feedback:       'Evaluation failed: ' + evalErr.message.slice(0, 200)
      }).eq('participant_id', participantId);
    } catch (_) {}
  }
}

// ── GET /api/fizzbuzz/toggle ──────────────────────────────────────────────────
// Returns simple status: waiting | active | closed (ignores timer countdown)
app.get('/api/fizzbuzz/toggle', async (req, res) => {
  try {
    const { data } = await supabase
      .from('event_timers')
      .select('status')
      .eq('event_key', 'fizzbuzz')
      .maybeSingle();
    if (!data) return res.json({ success: true, fizzbuzz_open: false, status: 'waiting' });
    // Map internal statuses to the three public states
    const statusMap = { active: 'active', running: 'active', closed: 'closed', idle: 'waiting', waiting: 'waiting', finished: 'closed', paused: 'waiting' };
    const status    = statusMap[data.status] || 'waiting';
    const open      = status === 'active';
    return res.json({ success: true, fizzbuzz_open: open, status });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/fizzbuzz/status/:participantId ───────────────────────────────────

app.get('/api/fizzbuzz/status/:participantId', async (req, res) => {
  try {
    const participantId = String(req.params.participantId || '').trim();
    // participant_id is INTEGER in main_event_assignments — accept digits or UUID
    if (!(/^\d+$/.test(participantId) || isUUID(participantId))) {
      return res.status(400).json({ success: false, message: 'Invalid participant ID.' });
    }

    const { data: assignment, error: aErr } = await supabase
      .from('main_event_assignments')
      .select('participant_id, participant_name, original_team, shuffled_group, is_imposter')
      .eq('participant_id', participantId)
      .maybeSingle();

    if (aErr)        return res.status(500).json({ success: false, message: aErr.message });
    if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found.' });

    // Check group submission
    const { data: groupSub } = await supabase
      .from('fizzbuzz_submissions_v2')
      .select('shuffled_group, submitted_by, submitted_at, is_correct')
      .eq('shuffled_group', assignment.shuffled_group)
      .maybeSingle();

    return res.json({
      success:          true,
      shuffled_group:   assignment.shuffled_group,
      participant_name: assignment.participant_name,
      original_team:    assignment.original_team,
      is_imposter:      assignment.is_imposter,
      group_submitted:  !!groupSub,
      group_submission: groupSub ? { submitted_by: groupSub.submitted_by, submitted_at: groupSub.submitted_at } : null,
      fizzbuzz_locked:  !!groupSub
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/fizzbuzz/submit-v2 ──────────────────────────────────────────────

app.post('/api/fizzbuzz/submit-v2', submitLimiter, async (req, res) => {
  try {
    const participant_id = String(req.body?.participant_id || '').trim();
    const fizz_output    = String(req.body?.fizz_output    || req.body?.code || '').trim();
    const language       = String(req.body?.language       || 'Unknown').trim();

    if (!(/^\d+$/.test(participant_id) || isUUID(participant_id))) return res.status(400).json({ success: false, message: 'Invalid participant ID.' });
    if (!fizz_output)            return res.status(400).json({ success: false, message: 'Code/output is required.' });

    const { data: assignment } = await supabase
      .from('main_event_assignments')
      .select('participant_id, participant_name, original_team, shuffled_group, is_imposter')
      .eq('participant_id', participant_id)
      .maybeSingle();

    if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found.' });

    // Check event status — allow submissions when status is 'active' or 'running' (legacy)
    const { data: timer } = await supabase
      .from('event_timers')
      .select('status')
      .eq('event_key', 'fizzbuzz')
      .maybeSingle();

    const isOpen = timer && (timer.status === 'active' || timer.status === 'running');
    if (!isOpen) {
      const msg = (!timer || timer.status === 'waiting' || timer.status === 'idle')
        ? 'FizzBuzz round has not started yet.'
        : 'FizzBuzz round is closed. No more submissions.';
      return res.status(403).json({ success: false, message: msg });
    }

    // Check if group already submitted
    const { data: existing } = await supabase
      .from('fizzbuzz_submissions_v2')
      .select('shuffled_group, submitted_by')
      .eq('shuffled_group', assignment.shuffled_group)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ success: false, message: `Already submitted by ${escHtml(existing.submitted_by)}.` });
    }

    // Imposter sabotage heuristic — check line 15
    const lines = fizz_output.split('\n').map(l => l.trim()).filter(l => l);
    const imposterSabotaged = assignment.is_imposter && (lines[14] === '15' || lines[14] === '15.0');

    const { error: insErr } = await supabase.from('fizzbuzz_submissions_v2').insert({
      shuffled_group:     assignment.shuffled_group,
      submitted_by:       assignment.participant_name,
      participant_id,
      fizz_output,
      language,
      repo_url:           null,
      imposter_sabotaged: imposterSabotaged
    });

    // Primary-key duplicate (concurrent submission from same group) — return 409, not 500
    if (insErr) {
      const isDupe = insErr.code === '23505' || (insErr.message || '').includes('duplicate');
      if (isDupe) {
        return res.status(409).json({ success: false, message: 'Another member of your group already submitted.' });
      }
      console.error('[fizzbuzz-submit]', insErr.message);
      return res.status(500).json({ success: false, message: 'Submission failed. Please try again.' });
    }

    // Group is now submitted — fizzbuzz_submissions_v2 acts as the lock (checked on next attempt)
    // No additional columns needed on main_event_assignments

    auditLog('fizzbuzz_submit', assignment.shuffled_group, {
      submitted_by: assignment.participant_name,
      participant_id: participant_id,
      language
    });

    return res.json({
      success:        true,
      shuffled_group: assignment.shuffled_group,
      submitted_by:   assignment.participant_name,
      original_team:  assignment.original_team,
      language
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/fizzbuzz/group-status/:group ─────────────────────────────────────

app.get('/api/fizzbuzz/group-status/:group', async (req, res) => {
  try {
    const group = decodeURIComponent(req.params.group || '').trim();
    const { data } = await supabase
      .from('fizzbuzz_submissions_v2')
      .select('shuffled_group, submitted_by, submitted_at, status')
      .eq('shuffled_group', group)
      .maybeSingle();
    return res.json({ success: true, submitted: !!data, submission: data || null });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/code-imposter/submit ────────────────────────────────────────────
// Fixes the previously broken frontend-only submission

app.post('/api/code-imposter/submit', submitLimiter, async (req, res) => {
  try {
    // Frontend sends participant_name + completion_time (no auth — it's a quick per-participant timer)
    // Also accept participant_id + elapsed_time from future implementations
    const participant_name_raw = String(req.body?.participant_name || '').trim();
    const completion_time_raw  = String(req.body?.completion_time  || req.body?.elapsed_time || '').trim();
    // Optional: participant_id if the client sends it
    const participant_id_raw   = String(req.body?.participant_id || '').trim();

    if (!participant_name_raw) return res.status(400).json({ success: false, message: 'participant_name is required.' });
    if (!completion_time_raw)  return res.status(400).json({ success: false, message: 'completion_time is required.' });

    const participant_name = sanitizeName(participant_name_raw) || participant_name_raw.slice(0, 100);

    // Resolve participant_id and original_team from assignment if possible
    let participant_id  = null;
    let original_team   = 'Unknown';

    if (isUUID(participant_id_raw)) {
      const { data: asgn } = await supabase
        .from('main_event_assignments')
        .select('participant_name, original_team')
        .eq('participant_id', participant_id_raw)
        .maybeSingle();
      if (asgn) {
        participant_id = participant_id_raw;
        original_team  = asgn.original_team;
      }
    } else {
      // Fallback: look up by name (best-effort for coordinator-run events)
      // Log a warning so coordinators can identify missing participant_id cases.
      console.warn('[code-imposter] participant_id missing, falling back to name lookup for:', participant_name);
      const { data: asgn } = await supabase
        .from('main_event_assignments')
        .select('participant_id, original_team')
        .ilike('participant_name', participant_name)
        .limit(1);
      if (asgn && asgn.length > 0) {
        participant_id = asgn[0].participant_id;
        original_team  = asgn[0].original_team;
      }
    }

    // Idempotency: if participant already submitted, return their existing record (no duplicate)
    if (participant_id) {
      const { data: existing } = await supabase
        .from('code_imposter_submissions')
        .select('id, elapsed_time, submitted_at')
        .eq('participant_id', participant_id)
        .limit(1);
      if (existing && existing.length > 0) {
        return res.status(409).json({
          success:         false,
          already_submitted: true,
          message:         'You have already submitted your Code Imposter time.',
          completion_time: existing[0].elapsed_time
        });
      }
    }

    const { error } = await supabase.from('code_imposter_submissions').insert({
      participant_id:   participant_id || null,
      participant_name,
      original_team,
      elapsed_time:     completion_time_raw,
      submitted_at:     new Date().toISOString()
    });

    if (error) return res.status(500).json({ success: false, message: 'Submission failed. Please try again.' });

    return res.json({ success: true, message: 'Submission recorded.', completion_time: completion_time_raw });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/event-timers ─────────────────────────────────────────────────────

app.get('/api/event-timers', async (req, res) => {
  try {
    const { data, error } = await supabase.from('event_timers').select('*').order('event_key');
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, timers: (data || []).map(t => normaliseTimer(t)) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/my-scores/:participantId ─────────────────────────────────────────

app.get('/api/my-scores/:participantId', async (req, res) => {
  try {
    const participantId = String(req.params.participantId || '').trim();
    if (!(/^\d+$/.test(participantId) || isUUID(participantId))) return res.status(400).json({ success: false, message: 'Invalid participant ID.' });

    // NOTE: /api/my-scores is intentionally restricted — scores are NOT
    // visible to participants. Only the participant name is returned.
    const { data, error } = await supabase
      .from('main_event_assignments')
      .select('participant_name')
      .eq('participant_id', participantId)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data)  return res.status(404).json({ success: false, message: 'Not found.' });

    return res.json({
      success: true,
      scores: {
        participant_name: data.participant_name
        // Scores are hidden from participants — only admins can view them.
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN AUTH ROUTES (public — return token)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/login', adminLimiter, async (req, res) => {
  try {
    const secret = String(req.body?.secret || '').trim();

    if (!process.env.ADMIN_SECRET) {
      return res.status(503).json({ success: false, message: 'Admin auth is not configured on this server.' });
    }

    // Constant-time comparison to prevent timing attacks
    const expected = Buffer.from(process.env.ADMIN_SECRET);
    const provided = Buffer.from(secret);

    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      return res.status(401).json({ success: false, message: 'Invalid admin secret.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const { error } = await supabase.from('admin_sessions').insert({ token });
    if (error) {
      // Distinguish a missing table from other DB errors
      const isMissingTable = error.message.includes('does not exist') || error.message.includes('schema cache');
      return res.status(500).json({
        success: false,
        message: isMissingTable
          ? 'Database setup incomplete: admin_sessions table is missing. Run backend/migrations/002_missing_tables.sql in Supabase SQL Editor, then try again.'
          : 'Failed to create session. Please try again.'
      });
    }

    auditLog('admin_login', 'admin', {});
    return res.json({ success: true, token });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/logout', requireAdmin, async (req, res) => {
  try {
    await supabase.from('admin_sessions').delete().eq('token', req.adminToken);
    return res.json({ success: true, message: 'Logged out.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// COORDINATOR ROUTES (require admin auth)
// ═══════════════════════════════════════════════════════════════════════════════

// ── POST /api/register-team ───────────────────────────────────────────────────

app.post('/api/register-team', registerLimiter, requireAdmin, async (req, res) => {
  try {
    const team_name   = sanitizeName(req.body?.team_name);
    const rawMembers  = Array.isArray(req.body?.members) ? req.body.members : [];
    const members     = rawMembers.map(m => sanitizeName(m)).filter(Boolean);

    if (!team_name) return res.status(400).json({ success: false, message: 'team_name is required.' });
    if (members.length !== 4) return res.status(400).json({ success: false, message: 'Exactly 4 participant names are required.' });

    // Check for duplicate team name
    const { data: existingTeam } = await supabase
      .from('teams')
      .select('id')
      .ilike('team_name', team_name)
      .limit(1);

    if (existingTeam && existingTeam.length > 0) {
      return res.status(409).json({ success: false, message: 'Team name already exists.' });
    }

    const teamCode = generateTeamCode(team_name);

    const { data: teamData, error: teamErr } = await supabase
      .from('teams')
      .insert([{ team_name, team_code: teamCode }])
      .select();

    if (teamErr) return res.status(500).json({ success: false, message: teamErr.message });

    const teamId = teamData?.[0]?.id;
    if (!teamId)  return res.status(500).json({ success: false, message: 'Team could not be created.' });

    const { error: pErr } = await supabase
      .from('participants')
      .insert(members.map(name => ({ team_id: teamId, participant_name: name })));

    if (pErr) {
      // Roll back team creation
      try { await supabase.from('teams').delete().eq('id', teamId); } catch (_) {}
      return res.status(500).json({ success: false, message: pErr.message });
    }

    auditLog('register_team', team_name, { team_code: teamCode, members });
    return res.status(201).json({ success: true, team_code: teamCode, message: 'Team registered successfully.' });
  } catch (err) {
    console.error('[register-team]', err.message);
    return res.status(500).json({ success: false, message: 'Team registration failed.' });
  }
});

// ── GET /api/registered-teams ─────────────────────────────────────────────────

app.get('/api/registered-teams', requireAdmin, async (req, res) => {
  try {
    const { data: teams, error: tErr } = await supabase.from('teams').select('*').order('id');
    if (tErr) return res.status(500).json({ success: false, message: tErr.message });

    const { data: participants, error: pErr } = await supabase.from('participants').select('*').order('id');
    if (pErr) return res.status(500).json({ success: false, message: pErr.message });

    const byTeam = {};
    (participants || []).forEach(p => {
      if (!byTeam[p.team_id]) byTeam[p.team_id] = [];
      byTeam[p.team_id].push(p.participant_name);
    });

    const result = (teams || []).map(t => ({
      id:        t.id,
      team_name: t.team_name,
      team_code: t.team_code,
      members:   byTeam[t.id] || []
    }));

    return res.json({ success: true, teams: result, total_teams: result.length, total_participants: (participants || []).length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/shuffle-layout ───────────────────────────────────────────────────

app.get('/api/shuffle-layout', requireAdmin, async (req, res) => {
  try {
    const { data: teams,        error: tErr } = await supabase.from('teams').select('id, team_name').order('id');
    const { data: participants, error: pErr } = await supabase.from('participants').select('*').order('id');

    if (tErr || pErr) return res.status(500).json({ success: false, message: 'Failed to fetch data.' });

    const completeTeams = (teams || []).filter(t =>
      (participants || []).filter(p => p.team_id === t.id).length === 4
    );

    const N = (teams || []).length;
    const completeTeamsCount = completeTeams.length;
    const expectedPart = N * 4;

    if (!teams || N < 3 || N > 6 || completeTeamsCount !== N || (participants || []).length !== expectedPart) {
      return res.json({ success: true, participants: [], seating_ready: false, teams_count: N, total_expected: expectedPart });
    }

    const shuffled = (participants || []).every(p => p.shuffle_group && p.shuffle_group !== 'Unassigned');
    if (!shuffled) return res.json({ success: true, participants: [], seating_ready: false, teams_count: N, total_expected: expectedPart });

    const teamMap = {};
    (teams || []).forEach(t => { teamMap[t.id] = t.team_name; });

    const seatRows = (participants || []).map(p => ({
      id:              p.id,
      participant_name: p.participant_name,
      original_team:   teamMap[p.team_id] || 'Unknown',
      seating_group:   p.shuffle_group,
      is_imposter:     p.player_role === 'Imposter' || p.is_imposter === true,
      role:            (p.player_role === 'Imposter' || p.is_imposter === true) ? 'Imposter' : 'Specialist'
    })).sort((a, b) => {
      const gA = parseInt((a.seating_group || '').replace(/\D/g, ''), 10) || 0;
      const gB = parseInt((b.seating_group || '').replace(/\D/g, ''), 10) || 0;
      if (gA !== gB) return gA - gB;
      return (a.is_imposter ? 1 : 0) - (b.is_imposter ? 1 : 0);
    });

    return res.json({ success: true, participants: seatRows, seating_ready: true, teams_count: N, total_expected: expectedPart });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/start-shuffle ───────────────────────────────────────────────────

app.post('/api/start-shuffle', requireAdmin, async (req, res) => {
  const forceReset = req.body?.force_reset === true;

  try {
    // Check shuffle lock
    const { data: lockRow } = await supabase
      .from('shuffle_lock')
      .select('is_locked, locked_at')
      .eq('id', 1)
      .maybeSingle();

    if (lockRow?.is_locked) {
      return res.status(409).json({
        success:   false,
        locked:    true,
        locked_at: lockRow.locked_at,
        message:   'Shuffle is locked. Unlock shuffle first on the Coordinator Dashboard before running or retrying.'
      });
    }

    // Validate N complete teams where N ∈ {3,4,5,6}
    const { data: allTeams,        error: tErr } = await supabase.from('teams').select('id, team_name, team_code');
    const { data: allParticipants, error: pErr } = await supabase.from('participants').select('*');

    if (tErr || pErr) return res.status(500).json({ success: false, message: 'Failed to fetch teams.' });

    const teamMap = {};
    allTeams.forEach(t => { teamMap[t.id] = t; });

    const byTeam = {};
    allParticipants.forEach(p => {
      if (!byTeam[p.team_id]) byTeam[p.team_id] = [];
      byTeam[p.team_id].push(p);
    });

    const teamIds = Object.keys(byTeam);
    const N = teamIds.length;
    if (N < 3 || N > 6 || teamIds.some(tid => byTeam[tid].length !== 4)) {
      return res.status(400).json({
        success: false,
        message: 'Exactly 3, 4, 5, or 6 teams with 4 members each are required to run the shuffle. Current: ' + N + ' registered team(s).'
      });
    }

    // Step A: Pick 1 imposter per original team
    const imposters         = [];
    const specialistsByTeam = {};

    for (const teamId of teamIds) {
      const shuffledMembers = [...byTeam[teamId]].sort(() => Math.random() - 0.5);
      imposters.push(shuffledMembers[0]);
      specialistsByTeam[teamId] = shuffledMembers.slice(1);
    }

    // Step B: Shuffle imposters
    const shuffledImposters = [...imposters].sort(() => Math.random() - 0.5);

    // Step C: Build N groups
    const groups = Array.from({ length: N }, (_, i) => ({
      groupName:   `Group ${i + 1}`,
      imposter:    shuffledImposters[i],
      specialists: []
    }));

    // Step D: Assign specialists.
    // Rules (N ≥ 4, strict):
    //   1. No specialist from the imposter's original team (kept for all N)
    //   2. At most one specialist from each original team per group (strict)
    // Exception for N = 3 (combinatorial necessity):
    //   Rule 1 still applies; relax rule 2 → allow up to 2 specialists from same original team per group.
    //   (With 3 teams, N-1 = 2 other teams; 3 slots needed per group × 3 groups = 9 specialists,
    //   3 specialists each from 2 other teams = each group necessarily has 2 from same team.)
    const allSpecialists = [];
    for (const tid of teamIds) allSpecialists.push(...specialistsByTeam[tid]);

    const maxSameTeamPerGroup = (N === 3) ? 2 : 1;

    let assigned = false;
    for (let attempt = 0; attempt < 500 && !assigned; attempt++) {
      const working = groups.map(g => ({ ...g, specialists: [] }));
      const pool    = [...allSpecialists].sort(() => Math.random() - 0.5);
      let valid     = true;

      for (const specialist of pool) {
        const eligible = working.filter(wg => {
          if (wg.specialists.length >= 3) return false;
          if (wg.imposter.team_id === specialist.team_id) return false; // never allow
          const sameTeamCount = wg.specialists.filter(s => s.team_id === specialist.team_id).length;
          return sameTeamCount < maxSameTeamPerGroup;
        });
        if (eligible.length === 0) { valid = false; break; }
        eligible[Math.floor(Math.random() * eligible.length)].specialists.push(specialist);
      }

      if (valid && working.every(wg => wg.specialists.length === 3)) {
        assigned = true;
        working.forEach((wg, i) => { groups[i].specialists = wg.specialists; });
      }
    }

    if (!assigned) {
      return res.status(400).json({ success: false, message: 'Unable to create a valid seating arrangement after 500 attempts.' });
    }

    // Step E (moved): Load and validate tasks BEFORE writing any DB state.
    // If tasks are missing we must abort here — before touching the participants table —
    // otherwise participants get shuffle_group written but no assignment rows created,
    // causing login to succeed but /api/my-assignment to return 404.
    const { data: tasks, error: taskErr } = await supabase.from('main_event_tasks').select('*').order('task_number');
    if (taskErr) return res.status(500).json({ success: false, message: 'Failed to load tasks: ' + taskErr.message });
    if (!tasks || tasks.length < 3) {
      return res.status(500).json({ success: false, message: 'Task data is missing. Run the migration SQL to seed tasks 1-3 before shuffling.' });
    }

    const taskByNumber = {};
    tasks.forEach(t => { taskByNumber[t.task_number] = t; });

    // Cyclic task assignment: Group G -> Task ((G-1) mod 3) + 1
    //   N=3: 1,2,3  N=4: 1,2,3,1  N=5: 1,2,3,1,2  N=6: 1,2,3,1,2,3
    const taskForGroup = groupName => {
      const n = parseInt((groupName.match(/\d+/) || ['1'])[0], 10);
      const taskNum = ((n - 1) % 3) + 1;
      return taskByNumber[taskNum] || null;
    };

    // slot 1-3 = specialist slots; slot 4 = imposter
    // IMPORTANT: imposter gets person4_work as visible work_description (cover job),
    // and person4_secret is stored in person4_secret column (visible ONLY to imposter via /api/my-assignment).
    const slotData = (task, slot) => {
      if (slot === 1) return { role_name: task.person1_title, work_description: task.person1_work };
      if (slot === 2) return { role_name: task.person2_title, work_description: task.person2_work };
      if (slot === 3) return { role_name: task.person3_title, work_description: task.person3_work };
      if (slot === 4) return { role_name: task.person4_title, work_description: task.person4_work };  // cover job only
      return { role_name: 'Unknown', work_description: 'TBA.' };
    };

    // Validate all groups have tasks before touching any DB state.
    for (const group of groups) {
      if (!taskForGroup(group.groupName)) {
        return res.status(500).json({ success: false, message: `No task found for ${group.groupName}. Check task seeds.` });
      }
    }

    // Step F: Write participant roles — only reached after all validations pass.
    for (const group of groups) {
      for (const m of group.specialists) {
        await supabase.from('participants').update({ is_imposter: false, shuffle_group: group.groupName, player_role: 'Specialist' }).eq('id', m.id);
      }
      await supabase.from('participants').update({ is_imposter: true, shuffle_group: group.groupName, player_role: 'Imposter' }).eq('id', group.imposter.id);
    }

    // Step G: Delete old assignments using an always-true condition; check error before proceeding
    const { error: delErr } = await supabase
      .from('main_event_assignments')
      .delete()
      .not('participant_id', 'is', null);
    if (delErr) return res.status(500).json({ success: false, message: 'Failed to clear old assignments: ' + delErr.message });

    // Always wipe FizzBuzz submissions too — every shuffle reassigns groups so the
    // existing per-group submissions are now stale and reference groups that may not exist.
    try { await supabase.from('fizzbuzz_submissions_v2').delete().not('shuffled_group', 'is', null); } catch (_) {}

    // Step H: Build 24 assignment rows
    // person4_secret is stored separately — it is ONLY delivered to the imposter via /api/my-assignment
    const rows = [];
    for (const group of groups) {
      const task = taskForGroup(group.groupName);
      group.specialists.forEach((m, idx) => {
        const sd = slotData(task, idx + 1);
        rows.push({
          participant_id:    m.id,
          participant_name:  m.participant_name,
          original_team:     (teamMap[m.team_id]||{}).team_name || 'Unknown',
          shuffled_group:    group.groupName,
          session_team_id:   group.groupName,
          task_number:       task.task_number,
          task_title:        task.task_title,
          task_description:  task.task_description,
          person_slot:       idx + 1,
          role_name:         sd.role_name,
          work_description:  sd.work_description,
          is_imposter:       false,
          github_repo:       null,
          submission_status: 'Pending',
          submitted_at:      null,
          ai_score:          null
        });
      });
      const imp   = group.imposter;
      const impSd = slotData(task, 4);
      rows.push({
        participant_id:    imp.id,
        participant_name:  imp.participant_name,
        original_team:     (teamMap[imp.team_id]||{}).team_name || 'Unknown',
        shuffled_group:    group.groupName,
        session_team_id:   group.groupName,
        task_number:       task.task_number,
        task_title:        task.task_title,
        task_description:  task.task_description,
        person_slot:       4,
        role_name:         impSd.role_name,
        work_description:  impSd.work_description,  // cover job (public)
        // person4_secret is NOT stored here — fetched live in /api/my-assignment for imposters only
        is_imposter:       true,
        github_repo:       null,
        submission_status: 'Pending',
        submitted_at:      null,
        ai_score:          null
      });
    }

    const { error: insertErr } = await supabase.from('main_event_assignments').insert(rows).select();
    if (insertErr) return res.status(500).json({ success: false, message: 'Assignment insert failed: ' + insertErr.message });

    // Do NOT auto-lock — admin must click Lock Shuffle explicitly
    auditLog('start_shuffle', 'all_participants', { groups_created: N, force_reset: forceReset });
    return res.json({ success: true, imposters_selected: N, groups_created: N, assignments_written: true, assignments_count: rows.length });

  } catch (err) {
    console.error('[start-shuffle]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/admin/overview ───────────────────────────────────────────────────

app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('main_event_assignments').select('*').order('submitted_at', { ascending: false });
    if (error) return res.status(500).json({ success: false, message: error.message });

    const all       = data || [];
    const total     = all.length;
    const submitted = all.filter(r => r.submission_status === 'Submitted' || r.submission_status === 'Evaluated').length;
    const evaluated = all.filter(r => r.submission_status === 'Evaluated').length;
    const failed    = all.filter(r => r.evaluation_status === 'Failed').length;
    const recent    = all.filter(r => r.github_repo).slice(0, 8);

    const byGroup = {};
    all.forEach(r => { if (!byGroup[r.shuffled_group]) byGroup[r.shuffled_group] = []; byGroup[r.shuffled_group].push(r); });

    return res.json({ success: true, counts: { total, submitted, evaluated, failed, pending: total - submitted }, recent, task_distribution: byGroup });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/admin/participants ───────────────────────────────────────────────

app.get('/api/admin/participants', requireAdmin, async (req, res) => {
  try {
    // Explicit field selection for security - no secret_objective here (it's not in this table anyway)
    const { data, error } = await supabase
      .from('main_event_assignments')
      .select(
        'participant_id, participant_name, original_team, shuffled_group, ' +
        'task_number, task_title, task_description, ' +
        'person_slot, role_name, work_description, is_imposter, ' +
        'github_repo, github_owner, github_repo_name, submission_status, evaluation_status, submitted_at, ' +
        'ai_score, ui_score, task_match_score, logic_score, creativity_score, code_quality_score, ai_feedback, ' +
        'main_event_score, fizzbuzz_score, total_score'
      )
      .order('shuffled_group');
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, participants: data || [] });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/admin/team-scores ────────────────────────────────────────────────

app.get('/api/admin/team-scores', requireAdmin, async (req, res) => {
  try {
    // Use score_events for authoritative leaderboard
    const { data: scoreEvents, error: scoreErr } = await supabase
      .from('score_events')
      .select('*');

    if (scoreErr) {
      console.error('[team-scores] Falling back to assignments due to score_events error:', scoreErr.message);
      // Fallback to assignment-based calculation
      const [assignRes, manualRes] = await Promise.all([
        supabase.from('main_event_assignments').select('original_team, main_event_score, fizzbuzz_score, ai_score, original_team_id'),
        supabase.from('manual_event_scores_v2').select('*')
      ]);

      const teamMap = {};
      (assignRes.data || []).forEach(r => {
        const t = r.original_team || 'Unknown';
        if (!teamMap[t]) teamMap[t] = { team: t, originalTeamId: r.original_team_id, main_event_total: 0, fizzbuzz_total: 0, manual_total: 0, grand_total: 0, contributions: { main_event: 0, fizzbuzz: 0, code_imposter: 0, sherlock: 0, drawing: 0 } };
        teamMap[t].main_event_total += Number(r.main_event_score || 0);
        teamMap[t].fizzbuzz_total   += Number(r.fizzbuzz_score   || 0);
        teamMap[t].contributions.main_event += Number(r.main_event_score || 0);
        teamMap[t].contributions.fizzbuzz += Number(r.fizzbuzz_score || 0);
      });
      (manualRes.data || []).forEach(r => {
        const t = r.original_team;
        if (!teamMap[t]) teamMap[t] = { team: t, originalTeamId: null, main_event_total: 0, fizzbuzz_total: 0, manual_total: 0, grand_total: 0, contributions: { main_event: 0, fizzbuzz: 0, code_imposter: 0, sherlock: 0, drawing: 0 } };
        teamMap[t].manual_total += Number(r.code_imposter || 0) + Number(r.sherlock || 0) + Number(r.drawing || 0);
        teamMap[t].contributions.code_imposter += Number(r.code_imposter || 0);
        teamMap[t].contributions.sherlock += Number(r.sherlock || 0);
        teamMap[t].contributions.drawing += Number(r.drawing || 0);
      });

      const scores = Object.values(teamMap).map(t => { t.grand_total = t.main_event_total + t.fizzbuzz_total + t.manual_total; return t; }).sort((a, b) => b.grand_total - a.grand_total);
      return res.json({ success: true, scores, source: 'fallback' });
    }

    // Aggregate from score_events by original team
    const aggregated = scoringLib.aggregateOriginalTeams(scoreEvents);
    const scores = aggregated.map(t => ({
      team: t.team,
      originalTeamId: t.originalTeamId,
      main_event_total: t.byGame['main_event'] || 0,
      fizzbuzz_total: t.byGame['fizzbuzz'] || 0,
      manual_total: (t.byGame['code_imposter'] || 0) + (t.byGame['sherlock'] || 0) + (t.byGame['drawing'] || 0),
      grand_total: t.total,
      contributions: t.byGame
    })).sort((a, b) => b.grand_total - a.grand_total);

    return res.json({ success: true, scores, source: 'score_events' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/admin/podium ─────────────────────────────────────────────────────

app.get('/api/admin/podium', requireAdmin, async (req, res) => {
  try {
    const [assignRes, manualRes] = await Promise.all([
      supabase.from('main_event_assignments').select('original_team, main_event_score, fizzbuzz_score, ai_score'),
      supabase.from('manual_event_scores_v2').select('*')
    ]);

    const teamMap = {};
    (assignRes.data || []).forEach(r => {
      const t = r.original_team || 'Unknown';
      if (!teamMap[t]) teamMap[t] = { team: t, main_event_total: 0, fizzbuzz_total: 0, manual_total: 0, members_scored: 0 };
      teamMap[t].main_event_total += Number(r.main_event_score || 0);
      teamMap[t].fizzbuzz_total   += Number(r.fizzbuzz_score   || 0);
      if (r.ai_score != null) teamMap[t].members_scored += 1;
    });
    (manualRes.data || []).forEach(r => {
      const t = r.original_team;
      if (!teamMap[t]) teamMap[t] = { team: t, main_event_total: 0, fizzbuzz_total: 0, manual_total: 0, members_scored: 0 };
      teamMap[t].manual_total += Number(r.code_imposter || 0) + Number(r.sherlock || 0) + Number(r.drawing || 0);
    });

    const podium = Object.values(teamMap).map(t => ({
      ...t,
      grand_total: t.main_event_total + t.fizzbuzz_total + t.manual_total
    })).sort((a, b) => b.grand_total - a.grand_total);
    return res.json({ success: true, podium });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/admin/unlock-submission ─────────────────────────────────────────

app.post('/api/admin/unlock-submission', requireAdmin, async (req, res) => {
  try {
    const participant_id = String(req.body?.participant_id || '').trim();
    if (!isUUID(participant_id)) return res.status(400).json({ success: false, message: 'Invalid participant ID.' });

    // Intentional dual-reset: both submission_status AND evaluation_status are cleared to 'Pending'
    // so the participant can resubmit from scratch. All AI score fields are nulled atomically.
    // submission_locked is set to false so the atomic submission guard allows a new submission.
    const { error } = await supabase.from('main_event_assignments').update({
      github_repo: null, github_owner: null, github_repo_name: null, github_branch: null,
      submitted_at: null, submission_status: 'Pending', evaluation_status: 'Pending',
      submission_locked: false, ai_score: null, ai_feedback: null,
      ui_score: null, task_match_score: null, logic_score: null, creativity_score: null, code_quality_score: null
    }).eq('participant_id', participant_id);

    if (error) return res.status(500).json({ success: false, message: error.message });
    auditLog('unlock_submission', participant_id, {});
    return res.json({ success: true, message: 'Submission unlocked. Participant can resubmit.' });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/admin/manual-score ──────────────────────────────────────────────

app.post('/api/admin/manual-score', requireAdmin, async (req, res) => {
  try {
    const { event_name, original_team, marks } = req.body;
    const allowed = ['Code Imposter', 'Sherlock Holmes', 'Drawing'];

    if (!event_name || !allowed.includes(event_name)) return res.status(400).json({ success: false, message: 'event_name must be one of: ' + allowed.join(', ') });
    if (!original_team) return res.status(400).json({ success: false, message: 'original_team is required.' });

    const safeMarks = clampScore(marks, 0, 100);
    const col = event_name === 'Code Imposter' ? 'code_imposter' : event_name === 'Sherlock Holmes' ? 'sherlock' : 'drawing';

    const { error } = await supabase.from('manual_event_scores_v2').upsert(
      { original_team, [col]: safeMarks, updated_at: new Date().toISOString() },
      { onConflict: 'original_team' }
    );

    if (error) return res.status(500).json({ success: false, message: error.message });
    auditLog('manual_score', original_team, { event_name, marks: safeMarks });
    return res.json({ success: true, message: 'Marks saved.' });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/admin/manual-scores ──────────────────────────────────────────────

app.get('/api/admin/manual-scores', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('manual_event_scores_v2').select('*');
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, scores: data || [] });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/admin/fizzbuzz-scores ────────────────────────────────────────────
app.get('/api/admin/fizzbuzz-scores', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('manual_event_scores')
      .select('original_team, marks')
      .eq('event_name', 'FizzBuzz');
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, scores: data || [] });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/admin/save-fizzbuzz-score ───────────────────────────────────────
app.post('/api/admin/save-fizzbuzz-score', requireAdmin, async (req, res) => {
  try {
    const original_team = String(req.body?.original_team || '').trim();
    const marks         = Number(req.body?.marks);
    if (!original_team || isNaN(marks)) {
      return res.status(400).json({ success: false, message: 'original_team and marks required.' });
    }
    const safeMarks = Math.min(100, Math.max(0, marks));
    const now = new Date().toISOString();
    const { data: ex } = await supabase.from('manual_event_scores')
      .select('id').eq('event_name', 'FizzBuzz').eq('original_team', original_team).maybeSingle();
    let error;
    if (ex) {
      ({ error } = await supabase.from('manual_event_scores')
        .update({ marks: safeMarks, updated_at: now })
        .eq('event_name', 'FizzBuzz').eq('original_team', original_team));
    } else {
      ({ error } = await supabase.from('manual_event_scores')
        .insert({ event_name: 'FizzBuzz', original_team, marks: safeMarks, updated_at: now }));
    }
    if (error) { console.error('[fizzbuzz-score]', error); return res.status(500).json({ success: false, message: error.message }); }
    return res.json({ success: true, marks: safeMarks });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/admin/save-fizzbuzz-group-score ─────────────────────────────────
// Saves group score to all members. Imposter gets +10 if imposterBonus=true.
app.post('/api/admin/save-fizzbuzz-group-score', requireAdmin, async (req, res) => {
  try {
    const shuffled_group = String(req.body?.shuffled_group || req.body?.group || '').trim();
    const raw_score      = req.body?.group_score ?? req.body?.score;
    const group_score    = Number(raw_score);
    const imposter_bonus = !!(req.body?.imposter_bonus || req.body?.imposterBonus);

    if (!shuffled_group) return res.status(400).json({ success: false, message: 'shuffled_group is required.' });
    if (!Number.isFinite(group_score) || group_score < 0 || group_score > 100) {
      return res.status(400).json({ success: false, message: 'score must be 0–100.' });
    }
    const safeScore = Math.round(group_score);

    const { data: members, error: fetchErr } = await supabase
      .from('main_event_assignments')
      .select('participant_id, is_imposter, participant_name, original_team')
      .eq('shuffled_group', shuffled_group);

    if (fetchErr) { console.error('[fizzbuzz-group-score fetch]', fetchErr); return res.status(500).json({ success: false, message: fetchErr.message }); }
    if (!members || members.length === 0) return res.status(404).json({ success: false, message: 'No members found for: ' + shuffled_group });

    const updated = [];
    for (const m of members) {
      const memberScore = (imposter_bonus && m.is_imposter) ? Math.min(110, safeScore + 10) : safeScore;
      const bonusVal    = (imposter_bonus && m.is_imposter) ? 10 : 0;
      const { error: updErr } = await supabase
        .from('main_event_assignments')
        .update({ fizzbuzz_score: memberScore })
        .eq('participant_id', m.participant_id);
      if (updErr) { console.error('[fizzbuzz-group-score update]', m.participant_id, updErr.message); }
      else { updated.push({ participant_id: m.participant_id, name: m.participant_name, original_team: m.original_team, score: memberScore }); }
    }

    auditLog('fizzbuzz_group_score', shuffled_group, { group_score: safeScore, imposter_bonus });
    return res.json({ success: true, shuffled_group, group_score: safeScore, imposter_bonus, updated });
  } catch (err) { console.error('[fizzbuzz-group-score]', err.message); return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/admin/main-event-scores ─────────────────────────────────────────
app.get('/api/admin/main-event-scores', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('main_event_assignments')
      .select('participant_id, participant_name, original_team, shuffled_group, role_name, github_repo, ai_score, submission_status, is_imposter, fizzbuzz_score')
      .order('shuffled_group', { ascending: true });
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, participants: data || [] });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/admin/save-main-event-score ─────────────────────────────────────
app.post('/api/admin/save-main-event-score', requireAdmin, async (req, res) => {
  try {
    const participant_id = String(req.body?.participant_id || '').trim();
    const score          = Number(req.body?.score);
    if (!participant_id || isNaN(score)) return res.status(400).json({ success: false, message: 'participant_id and score required.' });
    const safeScore = Math.min(100, Math.max(0, score));
    const { error } = await supabase.from('main_event_assignments')
      .update({ ai_score: safeScore, main_event_score: safeScore })
      .eq('participant_id', participant_id);
    if (error) { console.error('[main-event-score]', error); return res.status(500).json({ success: false, message: error.message }); }
    return res.json({ success: true, score: safeScore });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/evaluate-submission/:participantId (admin re-trigger) ───────────

app.post('/api/evaluate-submission/:participantId', requireAdmin, evalLimiter, async (req, res) => {
  try {
    const participantId = String(req.params.participantId || '').trim();
    if (!(/^\d+$/.test(participantId) || isUUID(participantId))) return res.status(400).json({ success: false, message: 'Invalid participant ID.' });

    const { data: asgn, error: fetchErr } = await supabase
      .from('main_event_assignments')
      .select('participant_id, participant_name, github_repo, submission_status, evaluation_status, task_title, task_description, role_name, work_description, is_imposter')
      .eq('participant_id', participantId)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ success: false, message: fetchErr.message });
    if (!asgn)    return res.status(404).json({ success: false, message: 'Assignment not found.' });
    if (!asgn.github_repo) return res.status(400).json({ success: false, message: 'No GitHub repository has been submitted yet.' });

    // Only start if not already actively evaluating (prevents duplicate parallel jobs on rapid double-click)
    if (asgn.evaluation_status === 'Evaluating') {
      return res.status(409).json({ success: false, message: 'Evaluation is already in progress for ' + asgn.participant_name + '. Please wait.' });
    }

    // Mark as evaluating first so we get a clean start; guard against a concurrent request
    const { data: guardUpdate } = await supabase
      .from('main_event_assignments')
      .update({ evaluation_status: 'Evaluating', evaluation_started_at: new Date().toISOString() })
      .eq('participant_id', participantId)
      .neq('evaluation_status', 'Evaluating')
      .select('participant_id');

    if (!guardUpdate || guardUpdate.length === 0) {
      return res.status(409).json({ success: false, message: 'Evaluation is already in progress. Please wait.' });
    }

    res.json({ success: true, message: 'Re-evaluation started for ' + asgn.participant_name });

    runEvaluation(participantId, {
      github_repo:      asgn.github_repo,
      task_title:       asgn.task_title,
      task_description: asgn.task_description,
      role_name:        asgn.role_name,
      work_description: asgn.work_description,
      is_imposter:      asgn.is_imposter
    }, { retry: true, force: true }).catch(err => console.error('[re-eval]', participantId, err.message));

    auditLog('re_evaluate', participantId, { participant: asgn.participant_name });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/admin/cohort-report ──────────────────────────────────────────────
const handleCohortReport = async (req, res) => {
  try {
    const taskNumber = req.params.taskNumber ? parseInt(req.params.taskNumber, 10) : null;
    const { data: assignments, error: asgnErr } = await supabase
      .from('main_event_assignments')
      .select('*')
      .order('shuffled_group');
    if (asgnErr) return res.status(500).json({ success: false, message: asgnErr.message });

    const { data: evaluations } = await supabase
      .from('evaluations')
      .select('participant_id, criteria_scores, runtime_evidence, feedback')
      .eq('game_id', 'main_event');

    const evalMap = {};
    (evaluations || []).forEach(e => { evalMap[e.participant_id] = e; });

    const enriched = (assignments || []).map(a => {
      const e = evalMap[a.participant_id] || {};
      const cs = e.criteria_scores || {};
      return {
        ...a,
        passed_tests: cs.passed_tests || [],
        failed_tests: cs.failed_tests || [],
        unverified_tests: cs.unverified_tests || [],
        strengths: cs.strengths || [],
        weaknesses: cs.weaknesses || [],
        comparative_notes: cs.comparative_notes || [],
      };
    });

    if (taskNumber && [1, 2, 3].includes(taskNumber)) {
      const report = buildTaskCohortReport(taskNumber, enriched);
      return res.json({ success: true, report });
    }

    const report = buildFullEventCohortReport(enriched);
    return res.json({ success: true, report });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

app.get('/api/admin/cohort-report', requireAdmin, handleCohortReport);
app.get('/api/admin/cohort-report/:taskNumber', requireAdmin, handleCohortReport);

// ── GET /api/admin/event-progress ─────────────────────────────────────────────

app.get('/api/admin/event-progress', requireAdmin, async (req, res) => {
  try {
    const [assignRes, teamsRes, manualRes, allTeamsRes] = await Promise.all([
      supabase.from('main_event_assignments').select('submission_status, fizzbuzz_score, main_event_score, original_team'),
      supabase.from('participants').select('id'),
      supabase.from('manual_event_scores_v2').select('original_team'),
      supabase.from('teams').select('id')
    ]);

    const all        = assignRes.data || [];
    const totalPart  = (teamsRes.data || []).length;
    const submitted  = all.filter(r => r.submission_status === 'Submitted' || r.submission_status === 'Evaluated').length;
    const evaluated  = all.filter(r => r.submission_status === 'Evaluated').length;
    const fizzDone   = all.filter(r => r.fizzbuzz_score != null && r.fizzbuzz_score > 0).length;
    const uniqueTeams = [...new Set(all.map(r => r.original_team))].length;
    const manualTeams = (manualRes.data || []).length;

    // Determine N: prefer number of registered teams, fallback to unique teams in assignments
    const teamsCount = (allTeamsRes.data || []).length || uniqueTeams || 0;
    const expectedPart = teamsCount > 0 ? teamsCount * 4 : (uniqueTeams > 0 ? uniqueTeams * 4 : 0);

    return res.json({
      success: true,
      progress: {
        registration:      { done: totalPart >= expectedPart, label: `${totalPart}/${expectedPart} participants` },
        shuffle:           { done: all.length >= expectedPart, label: all.length >= expectedPart ? 'Groups assigned' : 'Not run' },
        github_submission: { done: submitted >= expectedPart, label: `${submitted}/${expectedPart} submitted` },
        ai_evaluation:     { done: evaluated >= expectedPart, label: `${evaluated}/${expectedPart} evaluated` },
        fizzbuzz:          { done: fizzDone >= all.length,   label: `${fizzDone}/${all.length} scored` },
        manual_events:     { done: manualTeams >= uniqueTeams, label: `${manualTeams}/${uniqueTeams} teams scored` },
        final_podium:      { done: evaluated >= expectedPart && fizzDone >= all.length && manualTeams >= uniqueTeams, label: 'All events complete' }
      }
    });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/admin/fizzbuzz/submissions (+ /submissions-v2 alias) ─────────────

async function getFizzBuzzSubmissions(req, res) {
  try {
    const { data, error } = await supabase.from('fizzbuzz_submissions_v2').select('*').order('submitted_at');
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, submissions: data || [] });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
}

app.get('/api/admin/fizzbuzz/submissions',    requireAdmin, getFizzBuzzSubmissions);
app.get('/api/admin/fizzbuzz/submissions-v2', requireAdmin, getFizzBuzzSubmissions);

// ── GET /api/admin/fizzbuzz/all-submissions ───────────────────────────────────
// Returns fizzbuzz_submissions_v2 only. No fallback to main_event_assignments.
app.get('/api/admin/fizzbuzz/all-submissions', requireAdmin, async (req, res) => {
  try {
    const { data: fzSubs, error: fzErr } = await supabase
      .from('fizzbuzz_submissions_v2')
      .select('*')
      .order('submitted_at');
    if (fzErr) return res.status(500).json({ success: false, message: fzErr.message });
    return res.json({ success: true, submissions: fzSubs || [], source: 'fizzbuzz' });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/admin/fizzbuzz/run-code ─────────────────────────────────────────
// Executes submitted FizzBuzz code via Judge0 CE (free, no auth).
// Endpoint: process.env.JUDGE0_URL (default: https://ce.judge0.com)
// Does NOT save scores.
app.post('/api/admin/fizzbuzz/run-code', requireAdmin, async (req, res) => {
  try {
    const shuffled_group = String(req.body?.shuffled_group || '').trim();
    const lang_override  = String(req.body?.language || '').trim();
    if (!shuffled_group) return res.status(400).json({ success: false, message: 'shuffled_group is required.' });

    const { data: fzSub } = await supabase.from('fizzbuzz_submissions_v2')
      .select('fizz_output, language, submitted_by').eq('shuffled_group', shuffled_group).maybeSingle();

    if (!fzSub || !fzSub.fizz_output) {
      return res.status(404).json({ success: false, message: 'No FizzBuzz submission found for group: ' + shuffled_group });
    }

    const language    = (lang_override || fzSub.language || 'python').toLowerCase().trim();
    const code        = fzSub.fizz_output;
    const submittedBy = fzSub.submitted_by;

    const GROQ_KEY = process.env.GROQ_API_KEY;

    if (!GROQ_KEY) {
        console.error('[run-code] Groq API configuration missing.');
        return res.json({ success: false, message: "Groq API configuration missing.", error: "Groq API configuration missing." });
    }

    console.log(`[run-code] API key exists. Language: ${language}, Code length: ${code.length}`);

    const prompt = `Language name: ${language}
Source code:
${code}
Execute mentally. Produce exactly the console output. If compilation/runtime error exists, return only the error message. No explanations. No markdown. No code fences.`;

    let groqResponse;
    try {
        groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_KEY}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1
            }),
            signal: AbortSignal.timeout(15000)
        });
    } catch (e) {
        console.error('[run-code] Fetch error:', e.message);
        return res.json({ success: false, message: `Groq fetch failed: ${e.message}`, error: `Groq fetch failed: ${e.message}` });
    }

    console.log(`[run-code] Groq response status: ${groqResponse.status}`);

    if (!groqResponse.ok) {
        const errText = await groqResponse.text().catch(() => 'No text returned');
        console.error(`[run-code] Groq API Error: ${groqResponse.status} - ${errText}`);
        return res.json({ success: false, message: `Groq API Error: ${groqResponse.status} - ${errText}`, error: `Groq API Error: ${groqResponse.status} - ${errText}` });
    }

    let groqData;
    let output = '';
    try {
        groqData = await groqResponse.json();
        output = (groqData.choices?.[0]?.message?.content || '').trim();
    } catch (e) {
        console.error('[run-code] Malformed response from Groq:', e.message);
        return res.json({ success: false, message: "Malformed response from Groq.", error: "Malformed response from Groq." });
    }

    const isError = /error|exception|traceback|segmentation fault|syntaxerror|typeerror|referenceerror/i.test(output);

    return res.json({
        success: true,
        shuffled_group,
        language,
        submitted_by: submittedBy,
        stdout: isError ? '' : output,
        stderr: isError ? output : '',
        compile_output: '',
        message: '',
        output: output || '(no output)',
        status: isError ? 'Compilation Error' : 'Accepted',
        exit_code: isError ? 1 : 0
    });
  } catch (err) {
    console.error('[run-code]', err.message);
    return res.status(500).json({ success: false, message: err.message, error: err.message });
  }
});

async function applyFizzBuzzScore(req, res) {
  try {
    const { shuffled_group, is_correct } = req.body;
    if (!shuffled_group || is_correct === undefined) return res.status(400).json({ success: false, message: 'shuffled_group and is_correct are required.' });

    const { data: sub } = await supabase.from('fizzbuzz_submissions_v2').select('*').eq('shuffled_group', shuffled_group).maybeSingle();
    if (!sub) return res.status(404).json({ success: false, message: 'No submission found for this group.' });

    await supabase.from('fizzbuzz_submissions_v2').update({ is_correct }).eq('shuffled_group', shuffled_group);

    // Load game config for scoring rules
    const config = await loadGameConfig('fizzbuzz');

    // Speed bonus: first two submissions get 5pts, others 2pts
    const { data: allSubs } = await supabase.from('fizzbuzz_submissions_v2').select('shuffled_group, submitted_at').order('submitted_at');
    const speedMap = {};
    (allSubs || []).forEach((s, i) => { speedMap[s.shuffled_group] = fizzbuzzLib.speedBonusForIndex(i, config); });

    const teamScore  = is_correct ? (config.correctTeamScore || 20) : (config.incorrectTeamScore || 0);
    const speedBonus = speedMap[shuffled_group] || fizzbuzzLib.speedBonusForIndex(99, config);

    // Evaluate imposter success using configured condition
    const tokens = fizzbuzzLib.parseFizzBuzzTokens(sub.fizz_output);
    const comparison = fizzbuzzLib.compareSequence(tokens, config);
    const imposterEval = fizzbuzzLib.evaluateImposterSuccess(comparison, config);
    const imposterBonus = imposterEval.success ? (config.imposterBonus || 10) : 0;

    await supabase.from('fizzbuzz_submissions_v2').update({
      speed_bonus: speedBonus,
      imposter_bonus: imposterBonus,
      is_correct
    }).eq('shuffled_group', shuffled_group);

    // Get all members with their original team info
    const { data: members } = await supabase.from('main_event_assignments').select(
      'participant_id, participant_name, is_imposter, main_event_score, original_team_id, original_team, shuffled_group'
    ).eq('shuffled_group', shuffled_group);

    // Calculate individual scores for each participant
    const individualScores = fizzbuzzLib.individualFizzBuzzScores(members, {
      isCorrect: is_correct,
      speedBonus: speedBonus,
      imposter: { success: imposterEval.success, bonus: imposterBonus, config }
    });

    // Apply individual scores and record score events
    for (const score of individualScores) {
      const mainScore = Number(score.baseScore || 0);
      const finalScore = score.finalScore;

      await supabase.from('main_event_assignments').update({
        fizzbuzz_score: finalScore
      }).eq('participant_id', score.participantId);

      // Record score event for audit trail
      try {
        await scoringLib.recordScoreEvent(supabase, {
          gameId: 'fizzbuzz',
          participantId: score.participantId,
          originalTeamId: score.originalTeamId,
          originalTeamName: score.originalTeam,
          sessionTeamId: score.sessionTeamId,
          points: finalScore,
          reason: `FizzBuzz individual score (base: ${score.baseScore}, imposter bonus: ${score.imposterBonus})`,
          type: scoringLib.TYPES.INDIVIDUAL_SCORE,
          idempotencyKey: `fizzbuzz:${score.participantId}:INDIVIDUAL_SCORE`
        });
      } catch (scoreErr) {
        console.error('[SCORE_CREATED] ledger write failed for FizzBuzz:', scoreErr.message);
      }
    }

    auditLog('fizzbuzz_score', shuffled_group, {
      is_correct,
      team_score: teamScore,
      speed_bonus: speedBonus,
      imposter_success: imposterEval.success,
      imposter_bonus: imposterBonus,
      imposter_reason: imposterEval.reason
    });

    return res.json({
      success: true,
      message: 'Scores applied for ' + shuffled_group,
      team_score: teamScore,
      speed_bonus: speedBonus,
      imposter_bonus: imposterBonus,
      imposter_success: imposterEval.success,
      individual_scores: individualScores
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

app.post('/api/admin/fizzbuzz/score',    requireAdmin, applyFizzBuzzScore);
app.post('/api/admin/fizzbuzz/score-v2', requireAdmin, applyFizzBuzzScore);

// ── POST /api/admin/fizzbuzz/toggle ───────────────────────────────────────────
// action: "on" → status = active   |   action: "off" → status = closed
app.post('/api/admin/fizzbuzz/toggle', requireAdmin, async (req, res) => {
  try {
    const { action } = req.body;
    if (!action) return res.status(400).json({ success: false, message: 'action required: "on" or "off"' });

    const newStatus = action === 'on' ? 'active' : 'closed';
    const open      = action === 'on';

    const { error } = await supabase.from('event_timers')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('event_key', 'fizzbuzz');
    if (error) return res.status(500).json({ success: false, message: error.message });

    auditLog('fizzbuzz_toggle', 'fizzbuzz', { action });
    return res.json({ success: true, fizzbuzz_open: open, status: newStatus });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── Timer control routes ──────────────────────────────────────────────────────

app.get('/api/timers', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('event_timers').select('*').order('event_key');
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, timers: (data || []).map(t => normaliseTimer(t)) });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

async function timerAction(eventKey, action, extraPayload = {}) {
  const { data: t, error } = await supabase.from('event_timers').select('*').eq('event_key', eventKey).maybeSingle();
  if (error || !t) return { ok: false, message: 'Timer not found: ' + eventKey };

  const result = timerLib.applyTimerAction(t, action, extraPayload);
  if (!result.ok) return result;

  const { error: updErr } = await supabase.from('event_timers').update(result.update).eq('event_key', eventKey);
  if (updErr) return { ok: false, message: updErr.message };

  if (result.ignore) {
    return { ok: true, status: t.status, remaining_seconds: timerLib.computeRemaining(t) };
  }

  return { ok: true, status: result.update.status || t.status, remaining_seconds: result.update.remaining_seconds };
}

['start', 'pause', 'resume', 'reset', 'finish', 'tick'].forEach(action => {
  app.post(`/api/event/${action}`, requireAdmin, async (req, res) => {
    try {
      const eventKey = resolveEventKey(String(req.body?.eventKey || '').trim());
      if (!eventKey) return res.status(400).json({ success: false, message: 'eventKey is required.' });
      const result = await timerAction(eventKey, action, req.body);
      if (!result.ok) return res.status(400).json({ success: false, message: result.message });
      auditLog('timer_' + action, eventKey, {});
      return res.json({ success: true, ...result });
    } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
  });
});

// Legacy timer endpoints (preserve compatibility)
app.get('/api/timer/:eventName', async (req, res) => {
  try {
    const key = resolveEventKey(decodeURIComponent(req.params.eventName || '').trim());
    const { data, error } = await supabase.from('event_timers').select('*').eq('event_key', key).maybeSingle();
    if (error || !data) return res.status(404).json({ success: false, message: 'Timer not found: ' + key });
    return res.json({ success: true, timer: normaliseTimer(data) });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── Unlock shuffle lock (admin safety valve) ──────────────────────────────────

app.post('/api/admin/unlock-shuffle', requireAdmin, async (req, res) => {
  try {
    await supabase.from('shuffle_lock').update({ is_locked: false }).eq('id', 1);
    auditLog('unlock_shuffle', 'shuffle_lock', {});
    return res.json({ success: true, message: 'Shuffle lock removed. You can now run the shuffle again.' });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/admin/shuffle-status ─────────────────────────────────────────────

app.get('/api/admin/shuffle-status', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('shuffle_lock').select('is_locked, locked_at, locked_by').eq('id', 1).maybeSingle();
    if (error) return res.status(500).json({ success: false, message: error.message });
    const hasAssignments = !!(await supabase.from('main_event_assignments').select('participant_id').limit(1).maybeSingle()).data;
    return res.json({
      success:          true,
      is_locked:        data?.is_locked  ?? false,
      locked_at:        data?.locked_at  ?? null,
      locked_by:        data?.locked_by  ?? null,
      has_assignments:  hasAssignments
    });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/admin/lock-shuffle ──────────────────────────────────────────────

app.post('/api/admin/lock-shuffle', requireAdmin, async (req, res) => {
  try {
    await supabase.from('shuffle_lock')
      .update({ is_locked: true, locked_at: new Date().toISOString(), locked_by: 'coordinator' })
      .eq('id', 1);
    auditLog('lock_shuffle', 'shuffle_lock', {});
    return res.json({ success: true, message: 'Shuffle locked.' });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/admin/audit-log ──────────────────────────────────────────────────

app.get('/api/admin/audit-log', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, log: data || [] });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/admin/code-imposter-submissions ──────────────────────────────────

app.get('/api/admin/code-imposter-submissions', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('code_imposter_submissions').select('*').order('submitted_at');
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, submissions: data || [] });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/admin/update-main-event-score ───────────────────────────────────

app.post('/api/admin/update-main-event-score', requireAdmin, async (req, res) => {
  try {
    const participant_id   = String(req.body?.participant_id || '').trim();
    const main_event_score = clampScore(req.body?.score, 0, 100);
    if (!isUUID(participant_id)) return res.status(400).json({ success: false, message: 'Invalid participant ID.' });

    // Just update main_event_score directly — no extra columns needed
    const { error } = await supabase.from('main_event_assignments').update({
      main_event_score
    }).eq('participant_id', participant_id);
    if (error) return res.status(500).json({ success: false, message: error.message });

    // Also mark the submission as Evaluated so it counts in the podium and overview stats.
    // Only set ai_score/ai_feedback when AI never ran (ai_score IS NULL) — don't overwrite a real AI result.
    await supabase.from('main_event_assignments').update({
      submission_status: 'Evaluated',
      evaluation_status: 'Evaluated',
      ai_score: main_event_score,
      ai_feedback: 'Manually scored by admin.',
    }).eq('participant_id', participant_id).is('ai_score', null);

    auditLog('update_main_score', participant_id, { score: main_event_score });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/admin/mark-evaluated ────────────────────────────────────────────
// Marks a participant's submission as Evaluated. Called by the frontend after
// a manual score entry to ensure the participant counts in the podium. Idempotent.

app.post('/api/admin/mark-evaluated', requireAdmin, async (req, res) => {
  try {
    const participant_id = String(req.body?.participant_id || '').trim();
    if (!isUUID(participant_id)) return res.status(400).json({ success: false, message: 'Invalid participant ID.' });

    const { data: current } = await supabase
      .from('main_event_assignments')
      .select('participant_id')
      .eq('participant_id', participant_id)
      .maybeSingle();

    if (!current) return res.status(404).json({ success: false, message: 'Assignment not found.' });

    await supabase.from('main_event_assignments').update({
      submission_status: 'Evaluated',
      evaluation_status: 'Evaluated',
    }).eq('participant_id', participant_id);

    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── POST /api/admin/recover-evaluations ──────────────────────────────────────
// Finds all submissions stuck in 'Queued' or 'Evaluating' (for >5 minutes)
// and re-runs their AI evaluation. Use this after a Vercel cold-start/timeout.

app.post('/api/admin/recover-evaluations', requireAdmin, async (req, res) => {
  try {
    // Queued: evaluation never started
    // Evaluating + old: evaluation started but runtime was terminated (Vercel)
    const { data: stuck, error } = await supabase
      .from('main_event_assignments')
      .select('participant_id, participant_name, github_repo, task_title, task_description, role_name, work_description, is_imposter, evaluation_status, submitted_at')
      .in('evaluation_status', ['Queued', 'Evaluating'])
      .not('github_repo', 'is', null);

    if (error) return res.status(500).json({ success: false, message: error.message });

    const candidates = (stuck || []).filter(r => {
      if (r.evaluation_status === 'Queued') return true;
      // Only recover 'Evaluating' rows that are older than 5 minutes (truly stuck)
      if (r.evaluation_status === 'Evaluating' && r.submitted_at) {
        return new Date(r.submitted_at).getTime() < Date.now() - 5 * 60 * 1000;
      }
      return false;
    });

    if (candidates.length === 0) {
      return res.json({ success: true, message: 'No stuck evaluations found.', recovered: 0 });
    }

    // Respond immediately with count, then run evaluations in background
    res.json({
      success:   true,
      message:   `Recovering ${candidates.length} stuck evaluation(s). Check the participants tab for progress.`,
      recovered: candidates.length,
      participants: candidates.map(c => c.participant_name)
    });

    // Fire evaluations after response (admin-triggered, coordinator is watching)
    for (const row of candidates) {
      runEvaluation(row.participant_id, {
        github_repo:      row.github_repo,
        task_title:       row.task_title,
        task_description: row.task_description,
        role_name:        row.role_name,
        work_description: row.work_description,
        is_imposter:      row.is_imposter
      }, { retry: true, force: true }).catch(err => console.error('[recover-eval]', row.participant_id, err.message));
    }

    auditLog('recover_evaluations', 'system', { count: candidates.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── Catch-all for unknown routes ──────────────────────────────────────────────

// ── Static frontend (local dev only) ─────────────────────────────────────────
// Serves the frontend/ folder at clean URLs so the same setup works in the
// browser without a separate static server:
//   http://localhost:3000/          → homepage
//   http://localhost:3000/admin     → admin dashboard
//   http://localhost:3000/coordinator → team registration
//   http://localhost:3000/fizzbuzz  → fizzbuzz rules page
//   http://localhost:3000/game      → main event page
//   http://localhost:3000/fizzbuzz-coding → fizzbuzz coding page
//   http://localhost:3000/code-imposter   → code imposter page
// On Vercel, static files are served by @vercel/static via vercel.json.
if (!process.env.VERCEL) {
  const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

  // Named clean-URL routes (must come before the catch-all static middleware)
  const PAGE_MAP = {
    '/':                  'homepage.html',
    '/admin':             'admindashboard.html',
    '/coordinator':       'team_registration.html',
    '/fizzbuzz':          'fizzbuzz.html',
    '/fizzbuzz-coding':   'fizzbuzz_coding.html',
    '/game':              'main_event_page.html',
    '/code-imposter':     'codeimposter.html',
  };

  Object.entries(PAGE_MAP).forEach(([route, file]) => {
    app.get(route, (_req, res) => res.sendFile(path.join(FRONTEND_DIR, file)));
  });

  // Also serve raw .html filenames and any other static assets (CSS, JS, images)
  app.use(express.static(FRONTEND_DIR));
}

app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.path}` });
});

// ── Error handler ─────────────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error('[server error]', err.message);
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

// ── Start (local dev only — Vercel uses module.exports = app) ─────────────────

// Only bind the HTTP port when running locally (not in Vercel serverless).
// In Vercel, process.env.VERCEL is set to '1' at runtime.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[ASTHRA Imposter] Server running on port ${PORT}`);
    console.log(`[ASTHRA Imposter] Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  });
}

module.exports = app; // needed for Vercel serverless
