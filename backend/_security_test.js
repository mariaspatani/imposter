'use strict';

const http = require('http');

let pass = 0, fail = 0;

function req(method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'localhost', port: 3000, path, method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | got=' + actual + ' expected=' + expected);
  ok ? pass++ : fail++;
}

async function run() {
  console.log('=== ADMIN AUTH TESTS (no token) ===');
  const adminRoutes = [
    ['GET',  '/api/admin/overview'],
    ['GET',  '/api/admin/participants'],
    ['GET',  '/api/admin/team-scores'],
    ['GET',  '/api/admin/podium'],
    ['GET',  '/api/admin/manual-scores'],
    ['GET',  '/api/admin/fizzbuzz/submissions'],
    ['GET',  '/api/admin/fizzbuzz/submissions-v2'],
    ['GET',  '/api/admin/audit-log'],
    ['GET',  '/api/admin/code-imposter-submissions'],
    ['GET',  '/api/admin/event-progress'],
    ['GET',  '/api/registered-teams'],
    ['GET',  '/api/shuffle-layout'],
    ['POST', '/api/register-team'],
    ['POST', '/api/start-shuffle'],
    ['POST', '/api/admin/unlock-submission'],
    ['POST', '/api/admin/manual-score'],
    ['POST', '/api/admin/update-main-event-score'],
    ['POST', '/api/admin/recover-evaluations'],
    ['POST', '/api/admin/unlock-shuffle'],
    ['POST', '/api/admin/fizzbuzz/score'],
    ['POST', '/api/admin/fizzbuzz/score-v2'],
    ['POST', '/api/admin/fizzbuzz/toggle'],
    ['POST', '/api/event/start'],
    ['POST', '/api/event/pause'],
    ['POST', '/api/event/resume'],
    ['POST', '/api/event/reset'],
    ['POST', '/api/event/finish'],
    ['POST', '/api/evaluate-submission/123e4567-e89b-12d3-a456-426614174000'],
    ['GET',  '/api/timers'],
  ];

  for (const [method, path] of adminRoutes) {
    const r = await req(method, path, {});
    check('auth required ' + method + ' ' + path, r.status, 401);
  }

  console.log('\n=== ADMIN AUTH TESTS (wrong token) ===');
  const wrongToken = { 'Authorization': 'Bearer wrongtoken123' };
  const r1 = await req('GET', '/api/admin/overview', null, wrongToken);
  check('wrong token rejected', r1.status, 401);

  const r2 = await req('GET', '/api/admin/overview', null, { 'Authorization': 'Bearer ' });
  check('empty bearer rejected', r2.status, 401);

  const r3 = await req('GET', '/api/admin/overview', null, { 'Authorization': 'Basic admin:admin' });
  check('basic auth rejected', r3.status, 401);

  console.log('\n=== PUBLIC ENDPOINT TESTS ===');
  // Health check should work
  const h = await req('GET', '/api/health');
  check('health check accessible', h.status, 200);

  // Timer public endpoint
  const t = await req('GET', '/api/event-timers');
  check('event-timers accessible', t.status, 200);

  // Authenticate with bad credentials
  const a1 = await req('POST', '/api/authenticate', { name: 'x', team_name: 'nonexistent_team_xyz' });
  check('bad auth returns 404', a1.status, 404);

  // My-assignment with invalid UUID
  const a2 = await req('GET', '/api/my-assignment/not-a-uuid');
  check('invalid UUID returns 400', a2.status, 400);

  // My-assignment with valid UUID format (but not in DB)
  const a3 = await req('GET', '/api/my-assignment/123e4567-e89b-12d3-a456-426614174000');
  check('unknown UUID returns 404', a3.status, 404);

  // Submit github with invalid participant  
  const a4 = await req('POST', '/api/submit-github', { participant_id: 'not-a-uuid', github_repo: 'https://github.com/x/y' });
  check('invalid participant submit returns 400', a4.status, 400);

  // SSRF attempts in github URL
  const a5 = await req('POST', '/api/submit-github', {
    participant_id: '123e4567-e89b-12d3-a456-426614174000',
    github_repo: 'http://localhost/evil'
  });
  check('SSRF localhost blocked', a5.status, 400);

  const a6 = await req('POST', '/api/submit-github', {
    participant_id: '123e4567-e89b-12d3-a456-426614174000',
    github_repo: 'http://169.254.169.254/metadata'
  });
  check('SSRF metadata blocked', a6.status, 400);

  const a7 = await req('POST', '/api/submit-github', {
    participant_id: '123e4567-e89b-12d3-a456-426614174000',
    github_repo: 'https://evil.com/user/repo'
  });
  check('non-github URL blocked', a7.status, 400);

  const a8 = await req('POST', '/api/submit-github', {
    participant_id: '123e4567-e89b-12d3-a456-426614174000',
    github_repo: 'https://github.com/user/repo.git'
  });
  check('.git suffix blocked', a8.status, 400);

  // Admin login brute force protection
  console.log('\n=== ADMIN LOGIN TESTS ===');
  const l1 = await req('POST', '/api/admin/login', { secret: 'wrongpassword' });
  check('wrong password returns 401', l1.status, 401);

  // No secret field
  const l2 = await req('POST', '/api/admin/login', {});
  check('empty secret returns 401', l2.status, 401);

  console.log('\n=== ROUTE NOT FOUND ===');
  const r404 = await req('GET', '/api/nonexistent-route-xyz');
  check('unknown route returns 404', r404.status, 404);

  // Try to escalate participant to admin
  console.log('\n=== PRIVILEGE ESCALATION ===');
  const pe = await req('POST', '/api/start-shuffle', {}, { 'Authorization': 'Bearer participant_uuid_here' });
  check('participant token rejected for shuffle', pe.status, 401);

  console.log('\n=== FIZZBUZZ SUBMIT WITHOUT VALID PARTICIPANT ===');
  const fb = await req('POST', '/api/fizzbuzz/submit-v2', {
    participant_id: '123e4567-e89b-12d3-a456-426614174000',
    fizz_output: '1\n2\nFizz\n4\nBuzz'
  });
  // Should be 404 (no assignment for this random UUID)
  const fbOk = fb.status === 404 || fb.status === 403;
  console.log((fbOk?'PASS':'FAIL') + ' | fizzbuzz with unknown participant | got=' + fb.status + ' expected=404/403');
  fbOk ? pass++ : fail++;

  console.log('\n=== SUMMARY ===');
  console.log('PASSED:', pass, '/ FAILED:', fail);
  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error('Test error:', e); process.exit(1); });
