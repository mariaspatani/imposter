'use strict';

const express   = require('express');
const cors      = require('cors');
const crypto    = require('crypto');
require('dotenv').config();

const { createClient }    = require('@supabase/supabase-js');
const { evaluateSubmission, validateRepository } = require('./aiScorer');
const { requireAdmin }    = require('./middleware/auth');
const { authLimiter, submitLimiter, evalLimiter, registerLimiter, adminLimiter } = require('./middleware/rateLimit');
const { isValidGitHubUrl, sanitizeName, isUUID, clampScore, escHtml } = require('./middleware/sanitize');

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
  'admin_sessions', 'audit_log'
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

// CORS: allow only trusted origins
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || 'http://localhost:8080')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // Allow same-origin (no origin header) and explicitly listed origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
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

/** Compute server-side remaining seconds from a timer row. */
function computeRemaining(t) {
  if (!t) return 0;
  const fullSecs = (t.duration_minutes || 15) * 60;

  if (t.status === 'finished') return 0;

  if (t.status === 'running' && t.started_at) {
    const runningFor = Math.floor((Date.now() - new Date(t.started_at).getTime()) / 1000);
    // If remaining_seconds is 0 or null (e.g. fresh start before first tick), fall back to full duration.
    const stored     = (t.remaining_seconds != null && t.remaining_seconds > 0) ? t.remaining_seconds : fullSecs;
    return Math.max(0, stored - runningFor);
  }

  // idle / paused / waiting / stopped / any other state — return the snapshotted value
  if (t.remaining_seconds != null && t.remaining_seconds > 0) return t.remaining_seconds;
  return fullSecs;
}

function normaliseTimer(t) {
  const remaining = computeRemaining(t);
  return {
    event_key:         t.event_key,
    event_name:        t.event_name || t.event_key,
    duration_minutes:  t.duration_minutes,
    remaining_seconds: remaining,
    status:            t.status || 'idle',
    started_at:        t.started_at,
    paused_at:         t.paused_at
  };
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
    if (!isUUID(participantId)) {
      return res.status(400).json({ success: false, message: 'Invalid participant ID.' });
    }

    const { data, error } = await supabase
      .from('main_event_assignments')
      .select(
        'participant_id, participant_name, original_team, shuffled_group, ' +
        'task_number, task_title, task_description, ' +
        'person_slot, role_name, work_description, is_imposter, ' +
        'github_repo, github_owner, github_repo_name, submission_status, evaluation_status, submitted_at, ' +
        'ai_score, ui_score, task_match_score, logic_score, creativity_score, code_quality_score, ai_feedback'
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
 */
async function runEvaluation(participantId, assignmentData) {
  // Mark as evaluating
  await supabase
    .from('main_event_assignments')
    .update({ evaluation_status: 'Evaluating' })
    .eq('participant_id', participantId);

  try {
    const result = await evaluateSubmission(assignmentData);

    await supabase.from('main_event_assignments').update({
      ai_score:           result.total_score,
      ui_score:           result.ui_score,
      task_match_score:   result.task_completion_score,
      logic_score:        result.logic_score,
      creativity_score:   result.creativity_score,
      code_quality_score: result.responsiveness_score,
      ai_feedback:        result.feedback,
      evaluation_status:  'Evaluated',
      submission_status:  'Evaluated'
    }).eq('participant_id', participantId);

    console.log('[eval] Completed for', participantId, '— score:', result.total_score);

  } catch (evalErr) {
    console.error('[eval] Failed for', participantId, ':', evalErr.message);

    // Preserve submission — only mark evaluation as failed
    await supabase.from('main_event_assignments').update({
      evaluation_status: 'Failed',
      ai_feedback:       'Evaluation failed: ' + evalErr.message.slice(0, 200)
    }).eq('participant_id', participantId).catch(() => {});
  }
}

// ── GET /api/fizzbuzz/toggle ──────────────────────────────────────────────────

app.get('/api/fizzbuzz/toggle', async (req, res) => {
  try {
    const { data } = await supabase
      .from('event_timers')
      .select('*')
      .eq('event_key', 'fizzbuzz')
      .maybeSingle();
    if (!data) return res.json({ success: true, fizzbuzz_open: false, status: 'idle', remaining_seconds: 900 });
    const norm = normaliseTimer(data);
    const open = norm.status === 'running' || norm.status === 'paused';
    return res.json({ success: true, fizzbuzz_open: open, status: norm.status, remaining_seconds: norm.remaining_seconds });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/fizzbuzz/status/:participantId ───────────────────────────────────

app.get('/api/fizzbuzz/status/:participantId', async (req, res) => {
  try {
    const participantId = String(req.params.participantId || '').trim();
    if (!isUUID(participantId)) {
      return res.status(400).json({ success: false, message: 'Invalid participant ID.' });
    }

    const { data: assignment, error: aErr } = await supabase
      .from('main_event_assignments')
      .select('participant_id, participant_name, shuffled_group, is_imposter, fizzbuzz_locked')
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

    // Timer info
    const { data: timer } = await supabase
      .from('event_timers')
      .select('*')
      .eq('event_key', 'fizzbuzz')
      .maybeSingle();

    const remaining = timer ? computeRemaining(timer) : 0;

    // Secret rule — only for imposter
    const secretRule = assignment.is_imposter
      ? 'CLASSIFIED MISSION: When the number is divisible by both 3 and 5, convince the team to print the NUMBER ITSELF instead of "FizzBuzz". Do not reveal this to anyone.'
      : null;

    return res.json({
      success:          true,
      shuffled_group:   assignment.shuffled_group,
      participant_name: assignment.participant_name,
      is_imposter:      assignment.is_imposter,
      secret_rule:      secretRule,
      group_submitted:  !!groupSub,
      group_submission: groupSub ? { submitted_by: groupSub.submitted_by, submitted_at: groupSub.submitted_at } : null,
      fizzbuzz_locked:  assignment.fizzbuzz_locked || !!groupSub,
      timer_status:     timer?.status || 'idle',
      remaining_secs:   remaining
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

    if (!isUUID(participant_id)) return res.status(400).json({ success: false, message: 'Invalid participant ID.' });
    if (!fizz_output)            return res.status(400).json({ success: false, message: 'Code/output is required.' });

    const { data: assignment } = await supabase
      .from('main_event_assignments')
      .select('participant_id, participant_name, shuffled_group, is_imposter, fizzbuzz_locked')
      .eq('participant_id', participant_id)
      .maybeSingle();

    if (!assignment) return res.status(404).json({ success: false, message: 'Assignment not found.' });

    // Check timer — block if missing, finished, or expired
    const { data: timer } = await supabase
      .from('event_timers')
      .select('*')
      .eq('event_key', 'fizzbuzz')
      .maybeSingle();

    if (!timer) {
      return res.status(403).json({ success: false, message: 'FizzBuzz round is not currently open.' });
    }

    const fbRemaining = computeRemaining(timer);
    if (timer.status === 'finished' || (timer.status === 'running' && fbRemaining <= 0)) {
      return res.status(403).json({ success: false, message: 'FizzBuzz round has ended. No more submissions.' });
    }
    if (timer.status !== 'running') {
      return res.status(403).json({ success: false, message: 'FizzBuzz round is not currently open.' });
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
      return res.status(500).json({ success: false, message: 'Submission failed. Please try again.' });
    }

    // Lock all 4 members of the group
    await supabase.from('main_event_assignments')
      .update({ fizzbuzz_locked: true, fizzbuzz_completed: true })
      .eq('shuffled_group', assignment.shuffled_group);

    return res.json({
      success:        true,
      shuffled_group: assignment.shuffled_group,
      submitted_by:   assignment.participant_name,
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
    return res.json({ success: true, timers: (data || []).map(normaliseTimer) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/my-scores/:participantId ─────────────────────────────────────────

app.get('/api/my-scores/:participantId', async (req, res) => {
  try {
    const participantId = String(req.params.participantId || '').trim();
    if (!isUUID(participantId)) return res.status(400).json({ success: false, message: 'Invalid participant ID.' });

    const { data, error } = await supabase
      .from('main_event_assignments')
      .select('participant_name, main_event_score, fizzbuzz_score, fizzbuzz_team_score, fizzbuzz_speed_bonus, imposter_bonus, ai_score')
      .eq('participant_id', participantId)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, message: error.message });
    if (!data)  return res.status(404).json({ success: false, message: 'Not found.' });

    return res.json({
      success: true,
      scores: {
        participant_name:     data.participant_name,
        main_event_score:     Number(data.main_event_score  || 0),
        fizzbuzz_score:       Number(data.fizzbuzz_score    || 0),
        fizzbuzz_team_score:  Number(data.fizzbuzz_team_score  || 0),
        fizzbuzz_speed_bonus: Number(data.fizzbuzz_speed_bonus || 0),
        imposter_bonus:       Number(data.imposter_bonus    || 0),
        ai_score:             Number(data.ai_score          || 0)
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
      await supabase.from('teams').delete().eq('id', teamId).catch(() => {});
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

    if (!teams || teams.length !== 6 || completeTeams.length !== 6 || (participants || []).length !== 24) {
      return res.json({ success: true, participants: [], seating_ready: false });
    }

    const shuffled = (participants || []).every(p => p.shuffle_group && p.shuffle_group !== 'Unassigned');
    if (!shuffled) return res.json({ success: true, participants: [], seating_ready: false });

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

    return res.json({ success: true, participants: seatRows, seating_ready: true });
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

    if (lockRow?.is_locked && !forceReset) {
      return res.status(409).json({
        success:   false,
        locked:    true,
        locked_at: lockRow.locked_at,
        message:   'Shuffle has already been run and is locked. Pass force_reset:true to override (this will wipe all existing submissions and scores).'
      });
    }

    // Validate 6 complete teams
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
    if (teamIds.length !== 6 || teamIds.some(tid => byTeam[tid].length !== 4)) {
      return res.status(400).json({
        success: false,
        message: 'Exactly 6 teams with 4 members each are required to run the shuffle.'
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

    // Step C: Build 6 groups
    const groups = Array.from({ length: 6 }, (_, i) => ({
      groupName:   `Group ${i + 1}`,
      imposter:    shuffledImposters[i],
      specialists: []
    }));

    // Step D: Assign specialists (no team conflict with imposter or other specialists in group)
    const allSpecialists = [];
    for (const tid of teamIds) allSpecialists.push(...specialistsByTeam[tid]);

    let assigned = false;
    for (let attempt = 0; attempt < 500 && !assigned; attempt++) {
      const working = groups.map(g => ({ ...g, specialists: [] }));
      const pool    = [...allSpecialists].sort(() => Math.random() - 0.5);
      let valid     = true;

      for (const specialist of pool) {
        const eligible = working.filter(wg =>
          wg.specialists.length < 3 &&
          wg.imposter.team_id !== specialist.team_id &&
          !wg.specialists.some(s => s.team_id === specialist.team_id)
        );
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

    // Step E: Write participant roles
    for (const group of groups) {
      for (const m of group.specialists) {
        await supabase.from('participants').update({ is_imposter: false, shuffle_group: group.groupName, player_role: 'Specialist' }).eq('id', m.id);
      }
      await supabase.from('participants').update({ is_imposter: true, shuffle_group: group.groupName, player_role: 'Imposter' }).eq('id', group.imposter.id);
    }

    // Step F: Load tasks — hard-fail if not seeded (prevents fake data reaching participants)
    const { data: tasks, error: taskErr } = await supabase.from('main_event_tasks').select('*').order('task_number');
    if (taskErr) return res.status(500).json({ success: false, message: 'Failed to load tasks: ' + taskErr.message });
    if (!tasks || tasks.length < 3) {
      return res.status(500).json({ success: false, message: 'Task data is missing. Run the migration SQL to seed tasks 1-3 before shuffling.' });
    }

    const taskByNumber = {};
    tasks.forEach(t => { taskByNumber[t.task_number] = t; });

    // Group assignment: Groups 1+4 → Task 1, Groups 2+5 → Task 2, Groups 3+6 → Task 3
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

    // Validate all groups have tasks BEFORE writing any participant roles (Step E moved after this check)
    for (const group of groups) {
      if (!taskForGroup(group.groupName)) {
        return res.status(500).json({ success: false, message: `No task found for ${group.groupName}. Check task seeds.` });
      }
    }

    // Step G: Delete old assignments using an always-true condition; check error before proceeding
    const { error: delErr } = await supabase
      .from('main_event_assignments')
      .delete()
      .not('participant_id', 'is', null);
    if (delErr) return res.status(500).json({ success: false, message: 'Failed to clear old assignments: ' + delErr.message });

    // If force_reset: also wipe FizzBuzz submissions so the full event state is clean
    if (forceReset) {
      await supabase.from('fizzbuzz_submissions_v2').delete().not('shuffled_group', 'is', null).catch(() => {});
    }

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

    // Step I: Lock shuffle
    await supabase.from('shuffle_lock').update({ is_locked: true, locked_at: new Date().toISOString(), locked_by: 'coordinator' }).eq('id', 1);

    auditLog('start_shuffle', 'all_participants', { groups_created: 6, force_reset: forceReset });
    return res.json({ success: true, imposters_selected: 6, groups_created: 6, assignments_written: true, assignments_count: rows.length });

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
    const { data, error } = await supabase.from('main_event_assignments').select('*').order('shuffled_group');
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, participants: data || [] });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /api/admin/team-scores ────────────────────────────────────────────────

app.get('/api/admin/team-scores', requireAdmin, async (req, res) => {
  try {
    const [assignRes, manualRes] = await Promise.all([
      supabase.from('main_event_assignments').select('original_team, main_event_score, fizzbuzz_score, ai_score'),
      supabase.from('manual_event_scores_v2').select('*')
    ]);

    const teamMap = {};
    (assignRes.data || []).forEach(r => {
      const t = r.original_team || 'Unknown';
      if (!teamMap[t]) teamMap[t] = { team: t, main_event_total: 0, fizzbuzz_total: 0, manual_total: 0, grand_total: 0 };
      teamMap[t].main_event_total += Number(r.main_event_score || 0);
      teamMap[t].fizzbuzz_total   += Number(r.fizzbuzz_score   || 0);
    });
    (manualRes.data || []).forEach(r => {
      const t = r.original_team;
      if (!teamMap[t]) teamMap[t] = { team: t, main_event_total: 0, fizzbuzz_total: 0, manual_total: 0, grand_total: 0 };
      teamMap[t].manual_total += Number(r.code_imposter || 0) + Number(r.sherlock || 0) + Number(r.drawing || 0);
    });

    const scores = Object.values(teamMap).map(t => { t.grand_total = t.main_event_total + t.fizzbuzz_total + t.manual_total; return t; }).sort((a, b) => b.grand_total - a.grand_total);
    return res.json({ success: true, scores });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
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

// ── POST /api/evaluate-submission/:participantId (admin re-trigger) ───────────

app.post('/api/evaluate-submission/:participantId', requireAdmin, evalLimiter, async (req, res) => {
  try {
    const participantId = String(req.params.participantId || '').trim();
    if (!isUUID(participantId)) return res.status(400).json({ success: false, message: 'Invalid participant ID.' });

    const { data: asgn, error: fetchErr } = await supabase
      .from('main_event_assignments')
      .select('participant_id, participant_name, github_repo, submission_status, evaluation_status, task_title, task_description, role_name, work_description, is_imposter')
      .eq('participant_id', participantId)
      .maybeSingle();

    if (fetchErr) return res.status(500).json({ success: false, message: fetchErr.message });
    if (!asgn)    return res.status(404).json({ success: false, message: 'Assignment not found.' });
    if (!asgn.github_repo) return res.status(400).json({ success: false, message: 'No GitHub repository has been submitted yet.' });

    // Only start if not already actively evaluating (prevents duplicate parallel jobs on rapid double-click)
    if (asgn.submission_status === 'Evaluating' || asgn.evaluation_status === 'Evaluating') {
      return res.status(409).json({ success: false, message: 'Evaluation is already in progress for ' + asgn.participant_name + '. Please wait.' });
    }

    // Mark as evaluating and respond immediately
    const { data: guardUpdate } = await supabase
      .from('main_event_assignments')
      .update({ evaluation_status: 'Evaluating' })
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
    }).catch(err => console.error('[re-eval]', participantId, err.message));

    auditLog('re_evaluate', participantId, { participant: asgn.participant_name });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/admin/event-progress ─────────────────────────────────────────────

app.get('/api/admin/event-progress', requireAdmin, async (req, res) => {
  try {
    const [assignRes, teamsRes, manualRes] = await Promise.all([
      supabase.from('main_event_assignments').select('submission_status, fizzbuzz_score, main_event_score, original_team'),
      supabase.from('participants').select('id'),
      supabase.from('manual_event_scores_v2').select('original_team')
    ]);

    const all        = assignRes.data || [];
    const totalPart  = (teamsRes.data || []).length;
    const submitted  = all.filter(r => r.submission_status === 'Submitted' || r.submission_status === 'Evaluated').length;
    const evaluated  = all.filter(r => r.submission_status === 'Evaluated').length;
    const fizzDone   = all.filter(r => r.fizzbuzz_score != null && r.fizzbuzz_score > 0).length;
    const uniqueTeams = [...new Set(all.map(r => r.original_team))].length;
    const manualTeams = (manualRes.data || []).length;

    return res.json({
      success: true,
      progress: {
        registration:      { done: totalPart >= 24,          label: `${totalPart}/24 participants` },
        shuffle:           { done: all.length >= 24,         label: all.length >= 24 ? 'Groups assigned' : 'Not run' },
        github_submission: { done: submitted >= 24,          label: `${submitted}/24 submitted` },
        ai_evaluation:     { done: evaluated >= 24,          label: `${evaluated}/24 evaluated` },
        fizzbuzz:          { done: fizzDone >= all.length,   label: `${fizzDone}/${all.length} scored` },
        manual_events:     { done: manualTeams >= uniqueTeams, label: `${manualTeams}/${uniqueTeams} teams scored` },
        final_podium:      { done: evaluated >= 24 && fizzDone >= all.length && manualTeams >= uniqueTeams, label: 'All events complete' }
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

// ── POST /api/admin/fizzbuzz/score (+ /score-v2 alias) ───────────────────────

async function applyFizzBuzzScore(req, res) {
  try {
    const { shuffled_group, is_correct } = req.body;
    if (!shuffled_group || is_correct === undefined) return res.status(400).json({ success: false, message: 'shuffled_group and is_correct are required.' });

    const { data: sub } = await supabase.from('fizzbuzz_submissions_v2').select('*').eq('shuffled_group', shuffled_group).maybeSingle();
    if (!sub) return res.status(404).json({ success: false, message: 'No submission found for this group.' });

    await supabase.from('fizzbuzz_submissions_v2').update({ is_correct }).eq('shuffled_group', shuffled_group);

    // Speed bonus: first two submissions get 5pts, others 2pts
    const { data: allSubs } = await supabase.from('fizzbuzz_submissions_v2').select('shuffled_group, submitted_at').order('submitted_at');
    const speedMap = {};
    (allSubs || []).forEach((s, i) => { speedMap[s.shuffled_group] = i < 2 ? 5 : 2; });

    const teamScore  = is_correct ? 20 : 0;
    const speedBonus = speedMap[shuffled_group] || 2;
    const sabotaged  = sub.imposter_sabotaged && !is_correct;

    await supabase.from('fizzbuzz_submissions_v2').update({ speed_bonus: speedBonus, imposter_bonus: sabotaged ? 10 : 0 }).eq('shuffled_group', shuffled_group);

    const { data: members } = await supabase.from('main_event_assignments').select('participant_id, is_imposter, main_event_score').eq('shuffled_group', shuffled_group);

    for (const m of (members || [])) {
      const impBonus  = (sabotaged && m.is_imposter) ? 10 : 0;
      const fzScore   = sabotaged ? 0 : (teamScore + speedBonus);
      const mainScore = Number(m.main_event_score || 0);
      await supabase.from('main_event_assignments').update({
        fizzbuzz_team_score: sabotaged ? 0 : teamScore, fizzbuzz_speed_bonus: speedBonus,
        imposter_bonus: impBonus, fizzbuzz_score: fzScore + impBonus,
        total_individual_score: mainScore + fzScore + impBonus
      }).eq('participant_id', m.participant_id);
    }

    auditLog('fizzbuzz_score', shuffled_group, { is_correct, team_score: teamScore, speed_bonus: speedBonus });
    return res.json({ success: true, message: 'Scores applied for ' + shuffled_group });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
}

app.post('/api/admin/fizzbuzz/score',    requireAdmin, applyFizzBuzzScore);
app.post('/api/admin/fizzbuzz/score-v2', requireAdmin, applyFizzBuzzScore);

// ── POST /api/admin/fizzbuzz/toggle ───────────────────────────────────────────

app.post('/api/admin/fizzbuzz/toggle', requireAdmin, async (req, res) => {
  try {
    const { action } = req.body;
    if (!action) return res.status(400).json({ success: false, message: 'action required: "on" or "off"' });

    const { data: t } = await supabase.from('event_timers').select('*').eq('event_key', 'fizzbuzz').maybeSingle();
    if (!t) return res.status(404).json({ success: false, message: 'FizzBuzz timer not found.' });

    const fullSecs = (t.duration_minutes || 15) * 60;
    if (action === 'on') {
      // Guard: do not reset an already-running timer
      if (t.status === 'running') {
        return res.status(409).json({ success: false, message: 'FizzBuzz round is already running.' });
      }
      await supabase.from('event_timers').update({ status: 'running', started_at: new Date().toISOString(), paused_at: null, remaining_seconds: fullSecs }).eq('event_key', 'fizzbuzz');
      auditLog('fizzbuzz_toggle', 'fizzbuzz', { action: 'on' });
      return res.json({ success: true, fizzbuzz_open: true, status: 'running', remaining_seconds: fullSecs });
    } else {
      await supabase.from('event_timers').update({ status: 'idle', started_at: null, paused_at: null, remaining_seconds: fullSecs }).eq('event_key', 'fizzbuzz');
      auditLog('fizzbuzz_toggle', 'fizzbuzz', { action: 'off' });
      return res.json({ success: true, fizzbuzz_open: false, status: 'idle', remaining_seconds: fullSecs });
    }
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ── Timer control routes ──────────────────────────────────────────────────────

app.get('/api/timers', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('event_timers').select('*').order('event_key');
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, timers: (data || []).map(normaliseTimer) });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

async function timerAction(eventKey, action, extraPayload = {}) {
  const { data: t, error } = await supabase.from('event_timers').select('*').eq('event_key', eventKey).maybeSingle();
  if (error || !t) return { ok: false, message: 'Timer not found: ' + eventKey };

  const fullSecs = (t.duration_minutes || 15) * 60;
  let update     = {};

  if (action === 'start') {
    if (t.status === 'running') return { ok: false, message: 'Timer is already running.' };
    if (t.status === 'finished') return { ok: false, message: 'Timer has already finished. Use reset first.' };
    // Fresh start always begins from full duration
    update = { status: 'running', started_at: new Date().toISOString(), paused_at: null, remaining_seconds: fullSecs };
  } else if (action === 'pause') {
    if (t.status !== 'running') return { ok: false, message: 'Timer is not running.' };
    // Snapshot remaining_seconds at pause time so resume can correctly subtract elapsed from this value.
    // computeRemaining already accounts for elapsed since started_at — use it directly.
    const remaining = computeRemaining(t);
    update = { status: 'paused', paused_at: new Date().toISOString(), started_at: null, remaining_seconds: remaining };
  } else if (action === 'resume') {
    if (t.status !== 'paused') return { ok: false, message: 'Timer is not paused.' };
    // Resume from saved remaining_seconds snapshot — do NOT modify remaining_seconds here.
    // computeRemaining(t) will correctly return: remaining_seconds - (now - started_at).
    update = { status: 'running', started_at: new Date().toISOString(), paused_at: null };
  } else if (action === 'reset') {
    update = { status: 'idle', started_at: null, paused_at: null, remaining_seconds: fullSecs };
  } else if (action === 'finish') {
    update = { status: 'finished', remaining_seconds: 0, started_at: null };
  } else if (action === 'tick') {
    const rs = Number(extraPayload.remaining_seconds);
    if (!Number.isFinite(rs)) return { ok: false, message: 'remaining_seconds required.' };
    if (t.status !== 'running') return { ok: true, message: 'Timer not running — tick ignored.' };
    // Also reset started_at to now so elapsed-time arithmetic stays consistent with the ticked value.
    update = { remaining_seconds: Math.max(0, rs), started_at: new Date().toISOString() };
  }

  const { error: updErr } = await supabase.from('event_timers').update({ ...update, updated_at: new Date().toISOString() }).eq('event_key', eventKey);
  if (updErr) return { ok: false, message: updErr.message };

  return { ok: true, status: update.status || t.status, remaining_seconds: update.remaining_seconds };
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

    // Fetch current fizzbuzz_score and imposter_bonus to recompute total_individual_score atomically
    const { data: current, error: fetchErr } = await supabase
      .from('main_event_assignments')
      .select('fizzbuzz_score, imposter_bonus')
      .eq('participant_id', participant_id)
      .maybeSingle();
    if (fetchErr) return res.status(500).json({ success: false, message: fetchErr.message });

    const fizzbuzz_score = Number(current?.fizzbuzz_score || 0);
    const imposter_bonus = Number(current?.imposter_bonus || 0);
    const total_individual_score = main_event_score + fizzbuzz_score + imposter_bonus;

    const { error } = await supabase.from('main_event_assignments').update({
      main_event_score,
      total_individual_score
    }).eq('participant_id', participant_id);
    if (error) return res.status(500).json({ success: false, message: error.message });
    auditLog('update_main_score', participant_id, { score: main_event_score });
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
      }).catch(err => console.error('[recover-eval]', row.participant_id, err.message));
    }

    auditLog('recover_evaluations', 'system', { count: candidates.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── Catch-all for unknown routes ──────────────────────────────────────────────

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
