'use strict';

const assert = require('assert');
const {
  DEFAULT_MAIN_EVENT_CRITERIA,
  maxTotal,
  validateCriteriaScores,
} = require('./lib/evaluation/criteria');
const {
  build12AuthoritativePairs,
  computePairStatus,
  validatePairwiseScores,
  evaluatePairById,
} = require('./lib/evaluation/pairwiseEvaluator');

console.log('===============================================================');
console.log('ASTHRA IMPOSTER — PAIRWISE COMPETITIVE AI SCORING TEST SUITE');
console.log('Section 31: 10 Authoritative Test Cases');
console.log('===============================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}:`, err.message);
    throw err;
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}:`, err.message);
    throw err;
  }
}

(async () => {
  // ── TEST CASE 1: Two equally good implementations (equal / near-equal scores) ──
  console.log('Test Case 1: Two Equally Good Implementations');
  runTest('Case 1: Equal or near-equal scores (within ±3 points) for balanced implementations', () => {
    const rawJudgement = {
      participant_a: {
        task_completion_score: 38,
        ui_score: 19,
        responsiveness_score: 18,
        creativity_score: 18,
        total_score: 93,
        feedback: 'Candidate A completed all core tasks with high quality.',
        passed_tests: ['all tests passed'],
      },
      participant_b: {
        task_completion_score: 37,
        ui_score: 18,
        responsiveness_score: 19,
        creativity_score: 17,
        total_score: 91,
        feedback: 'Candidate B also completed all core tasks with high quality.',
        passed_tests: ['all tests passed'],
      },
      comparison: {
        overall_comparison: 'Both candidates implemented outstanding solutions with virtually equal effectiveness.',
        meaningful_differences: ['Minor styling differences in color palette.'],
        similarities_that_should_not_affect_score: ['Both used standard Flexbox containers.'],
      },
    };

    const result = validatePairwiseScores(rawJudgement, DEFAULT_MAIN_EVENT_CRITERIA);
    assert.strictEqual(result.participant_a.total, 93);
    assert.strictEqual(result.participant_b.total, 91);
    const scoreDiff = Math.abs(result.participant_a.total - result.participant_b.total);
    assert.ok(scoreDiff <= 3, `Score difference should be <= 3, got ${scoreDiff}`);
  });

  // ── TEST CASE 2: Better UI (A UI > B UI) ──────────────────────────────────────
  console.log('\nTest Case 2: Better UI Separation');
  runTest('Case 2: Advanced UI scores higher than unstyled HTML without affecting Task Completion', () => {
    const rawJudgement = {
      participant_a: {
        task_completion_score: 36,
        ui_score: 19, // Polished, animations, glassmorphic UI
        responsiveness_score: 18,
        creativity_score: 17,
        feedback: 'Superb polished interface.',
      },
      participant_b: {
        task_completion_score: 36, // Same functional completion
        ui_score: 6,  // Plain unstyled default browser HTML
        responsiveness_score: 10,
        creativity_score: 7,
        feedback: 'Functional but lacks any modern styling.',
      },
      comparison: {
        overall_comparison: 'Candidate A exhibits significantly superior UI/UX craftsmanship.',
        meaningful_differences: ['Candidate A implemented custom CSS theme, B used browser default.'],
      },
    };

    const result = validatePairwiseScores(rawJudgement, DEFAULT_MAIN_EVENT_CRITERIA);
    assert.ok(result.participant_a.scores.ui > result.participant_b.scores.ui, 'A UI must be > B UI');
    assert.strictEqual(result.participant_a.scores.task_completion, result.participant_b.scores.task_completion);
    assert.ok(result.participant_a.total > result.participant_b.total);
  });

  // ── TEST CASE 3: Better Code Quality / Logic ─────────────────────────────────
  console.log('\nTest Case 3: Better Code Quality & Logic');
  runTest('Case 3: Robust logic and error handling score higher than buggy/fragile code', () => {
    const rawJudgement = {
      participant_a: {
        task_completion_score: 38,
        ui_score: 16,
        responsiveness_score: 18,
        creativity_score: 16,
        passed_tests: ['Gracefully handles null/undefined inputs', 'Async retry logic works'],
        failed_tests: [],
      },
      participant_b: {
        task_completion_score: 22,
        ui_score: 14,
        responsiveness_score: 12,
        creativity_score: 10,
        passed_tests: [],
        failed_tests: ['Uncaught TypeError on empty array', 'Unhandled Promise rejection'],
      },
    };

    const result = validatePairwiseScores(rawJudgement, DEFAULT_MAIN_EVENT_CRITERIA);
    assert.ok(result.participant_a.scores.task_completion > result.participant_b.scores.task_completion);
    assert.strictEqual(result.participant_a.failed_tests.length, 0);
    assert.strictEqual(result.participant_b.failed_tests.length, 2);
  });

  // ── TEST CASE 4: AI-Generated Code (No Penalty) ──────────────────────────────
  console.log('\nTest Case 4: AI-Generated Code is Not Penalized');
  runTest('Case 4: AI boilerplate, standard utility usage, and prompt comments receive full credit', () => {
    // Both implement the requirements; Candidate A used an AI assistant resulting in standard patterns
    const rawJudgement = {
      participant_a: {
        task_completion_score: 40,
        ui_score: 18,
        responsiveness_score: 18,
        creativity_score: 16,
        feedback: 'Used AI assistant for boilerplate; correctly integrated and solves all requirements.',
      },
      participant_b: {
        task_completion_score: 35,
        ui_score: 17,
        responsiveness_score: 15,
        creativity_score: 15,
        feedback: 'Hand-written code with minor bugs in state update.',
      },
      comparison: {
        similarities_that_should_not_affect_score: [
          'AI-generated utility boilerplate in Candidate A is not penalized per competition rules.',
        ],
      },
    };

    const result = validatePairwiseScores(rawJudgement, DEFAULT_MAIN_EVENT_CRITERIA);
    assert.strictEqual(result.participant_a.scores.task_completion, 40, 'AI code gets full task completion if requirements are met');
    assert.strictEqual(result.participant_a.total, 92);
  });

  // ── TEST CASE 5: Similar Code (No Penalty) ───────────────────────────────────
  console.log('\nTest Case 5: Similar Code Across Cohort is Not Penalized');
  runTest('Case 5: High syntactic similarity between candidates does NOT reduce either score', () => {
    const rawJudgement = {
      participant_a: {
        task_completion_score: 39,
        ui_score: 18,
        responsiveness_score: 19,
        creativity_score: 18,
      },
      participant_b: {
        task_completion_score: 39,
        ui_score: 18,
        responsiveness_score: 19,
        creativity_score: 18,
      },
      comparison: {
        similarities_that_should_not_affect_score: [
          'Both candidates used standard Array.filter() and CSS flex layouts for identical requirements.',
        ],
      },
    };

    const result = validatePairwiseScores(rawJudgement, DEFAULT_MAIN_EVENT_CRITERIA);
    assert.strictEqual(result.participant_a.total, 94);
    assert.strictEqual(result.participant_b.total, 94);
    assert.ok(result.comparison.similarities_that_should_not_affect_score.length > 0);
  });

  // ── TEST CASE 6: Runtime Failure Reflected in Score ──────────────────────────
  console.log('\nTest Case 6: Runtime Failure Trumps Static Claims');
  runTest('Case 6: Runtime FAIL evidence must lower task completion even if code claims completion', () => {
    const rawJudgement = {
      participant_a: {
        task_completion_score: 18, // Severely penalized for runtime crash
        ui_score: 12,
        responsiveness_score: 8,
        creativity_score: 10,
        failed_tests: ['Runtime crash: ReferenceError: renderList is not defined at app.js:42'],
        feedback: 'Runtime execution confirmed critical uncaught error preventing core user journey.',
      },
      participant_b: {
        task_completion_score: 36,
        ui_score: 16,
        responsiveness_score: 16,
        creativity_score: 15,
        passed_tests: ['Runtime execution passed all smoke tests.'],
        failed_tests: [],
      },
    };

    const result = validatePairwiseScores(rawJudgement, DEFAULT_MAIN_EVENT_CRITERIA);
    assert.ok(result.participant_a.scores.task_completion < 20);
    assert.strictEqual(result.participant_a.failed_tests.length, 1);
    assert.ok(result.participant_b.total > result.participant_a.total);
  });

  // ── TEST CASE 7: Runtime Unavailable Marked UNVERIFIED ───────────────────────
  console.log('\nTest Case 7: Runtime Unavailable Marked UNVERIFIED');
  runTest('Case 7: UNVERIFIED is never treated as PASS and does not grant false runtime bonus', () => {
    const rawJudgement = {
      participant_a: {
        task_completion_score: 30,
        ui_score: 15,
        responsiveness_score: 14,
        creativity_score: 12,
        passed_tests: ['Static syntax check OK'],
        unverified_tests: ['Backend API endpoint execution', 'Database query latency'],
      },
      participant_b: {
        task_completion_score: 30,
        ui_score: 15,
        responsiveness_score: 14,
        creativity_score: 12,
        passed_tests: ['Static syntax check OK'],
        unverified_tests: ['Backend API endpoint execution'],
      },
    };

    const result = validatePairwiseScores(rawJudgement, DEFAULT_MAIN_EVENT_CRITERIA);
    assert.strictEqual(result.participant_a.unverified_tests.length, 2);
    // Unverified tests must remain distinct from passed tests
    assert.strictEqual(result.participant_a.passed_tests.length, 1);
  });

  // ── TEST CASE 8: Missing Submission Marked WAITING_FOR_BOTH ──────────────────
  console.log('\nTest Case 8: Missing Submission State Management');
  runTest('Case 8: One missing GitHub submission results in WAITING_FOR_BOTH status', () => {
    const candA = { participant_id: 'p1', github_repo: 'https://github.com/org/repo1' };
    const candB = { participant_id: 'p2', github_repo: null }; // Has not submitted yet

    const status1 = computePairStatus(candA, candB, null);
    assert.strictEqual(status1, 'WAITING_FOR_BOTH', 'Should be WAITING_FOR_BOTH when Candidate B is missing');

    const status2 = computePairStatus(null, candA, null);
    assert.strictEqual(status2, 'WAITING_FOR_BOTH', 'Should be WAITING_FOR_BOTH when Candidate A is missing');

    const status3 = computePairStatus(candA, candA, null);
    assert.strictEqual(status3, 'READY', 'Should be READY when both have submitted');
  });

  // ── TEST CASE 9: Groq Error Marked NEEDS_RECOVERY ────────────────────────────
  console.log('\nTest Case 9: Groq Provider Error Recovery');
  await runAsyncTest('Case 9: Simulated Groq API failure marks pair as NEEDS_RECOVERY without crashing', async () => {
    // Mock Supabase client
    let updatedStatus = null;
    let savedError = null;

    const mockSupabase = {
      from: (tableName) => ({
        select: () => ({
          eq: (col, val) => ({
            maybeSingle: async () => {
              if (tableName === 'competitive_evaluation_pairs') {
                return {
                  data: {
                    id: 'pair-uuid-123',
                    task_number: 1,
                    person_slot: 2,
                    role_name: 'Specialist 2',
                    is_imposter: false,
                    status: 'READY',
                    participant_a_id: 'pa',
                    participant_b_id: 'pb',
                  },
                  error: null,
                };
              }
              if (tableName === 'main_event_assignments') {
                return {
                  data: {
                    participant_id: val,
                    participant_name: val === 'pa' ? 'Candidate A' : 'Candidate B',
                    shuffled_group: val === 'pa' ? 'Group 1' : 'Group 4',
                    original_team: val === 'pa' ? 'Team 1' : 'Team 2',
                    task_title: 'Task 1',
                    task_description: 'Test task',
                    role_name: 'Specialist 2',
                    work_description: 'Do Specialist 2 work',
                    github_repo: 'https://github.com/invalid-repo-test-pairwise-failure/fail',
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            },
          }),
        }),
        update: (updatePayload) => ({
          eq: (col, val) => {
            if (updatePayload.status) updatedStatus = updatePayload.status;
            if (updatePayload.error_message) savedError = updatePayload.error_message;
            return {
              select: () => ({
                maybeSingle: async () => ({ data: { id: val, ...updatePayload }, error: null }),
              }),
            };
          },
        }),
      }),
    };

    // Trigger evaluation where GitHub repo download fails inside the try block
    const result = await evaluatePairById(mockSupabase, 'pair-uuid-123');
    assert.strictEqual(result.success, false);
    assert.strictEqual(updatedStatus, 'NEEDS_RECOVERY');
    assert.strictEqual(result.status, 'NEEDS_RECOVERY');
    assert.ok(savedError, 'Must save error message');
  });

  // ── TEST CASE 10: Atomic Concurrency Lock Prevents Duplicate Evaluations ────
  console.log('\nTest Case 10: Atomic Concurrency Lock');
  await runAsyncTest('Case 10: Active EVALUATING lock within stale window rejects concurrent evaluation', async () => {
    const mockSupabaseWithActiveLock = {
      from: (tableName) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: 'pair-uuid-456',
                task_number: 2,
                person_slot: 1,
                role_name: 'Specialist 1',
                status: 'EVALUATING',
                started_at: new Date().toISOString(),
                updated_at: new Date().toISOString(), // Fresh active lock (< 3 mins)
              },
              error: null,
            }),
          }),
        }),
        update: () => ({
          eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: {}, error: null }) }) }),
        }),
      }),
    };

    const res = await evaluatePairById(mockSupabaseWithActiveLock, 'pair-uuid-456', { retry: false, force: false });
    assert.strictEqual(res.success, false);
    assert.ok(res.message.includes('currently being evaluated'));
  });

  // ── 12 Canonical Pairs Structure Check ───────────────────────────────────────
  console.log('\nCanonical Pairs Structure Verification');
  runTest('12 Canonical pairs correctly generated across 3 tasks x 4 roles', () => {
    const syntheticAssignments = [];
    const groups = ['Group 1', 'Group 2', 'Group 3', 'Group 4', 'Group 5', 'Group 6'];
    const taskForGroup = {
      'Group 1': 1, 'Group 4': 1,
      'Group 2': 2, 'Group 5': 2,
      'Group 3': 3, 'Group 6': 3,
    };

    groups.forEach(grp => {
      for (let slot = 1; slot <= 4; slot++) {
        syntheticAssignments.push({
          participant_id: `part-${grp}-${slot}`,
          participant_name: `User ${grp} Slot ${slot}`,
          shuffled_group: grp,
          task_number: taskForGroup[grp],
          person_slot: slot,
          role_name: slot === 4 ? 'Imposter' : `Specialist ${slot}`,
          is_imposter: slot === 4,
          github_repo: 'https://github.com/test/repo',
        });
      }
    });

    const pairs = build12AuthoritativePairs(syntheticAssignments);
    assert.strictEqual(pairs.length, 12, 'Must generate exactly 12 pairs');

    // 4 pairs per task
    for (let t = 1; t <= 3; t++) {
      const taskPairs = pairs.filter(p => p.task_number === t);
      assert.strictEqual(taskPairs.length, 4, `Task ${t} must have 4 role pairs`);
    }

    // Exactly 3 imposter pairs (slot 4)
    const imposterPairs = pairs.filter(p => p.is_imposter === true);
    assert.strictEqual(imposterPairs.length, 3, 'Must have exactly 3 imposter pairs (one per task)');
  });

  console.log('\n===============================================================');
  console.log(`ALL TESTS PASSED: ${passedTests}/${totalTests}`);
  console.log('ASTHRA Imposter Pairwise Competitive Evaluation Verified!');
  console.log('===============================================================');
})().catch(err => {
  console.error('\n❌ Test suite failure:', err);
  process.exit(1);
});
