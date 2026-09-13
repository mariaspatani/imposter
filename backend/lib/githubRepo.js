'use strict';

const axios  = require('axios');
const AdmZip = require('adm-zip');
const path   = require('path');
const { safeZipEntry } = require('../middleware/sanitize');

const READ_EXTS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.ts',
  '.json', '.jsx', '.tsx', '.svg', '.md', '.txt'
]);

const SKIP_PATTERNS = [
  'node_modules/', '.git/', 'dist/', 'build/',
  'package-lock.json', '.min.js', '.min.css'
];

const MAX_ARCHIVE_BYTES  = 30 * 1024 * 1024;
const MAX_TOTAL_CHARS    = 120_000;
const MAX_CHARS_PER_FILE = 8_000;
const MAX_FILE_COUNT     = 200;

function shouldSkip(entryName) {
  return SKIP_PATTERNS.some(p => entryName.includes(p));
}

async function downloadAndReadRepo(githubUrl) {
  const clean = String(githubUrl || '').trim().replace(/\/$/, '');
  const urls = [
    `${clean}/archive/refs/heads/main.zip`,
    `${clean}/archive/refs/heads/master.zip`
  ];

  let zipBuffer = null;
  let lastError = null;

  for (const url of urls) {
    try {
      const response = await axios.get(url, {
        responseType:      'arraybuffer',
        timeout:           30_000,
        maxContentLength:  MAX_ARCHIVE_BYTES,
        headers: {
          'User-Agent': 'AshtaImposterEvaluator/2.0',
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {})
        }
      });
      zipBuffer = Buffer.from(response.data);
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!zipBuffer) {
    const status = lastError?.response?.status;
    if (status === 404) throw new Error('GitHub repository not found or is private.');
    throw new Error('Failed to download repository: ' + (lastError?.message || 'Unknown error'));
  }

  const zip     = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const parts   = [];
  let totalLen  = 0;
  let fileCount = 0;

  for (const entry of entries) {
    if (fileCount >= MAX_FILE_COUNT) break;
    if (totalLen  >= MAX_TOTAL_CHARS) break;
    if (entry.isDirectory) continue;

    const rawName = entry.entryName;
    if (!safeZipEntry(rawName)) continue;
    if (shouldSkip(rawName))    continue;

    const ext = path.extname(rawName).toLowerCase();
    if (!READ_EXTS.has(ext)) continue;

    try {
      const content = entry.getData().toString('utf8');
      const snippet = content.slice(0, MAX_CHARS_PER_FILE);
      parts.push(`\n\n// ===== FILE: ${rawName} =====\n${snippet}`);
      totalLen += snippet.length;
      fileCount++;
    } catch (_) {}
  }

  if (parts.length === 0) {
    return '(No readable source files found in this repository.)';
  }

  return parts.join('').slice(0, MAX_TOTAL_CHARS);
}

async function validateRepository(repoUrl) {
  const clean = String(repoUrl || '').trim().replace(/\/$/, '').replace(/\.git$/i, '');
  const match = clean.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+)$/i);

  if (!match) {
    return { valid: false, message: 'Invalid GitHub repository URL format.' };
  }

  const [, owner, repo] = match;

  try {
    const res = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
      timeout: 10_000,
      headers: {
        'User-Agent': 'AshtaImposterEvaluator/2.0',
        Accept: 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {})
      }
    });

    const r = res.data;

    if (r.private)   return { valid: false, message: 'Repository is private. Please make it public before submitting.' };
    if (r.archived)  return { valid: false, message: 'Archived repositories cannot be submitted.' };
    if (r.size === 0) return { valid: false, message: 'Repository appears to be empty.' };

    return { valid: true, owner, repo, defaultBranch: r.default_branch };

  } catch (err) {
    if (err?.response?.status === 404) {
      return { valid: false, message: 'Repository not found. Check the URL and ensure it is public.' };
    }
    if (err?.response?.status === 403 || err?.response?.status === 429) {
      console.warn('[GitHub] Rate limited — assuming repo valid:', owner, repo);
      return { valid: true, owner, repo, defaultBranch: 'main' };
    }
    return { valid: false, message: 'Could not verify repository. Please check the URL.' };
  }
}

module.exports = { downloadAndReadRepo, validateRepository };
