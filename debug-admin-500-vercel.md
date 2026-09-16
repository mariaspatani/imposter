# Debug Session: admin-endpoints-500-vercel
Status: [OPEN]
Started: 2026-09-16

## Symptoms
- On Vercel deployed site, all Admin routes return HTTP 500.
- Public routes work: `/api/event-timers` (200), `/api/submission-status` (304), `/api/fizzbuzz/toggle` (304).
- Failing: `/api/admin/participants`, `/api/admin/team-scores`, `/api/admin/podium`, `/api/admin/manual-scores`, `/api/admin/event-progress`, `/api/admin/main-event-scores`, `/api/admin/fizzbuzz/all-submissions`, `/api/admin/fizzbuzz-scores`.
- Also failing locally when user opens `admindashboard.html` via `file:///` protocol (since it tries `localhost:3000` which may have a different error).
- Vercel logs show only HTTP status 500 with no error body surfaced.

## Hypotheses
1.  **requireAdmin middleware throws synchronously** during `createClient` call inside `getSupabase()` because env vars are still not resolved in the middleware scope on Vercel.
2.  **admin_sessions table missing / RLS blocking** — `requireAdmin` calls supabase `.from('admin_sessions')` but table or RLS policy doesn't exist, error isn't caught, bubbles as 500.
3.  **Express 5 error-handler signature change** — project uses `express@^5.2.1` which changed error handler signature; if `requireAdmin` calls `next(err)` with a thrown error, the 4-param error handler may not be compatible.
4.  **ADMIN_SECRET not set on Vercel → admin login works, but admin_sessions insert fails** → every subsequent `requireAdmin` call 401/500s.
5.  **Supabase client auth option issue** — `persistSession: false` config wrong shape in @supabase/supabase-js v2 for server-side, causing constructor throw.

## Evidence Log
*(to be filled)*

## Fixes Applied
*(to be filled)*

## Verdict
*(to be filled)*
