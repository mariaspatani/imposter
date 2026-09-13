'use strict';

const DEFAULT_CONFIG = {
  fizzDivisor: 3,
  buzzDivisor: 5,
  rangeStart: 1,
  rangeEnd: 100,
  imposterEnabled: true,
  imposterCount: 1,
  imposterBonus: 10,
  imposterSuccessCondition: 'FIZZBUZZ_PRINTED_AS_NUMBER',
  correctTeamScore: 20,
  incorrectTeamScore: 0,
  speedBonusFirst: 5,
  speedBonusRest: 2,
  speedBonusCutoff: 2,
};

function evaluateFizzBuzz(number, config = {}) {
  const fizz = Number(config.fizzDivisor || DEFAULT_CONFIG.fizzDivisor);
  const buzz = Number(config.buzzDivisor || DEFAULT_CONFIG.buzzDivisor);
  const n = Number(number);
  if (!Number.isFinite(n)) return 'NONE';
  const isFizz = n % fizz === 0;
  const isBuzz = n % buzz === 0;
  if (isFizz && isBuzz) return 'FIZZBUZZ';
  if (isFizz) return 'FIZZ';
  if (isBuzz) return 'BUZZ';
  return 'NONE';
}

function expectedToken(number, config) {
  const kind = evaluateFizzBuzz(number, config);
  if (kind === 'FIZZBUZZ') return 'FizzBuzz';
  if (kind === 'FIZZ') return 'Fizz';
  if (kind === 'BUZZ') return 'Buzz';
  return String(number);
}

function expectedSequence(config = {}) {
  const start = Number(config.rangeStart || DEFAULT_CONFIG.rangeStart);
  const end = Number(config.rangeEnd || DEFAULT_CONFIG.rangeEnd);
  const out = [];
  for (let n = start; n <= end; n++) {
    out.push({ number: n, kind: evaluateFizzBuzz(n, config), expected: expectedToken(n, config) });
  }
  return out;
}

function classifyToken(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  if (/^fizzbuzz$/i.test(t)) return { kind: 'FIZZBUZZ', value: t };
  if (/^fizz$/i.test(t)) return { kind: 'FIZZ', value: t };
  if (/^buzz$/i.test(t)) return { kind: 'BUZZ', value: t };
  if (/^\d+$/.test(t)) return { kind: 'NONE', value: t };
  return null;
}

/**
 * Pull Fizz/Buzz/number tokens out of pasted output OR source-with-comments.
 * Ignores typical code syntax so a Python/JS program can still be scored if
 * it includes a printed sequence, or if the participant pasted console output.
 */
function parseFizzBuzzTokens(text) {
  const lines = String(text || '').split(/\r?\n/);
  const tokens = [];
  for (const line of lines) {
    const stripped = line
      .replace(/^\s*\/\/.*$/, '')
      .replace(/^\s*#.*$/, '')
      .replace(/^\s*\*.*$/, '')
      .trim();
    if (!stripped) continue;
    // Whole-line token
    const whole = classifyToken(stripped.replace(/[,;]+$/, ''));
    if (whole) {
      tokens.push(whole);
      continue;
    }
    // print("Fizz") / console.log('15')
    const quoted = stripped.match(/(['"`])(FizzBuzz|Fizz|Buzz|\d+)\1/i);
    if (quoted) {
      const tok = classifyToken(quoted[2]);
      if (tok) tokens.push(tok);
    }
  }
  return tokens;
}

function compareSequence(tokens, config = {}) {
  const expected = expectedSequence(config);
  const compared = Math.min(tokens.length, expected.length);
  let matches = 0;
  let fizzbuzzCases = 0;
  let fizzbuzzPrintedAsNumber = 0;
  let fizzbuzzCorrect = 0;
  const mismatches = [];

  for (let i = 0; i < compared; i++) {
    const exp = expected[i];
    const got = tokens[i];
    const ok = got.kind === exp.kind && (
      exp.kind !== 'NONE' || String(got.value) === String(exp.number)
    );
    if (ok) matches += 1;
    else if (mismatches.length < 12) {
      mismatches.push({ number: exp.number, expected: exp.kind, actual: got.kind, actualValue: got.value });
    }
    if (exp.kind === 'FIZZBUZZ') {
      fizzbuzzCases += 1;
      if (got.kind === 'FIZZBUZZ') fizzbuzzCorrect += 1;
      if (got.kind === 'NONE' && String(got.value) === String(exp.number)) {
        fizzbuzzPrintedAsNumber += 1;
      }
    }
  }

  const coverage = expected.length === 0 ? 0 : compared / expected.length;
  const accuracy = compared === 0 ? 0 : matches / compared;
  const isCorrect = coverage >= 0.9 && accuracy >= 0.95;

  return {
    expectedCount: expected.length,
    parsedCount: tokens.length,
    compared,
    matches,
    coverage,
    accuracy,
    isCorrect,
    fizzbuzzCases,
    fizzbuzzCorrect,
    fizzbuzzPrintedAsNumber,
    mismatches,
    autoEvaluated: compared >= Math.min(50, expected.length * 0.5),
  };
}

function evaluateImposterSuccess(comparison, config = {}) {
  const condition = config.imposterSuccessCondition || DEFAULT_CONFIG.imposterSuccessCondition;
  const enabled = config.imposterEnabled !== false;

  if (!enabled || !comparison || !comparison.autoEvaluated) {
    return {
      success: false,
      applied: false,
      condition,
      reason: 'Imposter evaluation skipped — sequence could not be auto-evaluated.',
      bonus: 0,
    };
  }

  let success = false;
  let reason = '';

  if (condition === 'FIZZBUZZ_PRINTED_AS_NUMBER') {
    success = comparison.fizzbuzzCases > 0
      && comparison.fizzbuzzPrintedAsNumber >= Math.ceil(comparison.fizzbuzzCases * 0.5);
    reason = success
      ? 'The team failed to correctly identify FizzBuzz (divisible by both configured multiples) for the required number of rounds. Numbers were printed instead of FizzBuzz.'
      : 'The team correctly identified FizzBuzz for most dual-multiple rounds. Imposter objective was not met.';
  } else if (condition === 'TEAM_INCORRECT') {
    success = !comparison.isCorrect;
    reason = success
      ? 'The team failed to correctly produce the configured FizzBuzz sequence.'
      : 'The team produced a correct FizzBuzz sequence. Imposter objective was not met.';
  } else {
    success = false;
    reason = 'Unknown imposter success condition: ' + condition;
  }

  const bonus = success ? Number(config.imposterBonus || DEFAULT_CONFIG.imposterBonus) : 0;
  return { success, applied: true, condition, reason, bonus };
}

function speedBonusForIndex(index, config = {}) {
  const cutoff = Number(config.speedBonusCutoff || DEFAULT_CONFIG.speedBonusCutoff);
  const first = Number(config.speedBonusFirst != null ? config.speedBonusFirst : DEFAULT_CONFIG.speedBonusFirst);
  const rest = Number(config.speedBonusRest != null ? config.speedBonusRest : DEFAULT_CONFIG.speedBonusRest);
  return index < cutoff ? first : rest;
}

function individualFizzBuzzScores(members, { isCorrect, speedBonus, imposter }) {
  const teamBase = isCorrect
    ? Number(imposter.config.correctTeamScore != null ? imposter.config.correctTeamScore : DEFAULT_CONFIG.correctTeamScore)
    : Number(imposter.config.incorrectTeamScore != null ? imposter.config.incorrectTeamScore : DEFAULT_CONFIG.incorrectTeamScore);

  return (members || []).map((m) => {
    const isImp = !!m.is_imposter;
    const bonus = (isImp && imposter.success) ? imposter.bonus : 0;
    const base = teamBase + (isCorrect ? speedBonus : 0);
    return {
      participantId: m.participant_id,
      originalTeam: m.original_team,
      originalTeamId: m.original_team_id || null,
      sessionTeamId: m.shuffled_group,
      isImposter: isImp,
      baseScore: base,
      imposterBonus: bonus,
      finalScore: base + bonus,
    };
  });
}

function mergeGameConfig(row) {
  const extra = row && row.config_json && typeof row.config_json === 'object' ? row.config_json : {};
  return {
    ...DEFAULT_CONFIG,
    ...extra,
    fizzDivisor: Number(row?.fizz_divisor || extra.fizzDivisor || DEFAULT_CONFIG.fizzDivisor),
    buzzDivisor: Number(row?.buzz_divisor || extra.buzzDivisor || DEFAULT_CONFIG.buzzDivisor),
    imposterEnabled: row?.imposter_enabled !== false,
    imposterCount: Number(row?.imposter_count || extra.imposterCount || DEFAULT_CONFIG.imposterCount),
    imposterBonus: Number(row?.imposter_bonus != null ? row.imposter_bonus : DEFAULT_CONFIG.imposterBonus),
    imposterSuccessCondition: row?.imposter_success_condition || DEFAULT_CONFIG.imposterSuccessCondition,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  evaluateFizzBuzz,
  expectedToken,
  expectedSequence,
  parseFizzBuzzTokens,
  compareSequence,
  evaluateImposterSuccess,
  speedBonusForIndex,
  individualFizzBuzzScores,
  mergeGameConfig,
};
