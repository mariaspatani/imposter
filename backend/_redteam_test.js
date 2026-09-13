'use strict';
const sanitize = require('./middleware/sanitize');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | got=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
  ok ? pass++ : fail++;
}

// ── SSRF / URL validation ────────────────────────────────────────────────────
console.log('\n=== SSRF / URL VALIDATION ===');
check('block localhost',          sanitize.isValidGitHubUrl('http://localhost/evil'), false);
check('block 127.0.0.1',         sanitize.isValidGitHubUrl('http://127.0.0.1/evil'), false);
check('block SSRF metadata',     sanitize.isValidGitHubUrl('http://169.254.169.254/metadata'), false);
check('block file scheme',       sanitize.isValidGitHubUrl('file:///etc/passwd'), false);
check('block javascript scheme', sanitize.isValidGitHubUrl('javascript:alert(1)'), false);
check('block evil domain',       sanitize.isValidGitHubUrl('https://evil.com/user/repo'), false);
check('block github.com.evil',   sanitize.isValidGitHubUrl('https://github.com.evil.com/user/repo'), false);
check('block .git suffix',       sanitize.isValidGitHubUrl('https://github.com/user/repo.git'), false);
check('allow valid repo',        sanitize.isValidGitHubUrl('https://github.com/user/repo'), true);
check('allow trailing slash',    sanitize.isValidGitHubUrl('https://github.com/user/repo/'), true);
check('allow www subdomain',     sanitize.isValidGitHubUrl('https://www.github.com/user/repo'), true);

// ── ZIP security ─────────────────────────────────────────────────────────────
console.log('\n=== ZIP SECURITY ===');
check('block path traversal ..',   sanitize.safeZipEntry('../etc/passwd'), null);
check('block double ..',           sanitize.safeZipEntry('../../secret'), null);
check('block absolute path',       sanitize.safeZipEntry('/absolute/path'), null);
check('block null byte',           sanitize.safeZipEntry('file\x00name'), null);
check('allow normal path',         sanitize.safeZipEntry('safe/path/file.js'), 'safe/path/file.js');
check('allow top-level file',      sanitize.safeZipEntry('file.html'), 'file.html');

// ── Score clamping ────────────────────────────────────────────────────────────
console.log('\n=== SCORE CLAMPING ===');
check('clamp 1000->100',       sanitize.clampScore(1000, 0, 100), 100);
check('clamp obj->0',          sanitize.clampScore({}, 0, 100), 0);
check('clamp -50->0',          sanitize.clampScore(-50, 0, 100), 0);
check('clamp 50->50',          sanitize.clampScore(50, 0, 100), 50);
check('clamp null->0',         sanitize.clampScore(null, 0, 100), 0);
check('clamp undefined->0',    sanitize.clampScore(undefined, 0, 100), 0);
check('clamp string 45->40',   sanitize.clampScore('45', 0, 40), 40);  // max 40
check('clamp NaN->0',          sanitize.clampScore(NaN, 0, 100), 0);
check('clamp Infinity->100',   sanitize.clampScore(Infinity, 0, 100), 100);
check('clamp -Inf->0',         sanitize.clampScore(-Infinity, 0, 100), 0);

// ── UUID validation ───────────────────────────────────────────────────────────
console.log('\n=== UUID VALIDATION ===');
check('valid uuid',            sanitize.isUUID('123e4567-e89b-12d3-a456-426614174000'), true);
check('reject not-a-uuid',     sanitize.isUUID('not-a-uuid'), false);
check('reject empty',          sanitize.isUUID(''), false);
check('reject bad hex char',   sanitize.isUUID('123e4567-e89b-12d3-a456-42661417400G'), false);
check('accept with spaces',    sanitize.isUUID('  123e4567-e89b-12d3-a456-426614174000  '), true);

// ── escHtml XSS ──────────────────────────────────────────────────────────────
console.log('\n=== XSS ESCAPING ===');
check('escape script tag',     sanitize.escHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
check('escape img onerror',    sanitize.escHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
check('escape double-quote',   sanitize.escHtml('"quoted"'), '&quot;quoted&quot;');
check('escape single-quote',   sanitize.escHtml("it's"), "it&#39;s");
check('escape ampersand',      sanitize.escHtml('a&b'), 'a&amp;b');
check('null safe',             sanitize.escHtml(null), '');
check('undefined safe',        sanitize.escHtml(undefined), '');

// ── sanitizeName ─────────────────────────────────────────────────────────────
console.log('\n=== NAME SANITIZATION ===');
check('valid name',            sanitize.sanitizeName('Alice Johnson'), 'Alice Johnson');
check('reject empty',          sanitize.sanitizeName(''), null);
check('reject too long',       sanitize.sanitizeName('a'.repeat(101)), null);
check('reject non-string',     sanitize.sanitizeName(42), null);
check('trim whitespace',       sanitize.sanitizeName('  Bob  '), 'Bob');

console.log('\n=== SUMMARY ===');
console.log('PASSED:', pass, '/ FAILED:', fail);
if (fail > 0) process.exit(1);
