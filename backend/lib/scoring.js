'use strict';

const TYPES = {
  INDIVIDUAL_SCORE: 'INDIVIDUAL_SCORE',
  TEAM_SCORE: 'TEAM_SCORE',
  IMPOSTER_BONUS: 'IMPOSTER_BONUS',
  PENALTY: 'PENALTY',
  MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT',
};

/**
 * Map a participant identity to original-team scoring ownership.
 * Session/shuffled group is recorded for audit only — never used as the team key.
 */
function scoringIdentity(participant) {
  return {
    participantId: participant.participant_id || participant.participantId,
    originalTeamId: participant.original_team_id || participant.originalTeamId || participant.team_id || null,
    originalTeamName: participant.original_team || participant.originalTeamName || participant.original_team_name,
    sessionTeamId: participant.shuffled_group || participant.sessionTeamId || participant.session_team_id || null,
  };
}

function aggregateOriginalTeams(scoreEvents) {
  const teams = {};
  for (const ev of scoreEvents || []) {
    const key = ev.originalTeamName || ev.original_team || 'Unknown';
    if (!teams[key]) {
      teams[key] = {
        team: key,
        originalTeamId: ev.originalTeamId || ev.original_team_id || null,
        total: 0,
        byGame: {},
        byType: {},
      };
    }
    const pts = Number(ev.points || 0);
    teams[key].total += pts;
    const game = ev.gameId || ev.game_id || 'unknown';
    teams[key].byGame[game] = (teams[key].byGame[game] || 0) + pts;
    const type = ev.type || 'INDIVIDUAL_SCORE';
    teams[key].byType[type] = (teams[key].byType[type] || 0) + pts;
  }
  return Object.values(teams).sort((a, b) => b.total - a.total);
}

function rankIndividuals(rows) {
  const sorted = [...(rows || [])].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
}

function buildScoreEvent({
  eventId = 'asthra',
  gameId,
  participantId,
  originalTeamId,
  originalTeamName,
  sessionTeamId,
  points,
  reason,
  type = TYPES.INDIVIDUAL_SCORE,
  idempotencyKey,
}) {
  if (!gameId) throw new Error('gameId is required for a score event.');
  if (!Number.isFinite(Number(points))) throw new Error('points must be a number.');
  return {
    event_id: eventId,
    game_id: gameId,
    participant_id: participantId || null,
    original_team_id: originalTeamId || null,
    original_team: originalTeamName || null,
    session_team_id: sessionTeamId || null,
    points: Number(points),
    reason: reason || '',
    type,
    idempotency_key: idempotencyKey || `${gameId}:${participantId || originalTeamName}:${type}:${reason || 'score'}`,
  };
}

async function recordScoreEvent(supabase, event) {
  const row = buildScoreEvent(event);
  const { data, error } = await supabase
    .from('score_events')
    .upsert(row, { onConflict: 'idempotency_key' })
    .select()
    .maybeSingle();

  if (error) {
    const dupe = error.code === '23505' || String(error.message || '').includes('duplicate');
    if (dupe) return { duplicate: true, row };
    throw error;
  }
  return { duplicate: false, row: data || row };
}

function totalsFromAssignments(assignments, manuals = []) {
  const teamMap = {};
  for (const r of assignments || []) {
    const t = r.original_team || 'Unknown';
    if (!teamMap[t]) {
      teamMap[t] = {
        team: t,
        originalTeamId: r.original_team_id || null,
        main_event_total: 0,
        fizzbuzz_total: 0,
        manual_total: 0,
        grand_total: 0,
        members_scored: 0,
        contributions: { main_event: 0, fizzbuzz: 0, code_imposter: 0, sherlock: 0, drawing: 0 },
      };
    }
    const main = Number(r.main_event_score || 0);
    const fizz = Number(r.fizzbuzz_score || 0);
    teamMap[t].main_event_total += main;
    teamMap[t].fizzbuzz_total += fizz;
    teamMap[t].contributions.main_event += main;
    teamMap[t].contributions.fizzbuzz += fizz;
    if (r.ai_score != null) teamMap[t].members_scored += 1;
  }
  for (const r of manuals || []) {
    const t = r.original_team;
    if (!t) continue;
    if (!teamMap[t]) {
      teamMap[t] = {
        team: t, originalTeamId: null, main_event_total: 0, fizzbuzz_total: 0,
        manual_total: 0, grand_total: 0, members_scored: 0,
        contributions: { main_event: 0, fizzbuzz: 0, code_imposter: 0, sherlock: 0, drawing: 0 },
      };
    }
    const ci = Number(r.code_imposter || 0);
    const sh = Number(r.sherlock || 0);
    const dr = Number(r.drawing || 0);
    teamMap[t].manual_total += ci + sh + dr;
    teamMap[t].contributions.code_imposter += ci;
    teamMap[t].contributions.sherlock += sh;
    teamMap[t].contributions.drawing += dr;
  }
  return Object.values(teamMap).map((t) => {
    t.grand_total = t.main_event_total + t.fizzbuzz_total + t.manual_total;
    return t;
  }).sort((a, b) => b.grand_total - a.grand_total);
}

module.exports = {
  TYPES,
  scoringIdentity,
  aggregateOriginalTeams,
  rankIndividuals,
  buildScoreEvent,
  recordScoreEvent,
  totalsFromAssignments,
};
