'use strict';

const assert = require('assert');
const {
  DEFAULT_MAIN_EVENT_CRITERIA,
  maxTotal,
  validateCriteriaScores,
  toAssignmentColumns,
} = require('./lib/evaluation/criteria');
const {
  computeCodeSimilarity,
  compareSameRolePair,
  buildTaskCohortReport,
  buildFullEventCohortReport,
} = require('./lib/evaluation/cohortComparator');
const { publicEvaluationView } = require('./lib/evaluation/pipeline');

console.log('===============================================================');
console.log('ASTHRA IMPOSTER — COMPETITIVE AI SCORING SYSTEM TEST SUITE');
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

// ── TEST CATEGORY 1: Rubric & Sum of Components ──────────────────────────────
console.log('Test Category 1: Rubric Structure & Component Summation');

runTest('Official Rubric is 40 / 20 / 20 / 20 = 100', () => {
  assert.strictEqual(maxTotal(DEFAULT_MAIN_EVENT_CRITERIA), 100);
  const map = {};
  DEFAULT_MAIN_EVENT_CRITERIA.forEach(c => { map[c.criterion_key] = c.max_score; });
  assert.strictEqual(map.task_completion, 40);
  assert.strictEqual(map.ui, 20);
  assert.strictEqual(map.responsiveness, 20);
  assert.strictEqual(map.creativity, 20);
});

runTest('validateCriteriaScores sums components & never trusts AI total', () => {
  const aiPayload = {
    task_completion_score: 35,
    ui_score: 18,
    responsiveness_score: 16,
    creativity_score: 15,
    total_score: 999, // Intentional hallucination / tampered total
    feedback: 'Excellent work.',
    strengths: ['Clean layout', 'Responsive design'],
    weaknesses: ['Missing minor edge-case'],
    passed_tests: ['Navbar renders', 'Items filter'],
    failed_tests: [],
    unverified_tests: ['Export to CSV']
  };

  const validated = validateCriteriaScores(aiPayload, DEFAULT_MAIN_EVENT_CRITERIA);
  // Expected sum = 35 + 18 + 16 + 15 = 84 (NOT 999)
  assert.strictEqual(validated.total, 84);
  assert.strictEqual(validated.scores.task_completion, 35);
  assert.strictEqual(validated.scores.ui, 18);
  assert.strictEqual(validated.scores.responsiveness, 16);
  assert.strictEqual(validated.scores.creativity, 15);
  assert.strictEqual(validated.strengths.length, 2);
  assert.strictEqual(validated.passed_tests.length, 2);
});

runTest('Scores are strictly clamped within rubric bounds', () => {
  const overclamped = {
    task_completion_score: 100, // max 40
    ui_score: 50,              // max 20
    responsiveness_score: 99,  // max 20
    creativity_score: -5,      // min 0
  };
  const validated = validateCriteriaScores(overclamped, DEFAULT_MAIN_EVENT_CRITERIA);
  assert.strictEqual(validated.scores.task_completion, 40);
  assert.strictEqual(validated.scores.ui, 20);
  assert.strictEqual(validated.scores.responsiveness, 20);
  assert.strictEqual(validated.scores.creativity, 0);
  assert.strictEqual(validated.total, 80);
});

// ── TEST CATEGORY 2: 8 Same-Task Synthetic Participants ──────────────────────
console.log('\nTest Category 2: 8 Same-Task Synthetic Participants (Req #39)');

runTest('Correct ranking tier: Excellent > Strong > Average > Poor', () => {
  const cohort = [
    // 2 Poor
    { id: 'p1', name: 'Poor 1', task: 1, role: 'Specialist 1', slot: 1, scores: { task_completion_score: 12, ui_score: 6, responsiveness_score: 4, creativity_score: 3 } },
    { id: 'p2', name: 'Poor 2', task: 1, role: 'Specialist 2', slot: 2, scores: { task_completion_score: 15, ui_score: 8, responsiveness_score: 5, creativity_score: 4 } },
    // 2 Average
    { id: 'p3', name: 'Average 1', task: 1, role: 'Specialist 3', slot: 3, scores: { task_completion_score: 24, ui_score: 12, responsiveness_score: 11, creativity_score: 10 } },
    { id: 'p4', name: 'Average 2', task: 1, role: 'Imposter', slot: 4, scores: { task_completion_score: 25, ui_score: 13, responsiveness_score: 12, creativity_score: 11 } },
    // 2 Strong
    { id: 'p5', name: 'Strong 1', task: 1, role: 'Specialist 1', slot: 1, scores: { task_completion_score: 34, ui_score: 17, responsiveness_score: 16, creativity_score: 14 } },
    { id: 'p6', name: 'Strong 2', task: 1, role: 'Specialist 2', slot: 2, scores: { task_completion_score: 35, ui_score: 18, responsiveness_score: 15, creativity_score: 15 } },
    // 2 Excellent
    { id: 'p7', name: 'Excellent 1', task: 1, role: 'Specialist 3', slot: 3, scores: { task_completion_score: 39, ui_score: 19, responsiveness_score: 19, creativity_score: 18 } },
    { id: 'p8', name: 'Excellent 2', task: 1, role: 'Imposter', slot: 4, scores: { task_completion_score: 40, ui_score: 20, responsiveness_score: 18, creativity_score: 19 } },
  ];

  const evaluatedCohort = cohort.map(p => {
    const v = validateCriteriaScores(p.scores, DEFAULT_MAIN_EVENT_CRITERIA);
    return {
      participant_id: p.id,
      participant_name: p.name,
      task_number: p.task,
      role_name: p.role,
      person_slot: p.slot,
      ai_score: v.total,
      total_score: v.total,
      task_match_score: v.scores.task_completion,
      ui_score: v.scores.ui,
      code_quality_score: v.scores.responsiveness,
      creativity_score: v.scores.creativity,
      evaluation_status: 'Evaluated',
    };
  });

  const report = buildTaskCohortReport(1, evaluatedCohort);
  assert.strictEqual(report.ranked_cohort.length, 8);

  const topScore = report.ranked_cohort[0].score;
  const bottomScore = report.ranked_cohort[7].score;
  assert.ok(topScore >= 95, `Top score should be >= 95, got ${topScore}`);
  assert.ok(bottomScore <= 35, `Bottom score should be <= 35, got ${bottomScore}`);

  // Validate strict tier ordering
  const p7Score = evaluatedCohort.find(p => p.participant_id === 'p7').ai_score;
  const p5Score = evaluatedCohort.find(p => p.participant_id === 'p5').ai_score;
  const p3Score = evaluatedCohort.find(p => p.participant_id === 'p3').ai_score;
  const p1Score = evaluatedCohort.find(p => p.participant_id === 'p1').ai_score;

  assert.ok(p7Score > p5Score, `Excellent (${p7Score}) > Strong (${p5Score})`);
  assert.ok(p5Score > p3Score, `Strong (${p5Score}) > Average (${p3Score})`);
  assert.ok(p3Score > p1Score, `Average (${p3Score}) > Poor (${p1Score})`);
});

// ── TEST CATEGORY 3: Tie Preservation ─────────────────────────────────────────
console.log('\nTest Category 3: Tie Preservation (Req #4, #21)');

runTest('Two equally good implementations receive equal scores without forced separation', () => {
  const candidateA = {
    participant_id: 'cand_a',
    participant_name: 'Alice',
    shuffled_group: 'Group 1',
    role_name: 'Specialist 1',
    person_slot: 1,
    ai_score: 92,
    task_match_score: 38,
    ui_score: 18,
    code_quality_score: 18,
    creativity_score: 18,
    passed_tests: ['test1', 'test2', 'test3'],
    failed_tests: [],
  };

  const candidateB = {
    participant_id: 'cand_b',
    participant_name: 'Bob',
    shuffled_group: 'Group 4',
    role_name: 'Specialist 1',
    person_slot: 1,
    ai_score: 92,
    task_match_score: 38,
    ui_score: 18,
    code_quality_score: 18,
    creativity_score: 18,
    passed_tests: ['test1', 'test2', 'test3'],
    failed_tests: [],
  };

  const comparison = compareSameRolePair(candidateA, candidateB);
  assert.strictEqual(comparison.score_gap, 0);
  assert.strictEqual(comparison.candidate_a.score, 92);
  assert.strictEqual(comparison.candidate_b.score, 92);
  assert.ok(comparison.evidence_rationale.includes('Equal performance (92 pts)'));
});

// ── TEST CATEGORY 4: AI-Assisted Code & Code Similarity ───────────────────────
console.log('\nTest Category 4: AI Code & Code Similarity (Req #10, #11, #40)');

runTest('Common coding patterns & AI boilerplate do not alter scoring', () => {
  const codeSnippetA = `
    const items = [1, 2, 3, 4, 5];
    const filtered = items.filter(item => item > 2);
    function renderList(list) {
      return list.map(x => '<div>' + x + '</div>').join('');
    }
  `;

  const codeSnippetB = `
    const items = [1, 2, 3, 4, 5];
    const filtered = items.filter(item => item > 2);
    function renderList(list) {
      return list.map(item => '<div>' + item + '</div>').join('');
    }
  `;

  const similarity = computeCodeSimilarity(codeSnippetA, codeSnippetB);
  assert.ok(similarity > 70, `Similarity should be high for identical boilerplate, got ${similarity}%`);

  const candA = {
    participant_id: 'c1',
    role_name: 'Specialist 2',
    ai_score: 88,
    sourceCode: codeSnippetA,
  };
  const candB = {
    participant_id: 'c2',
    role_name: 'Specialist 2',
    ai_score: 88,
    sourceCode: codeSnippetB,
  };

  const res = compareSameRolePair(candA, candB);
  // Score remains 88, similarity is captured as metadata flag only
  assert.strictEqual(res.candidate_a.score, 88);
  assert.strictEqual(res.candidate_b.score, 88);
  assert.ok(res.similarity_flag !== null);
});

// ── TEST CATEGORY 5: Evidence-Based Rationale for Gaps ───────────────────────
console.log('\nTest Category 5: Evidence Rationale for >= 5 Pt Gaps (Req #27)');

runTest('Score gap >= 5 requires concrete evidence rationale', () => {
  const candA = {
    participant_id: 'c1',
    role_name: 'Specialist 1',
    ai_score: 91,
    task_match_score: 39,
    ui_score: 18,
    code_quality_score: 18,
    creativity_score: 16,
    passed_tests: ['t1', 't2', 't3', 't4'],
    failed_tests: [],
  };

  const candB = {
    participant_id: 'c2',
    role_name: 'Specialist 1',
    ai_score: 79,
    task_match_score: 30,
    ui_score: 17,
    code_quality_score: 16,
    creativity_score: 16,
    passed_tests: ['t1'],
    failed_tests: ['t2', 't3'],
  };

  const res = compareSameRolePair(candA, candB);
  assert.strictEqual(res.score_gap, 12);
  assert.ok(res.evidence_rationale.includes('Candidate A (91) vs Candidate B (79)'));
  assert.ok(res.evidence_rationale.includes('completed more core task requirements'));
  assert.ok(res.evidence_rationale.includes('test failure(s) at runtime'));
});

// ── TEST CATEGORY 6: Imposter Evaluation & Privacy ────────────────────────────
console.log('\nTest Category 6: Imposter Evaluation & Privacy');

runTest('publicEvaluationView sanitizes internal secrets and presents 40/20/20/20 rubric', () => {
  const imposterAssignment = {
    participant_id: 'imp_1',
    is_imposter: true,
    evaluation_status: 'Evaluated',
    ai_score: 85,
    task_match_score: 35,
    ui_score: 18,
    code_quality_score: 16,
    creativity_score: 16,
    ai_feedback: 'Cover job and sabotage cleanly implemented.',
    secret_objective: 'CONFIDENTIAL: Trigger chaos mode on 3 clicks',
    person4_secret: 'CONFIDENTIAL: Trigger chaos mode on 3 clicks',
  };

  const publicView = publicEvaluationView(imposterAssignment, DEFAULT_MAIN_EVENT_CRITERIA);
  assert.strictEqual(publicView.total, 85);
  assert.strictEqual(publicView.scores.task_completion, 35);
  assert.strictEqual(publicView.scores.ui, 18);
  assert.strictEqual(publicView.scores.responsiveness, 16);
  assert.strictEqual(publicView.scores.creativity, 16);
  // Ensure secret objective is NOT present in public view
  assert.strictEqual(publicView.secret_objective, undefined);
  assert.strictEqual(publicView.person4_secret, undefined);
});

console.log('\n===============================================================');
console.log(`ALL TESTS PASSED: ${passedTests} / ${totalTests} test cases succeeded.`);
console.log('===============================================================\n');
