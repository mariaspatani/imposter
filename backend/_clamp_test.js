'use strict';
const { clampScore, isValidGitHubUrl } = require('./middleware/sanitize');

// Test .git suffix issue
console.log('=== .git SUFFIX ISSUE ===');
console.log('repo.git accepted:', isValidGitHubUrl('https://github.com/user/repo.git'));

// Test what GitHub API does with repo.git
// The regex in aiScorer.js also allows .git suffix
const match = 'https://github.com/user/repo.git'.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+)\/?$/i);
console.log('aiScorer repo name extracted:', match ? match[2] : 'no match');
// GitHub API for "repo.git" returns 404 (correct behavior from GitHub),
// so invalid .git URLs will naturally fail at validation stage.
// However, the URL validator should ideally reject .git suffix since
// it's not a valid GitHub web URL format.

// Test Infinity clamping  
console.log('\n=== CLAMP INFINITY ===');
const v1 = 1e308;
console.log('Number.isFinite(1e308):', Number.isFinite(v1), 'clamp:', clampScore(v1, 0, 100));
console.log('Number.isFinite(Infinity):', Number.isFinite(Infinity), 'clamp:', clampScore(Infinity, 0, 100));
// Infinity cannot appear in standard JSON (JSON.parse would not produce it)
// but let's verify what Groq could produce
const groqResponse = JSON.stringify({task_completion_score: 40});
const parsed = JSON.parse(groqResponse);
console.log('Normal Groq response clamped:', clampScore(parsed.task_completion_score, 0, 40));
