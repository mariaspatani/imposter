'use strict';

/**
 * Admin authentication middleware.
 *
 * The coordinator sets ADMIN_SECRET in .env (any long random string).
 * To log in, POST /api/admin/login with { secret: "..." }.
 * The server returns a session token stored in admin_sessions.
 * All subsequent admin requests send:  Authorization: Bearer <token>
 *
 * Sessions expire after 12 hours. The middleware rejects expired tokens.
 */

// ── Env var aliasing — mirror of server.js (avoids cold-start circular deps) ─
// Accepts SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_ANON_KEY.
// On Vercel the server.js boot runs first and sets __SUPABASE_*_RESOLVED fallbacks.
(function resolveEnv() {
  try {
    if (!process.env.SUPABASE_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      process.env.SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
    if (!process.env.SUPABASE_KEY && process.env.SUPABASE_ANON_KEY) {
      process.env.SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
    }
    if (!process.env.SUPABASE_URL && process.env.__SUPABASE_URL_RESOLVED) {
      process.env.SUPABASE_URL = process.env.__SUPABASE_URL_RESOLVED;
    }
    if (!process.env.SUPABASE_KEY && process.env.__SUPABASE_KEY_RESOLVED) {
      process.env.SUPABASE_KEY = process.env.__SUPABASE_KEY_RESOLVED;
    }
  } catch (_) { /* never let env parsing kill server boot */ }
})();

const { createClient } = require('@supabase/supabase-js');

// Lazy supabase client — avoids circular deps.
// NEVER throws: returns null + stores a human-readable reason.
let _sb = null;
let _sbError = null;
function getSupabase() {
  if (_sb) return _sb;
  _sbError = null;
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      _sbError = 'Supabase credentials missing. Set SUPABASE_URL + SUPABASE_KEY (or SUPABASE_SERVICE_ROLE_KEY) in Vercel Project Settings → Environment Variables, then Redeploy.';
      return null;
    }
    _sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return _sb;
  } catch (err) {
    _sbError = 'createClient failed: ' + ((err && err.message) ? err.message : String(err));
    return null;
  }
}

/**
 * Express middleware: require a valid admin session token.
 * Usage: router.post('/sensitive', requireAdmin, handler)
 *
 * IMPORTANT: this function is designed to NEVER throw synchronously.
 * All paths end with res.json(...) or next().
 */
async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    if (!token) {
      if (!res.headersSent) {
        return res.status(401).json({ success: false, message: 'Admin authentication required.' });
      }
      return;
    }

    const sb = getSupabase();
    if (!sb) {
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: 'Admin auth backend not available: ' + (_sbError || 'Supabase client unavailable.')
        });
      }
      return;
    }

    const { data, error } = await sb
      .from('admin_sessions')
      .select('token, expires_at')
      .eq('token', token)
      .maybeSingle();

    if (error) {
      // Distinguish common database errors (table missing / RLS) from other Supabase errors
      const isMissingTable = error.message && (error.message.includes('does not exist') || error.message.includes('schema cache'));
      const msg = isMissingTable
        ? 'Database setup incomplete: admin_sessions table is missing or RLS policy blocks it. Run backend/migrations/002_missing_tables.sql + 003_disable_rls.sql in Supabase SQL Editor.'
        : ('Auth DB error: ' + error.message);
      if (!res.headersSent) {
        return res.status(500).json({ success: false, message: msg });
      }
      return;
    }

    if (!data) {
      if (!res.headersSent) {
        return res.status(401).json({ success: false, message: 'Invalid or expired admin session. Please log in again.' });
      }
      return;
    }

    if (new Date(data.expires_at) < new Date()) {
      // Clean up expired token (best-effort)
      try { await sb.from('admin_sessions').delete().eq('token', token).catch(() => {}); } catch (_) {}
      if (!res.headersSent) {
        return res.status(401).json({ success: false, message: 'Admin session expired. Please log in again.' });
      }
      return;
    }

    req.adminToken = token;
    return next();
  } catch (err) {
    // Final safety net — any other error becomes a 500 with the real message
    try {
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: 'Auth check failed: ' + ((err && err.message) ? err.message : String(err))
        });
      }
    } catch (_) { /* defensive */ }
    return;
  }
}

module.exports = { requireAdmin, _getSupabaseDiagnostics: () => ({ ok: !!_sb, error: _sbError }) };
