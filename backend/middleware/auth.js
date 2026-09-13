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

const { createClient } = require('@supabase/supabase-js');

// Lazy supabase client — avoids circular deps
let _sb = null;
function getSupabase() {
  if (!_sb) {
    _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  }
  return _sb;
}

/**
 * Express middleware: require a valid admin session token.
 * Usage: router.post('/sensitive', requireAdmin, handler)
 */
async function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Admin authentication required.' });
  }

  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('admin_sessions')
      .select('token, expires_at')
      .eq('token', token)
      .maybeSingle();

    if (error || !data) {
      return res.status(401).json({ success: false, message: 'Invalid or expired admin session.' });
    }

    if (new Date(data.expires_at) < new Date()) {
      // Clean up expired token
      await sb.from('admin_sessions').delete().eq('token', token).catch(() => {});
      return res.status(401).json({ success: false, message: 'Admin session expired. Please log in again.' });
    }

    req.adminToken = token;
    next();
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Auth check failed.' });
  }
}

module.exports = { requireAdmin };
