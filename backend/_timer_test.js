'use strict';

// Test computeRemaining timer logic
function computeRemaining(t) {
  if (!t) return 0;
  const fullSecs = (t.duration_minutes || 15) * 60;
  if (t.status === 'finished') return 0;
  if (t.status === 'running' && t.started_at) {
    const runningFor = Math.floor((Date.now() - new Date(t.started_at).getTime()) / 1000);
    const stored = (t.remaining_seconds != null && t.remaining_seconds > 0) ? t.remaining_seconds : fullSecs;
    return Math.max(0, stored - runningFor);
  }
  if (t.remaining_seconds != null && t.remaining_seconds > 0) return t.remaining_seconds;
  return fullSecs;
}

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | got=' + actual + ' expected=' + expected);
  ok ? pass++ : fail++;
}

// Test 1: finished timer returns 0
check('finished timer', computeRemaining({ status:'finished', remaining_seconds:500, duration_minutes:45 }), 0);

// Test 2: null timer returns 0  
check('null timer', computeRemaining(null), 0);

// Test 3: idle timer returns full duration
check('idle full duration', computeRemaining({ status:'idle', duration_minutes:45 }), 2700);

// Test 4: paused timer returns snapshot
check('paused returns snapshot', computeRemaining({ status:'paused', remaining_seconds:1337, duration_minutes:45 }), 1337);

// Test 5: running timer counts down
const twoSecsAgo = new Date(Date.now() - 2000).toISOString();
const running = computeRemaining({ status:'running', started_at: twoSecsAgo, remaining_seconds:2700, duration_minutes:45 });
const ok5 = running >= 2696 && running <= 2698; // allow 2s window
console.log((ok5?'PASS':'FAIL') + ' | running timer counts down | got=' + running + ' expected=~2698'); ok5 ? pass++ : fail++;

// Test 6: running timer clamps to 0 when expired
const longAgo = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
check('expired running clamps to 0', computeRemaining({ status:'running', started_at:longAgo, remaining_seconds:2700, duration_minutes:45 }), 0);

// Test 7: remaining_seconds=0 on fresh start falls back to full duration
const justNow = new Date(Date.now() - 100).toISOString();
const freshRun = computeRemaining({ status:'running', started_at:justNow, remaining_seconds:0, duration_minutes:45 });
const ok7 = freshRun >= 2698 && freshRun <= 2700;
console.log((ok7?'PASS':'FAIL') + ' | fresh start falls back to full | got=' + freshRun + ' expected=~2700'); ok7 ? pass++ : fail++;

// Test 8: pause then resume - remaining is preserved
// Simulate: timer started at 100s ago with 2700s, paused at elapsed 50s (remaining=2650)
const pausedTimer = { status:'paused', remaining_seconds:2650, duration_minutes:45, paused_at: new Date().toISOString(), started_at: null };
check('paused preserves remaining', computeRemaining(pausedTimer), 2650);

// Test 9: negative remaining_seconds should never occur
const negTimer = computeRemaining({ status:'paused', remaining_seconds:-100, duration_minutes:45 });
// remaining_seconds <= 0, so falls back to fullSecs  
check('negative remaining falls to fullSecs', negTimer, 2700);

// ── Timer state transition validation ────────────────────────────────────────
console.log('\n=== TIMER STATE TRANSITIONS ===');

function timerAction(t, action) {
  const fullSecs = (t.duration_minutes || 15) * 60;
  if (action === 'start') {
    if (t.status === 'running') return { ok: false, msg: 'already running' };
    if (t.status === 'finished') return { ok: false, msg: 'already finished' };
    return { ok: true, status: 'running', remaining_seconds: fullSecs };
  }
  if (action === 'pause') {
    if (t.status !== 'running') return { ok: false, msg: 'not running' };
    return { ok: true, status: 'paused' };
  }
  if (action === 'resume') {
    if (t.status !== 'paused') return { ok: false, msg: 'not paused' };
    return { ok: true, status: 'running' };
  }
  if (action === 'reset') {
    return { ok: true, status: 'idle', remaining_seconds: fullSecs };
  }
  if (action === 'finish') {
    return { ok: true, status: 'finished', remaining_seconds: 0 };
  }
  return { ok: false, msg: 'unknown action' };
}

// idle → start → running
const r1 = timerAction({ status:'idle', duration_minutes:45 }, 'start');
console.log((r1.ok && r1.status==='running') ? 'PASS' : 'FAIL', '| idle->start = running'); r1.ok ? pass++ : fail++;

// running → start (rejected)
const r2 = timerAction({ status:'running', duration_minutes:45 }, 'start');
console.log((!r2.ok) ? 'PASS' : 'FAIL', '| running->start rejected'); !r2.ok ? pass++ : fail++;

// finished → start (rejected)
const r3 = timerAction({ status:'finished', duration_minutes:45 }, 'start');
console.log((!r3.ok) ? 'PASS' : 'FAIL', '| finished->start rejected'); !r3.ok ? pass++ : fail++;

// running → pause
const r4 = timerAction({ status:'running', duration_minutes:45 }, 'pause');
console.log((r4.ok && r4.status==='paused') ? 'PASS' : 'FAIL', '| running->pause = paused'); r4.ok ? pass++ : fail++;

// idle → pause (rejected)
const r5 = timerAction({ status:'idle', duration_minutes:45 }, 'pause');
console.log((!r5.ok) ? 'PASS' : 'FAIL', '| idle->pause rejected'); !r5.ok ? pass++ : fail++;

// paused → resume
const r6 = timerAction({ status:'paused', duration_minutes:45 }, 'resume');
console.log((r6.ok && r6.status==='running') ? 'PASS' : 'FAIL', '| paused->resume = running'); r6.ok ? pass++ : fail++;

// running → resume (rejected)
const r7 = timerAction({ status:'running', duration_minutes:45 }, 'resume');
console.log((!r7.ok) ? 'PASS' : 'FAIL', '| running->resume rejected'); !r7.ok ? pass++ : fail++;

// any → finish
const r8 = timerAction({ status:'running', duration_minutes:45 }, 'finish');
console.log((r8.ok && r8.status==='finished' && r8.remaining_seconds===0) ? 'PASS' : 'FAIL', '| running->finish = 0 seconds'); r8.ok ? pass++ : fail++;

// any → reset
const r9 = timerAction({ status:'finished', duration_minutes:45 }, 'reset');
console.log((r9.ok && r9.status==='idle' && r9.remaining_seconds===2700) ? 'PASS' : 'FAIL', '| reset = idle + full duration'); r9.ok ? pass++ : fail++;

console.log('\n=== SUMMARY ===');
console.log('PASSED:', pass, '/ FAILED:', fail);
if (fail > 0) process.exit(1);
