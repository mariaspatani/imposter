'use strict';

/**
 * Server-authoritative game timer.
 * Remaining time is derived from ends_at (or a paused remaining_seconds snapshot).
 * Clients must never treat a local setInterval decrement as source of truth.
 */

const UI_STATUS = {
  idle:     'NOT_STARTED',
  running:  'ACTIVE',
  paused:   'PAUSED',
  finished: 'COMPLETED',
};

function durationSeconds(t) {
  if (t && Number.isFinite(Number(t.duration_seconds)) && t.duration_seconds > 0) {
    return Number(t.duration_seconds);
  }
  return (t && t.duration_minutes ? t.duration_minutes : 15) * 60;
}

function computeRemaining(t, nowMs = Date.now()) {
  if (!t) return 0;
  if (t.status === 'finished') return 0;

  if (t.status === 'running') {
    if (t.ends_at) {
      return Math.max(0, Math.floor((new Date(t.ends_at).getTime() - nowMs) / 1000));
    }
    if (t.started_at) {
      const full = durationSeconds(t);
      const stored = (t.remaining_seconds != null && t.remaining_seconds > 0)
        ? Number(t.remaining_seconds)
        : full;
      const runningFor = Math.floor((nowMs - new Date(t.started_at).getTime()) / 1000);
      return Math.max(0, stored - runningFor);
    }
    return durationSeconds(t);
  }

  if (t.remaining_seconds != null && t.remaining_seconds > 0) {
    return Number(t.remaining_seconds);
  }
  return durationSeconds(t);
}

function isExpired(t, nowMs = Date.now()) {
  if (!t) return true;
  if (t.status === 'finished') return true;
  if (t.status === 'running' && computeRemaining(t, nowMs) <= 0) return true;
  return false;
}

function submissionsOpen(t, nowMs = Date.now()) {
  return !!(t && t.status === 'running' && !isExpired(t, nowMs));
}

function applyTimerAction(t, action, extraPayload = {}, nowMs = Date.now()) {
  if (!t) return { ok: false, message: 'Timer not found.' };

  const fullSecs = durationSeconds(t);
  const nowIso = new Date(nowMs).toISOString();

  if (action === 'start') {
    if (t.status === 'running' && !isExpired(t, nowMs)) {
      return { ok: false, message: 'Timer is already running.' };
    }
    if (t.status === 'finished') {
      return { ok: false, message: 'This game session has already ended. Reset the timer before starting again.' };
    }
    return {
      ok: true,
      update: {
        status: 'running',
        started_at: nowIso,
        paused_at: null,
        ends_at: new Date(nowMs + fullSecs * 1000).toISOString(),
        remaining_seconds: fullSecs,
      },
    };
  }

  if (action === 'pause') {
    if (t.status !== 'running') {
      return { ok: false, message: 'Timer is not running.' };
    }
    const remaining = computeRemaining(t, nowMs);
    return {
      ok: true,
      update: {
        status: 'paused',
        paused_at: nowIso,
        started_at: t.started_at,
        ends_at: null,
        remaining_seconds: remaining,
      },
    };
  }

  if (action === 'resume') {
    if (t.status !== 'paused') {
      return { ok: false, message: 'Timer is not paused.' };
    }
    const remaining = (t.remaining_seconds != null && t.remaining_seconds > 0)
      ? Number(t.remaining_seconds)
      : computeRemaining(t, nowMs);
    return {
      ok: true,
      update: {
        status: 'running',
        started_at: nowIso,
        paused_at: null,
        ends_at: new Date(nowMs + remaining * 1000).toISOString(),
        remaining_seconds: remaining,
      },
    };
  }

  if (action === 'reset') {
    return {
      ok: true,
      update: {
        status: 'idle',
        started_at: null,
        paused_at: null,
        ends_at: null,
        remaining_seconds: fullSecs,
      },
    };
  }

  if (action === 'finish') {
    return {
      ok: true,
      update: {
        status: 'finished',
        remaining_seconds: 0,
        ends_at: nowIso,
        started_at: t.started_at,
      },
    };
  }

  if (action === 'tick') {
    // Legacy no-op for remaining_seconds writes. Server clock is authoritative.
    return { ok: true, update: {}, ignore: true };
  }

  return { ok: false, message: 'Unknown timer action.' };
}

function normaliseTimer(t, nowMs = Date.now()) {
  const remaining = computeRemaining(t, nowMs);
  const expired = t.status === 'running' && remaining <= 0;
  const status = expired ? 'finished' : (t.status || 'idle');
  return {
    event_key:         t.event_key,
    event_name:        t.event_name || t.event_key,
    duration_minutes:  t.duration_minutes,
    duration_seconds:  durationSeconds(t),
    remaining_seconds: remaining,
    status,
    ui_status:         UI_STATUS[status] || 'NOT_STARTED',
    started_at:        t.started_at,
    paused_at:         t.paused_at,
    ends_at:           t.ends_at || null,
    server_time:       new Date(nowMs).toISOString(),
  };
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

module.exports = {
  computeRemaining,
  isExpired,
  submissionsOpen,
  applyTimerAction,
  normaliseTimer,
  durationSeconds,
  formatClock,
  UI_STATUS,
};
