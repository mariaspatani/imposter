# 👾 ASTHRA 2K26 – IMPOSTER

> A real-time live-coding competition platform for **ASTHRA 2K26** — 24 participants, 6 imposters, AI-scored GitHub submissions.

---

## 🧱 Tech Stack

| Layer      | Technology                                   |
|------------|----------------------------------------------|
| Frontend   | HTML5 + Vanilla JS + Tailwind CDN            |
| Backend    | Node.js 18+ / Express 5                      |
| Database   | Supabase (PostgreSQL)                        |
| AI Scoring | Groq API (llama-3.3-70b-versatile)           |
| GitHub API | Authenticated via Personal Access Token      |
| Deployment | Vercel (serverless + static)                 |

---

## 📁 Project Structure

```text
imposter/
├── frontend/
│   ├── homepage.html           # Participant login + role reveal
│   ├── team_registration.html  # Coordinator: register teams + shuffle
│   ├── admindashboard.html     # Coordinator: live dashboard + scoring
│   ├── main_event_page.html    # Participant: task + GitHub submission
│   ├── fizzbuzz.html           # Participant: FizzBuzz gate
│   ├── fizzbuzz_coding.html    # Participant: FizzBuzz submission
│   └── codeimposter.html       # Participant: Code Imposter timer
│
├── backend/
│   ├── server.js               # Main Express server (all API routes)
│   ├── aiScorer.js             # Groq AI evaluation + GitHub ZIP reader
│   ├── middleware/
│   │   ├── auth.js             # Admin session authentication
│   │   ├── rateLimit.js        # Token-bucket rate limiting
│   │   └── sanitize.js         # Input validation + XSS helpers
│   ├── migrations/
│   │   └── 001_full_schema.sql # Canonical DB schema (run once)
│   └── package.json
│
├── vercel.json                 # Vercel deployment routing
├── .env.example                # Environment variable documentation
└── README.md
```

---

## ⚙️ Environment Variables

Copy `.env.example` to `.env` and fill in all values:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=sb_publishable_...
GROQ_API_KEY=gsk_...
GITHUB_TOKEN=ghp_...           # Required for 5000 req/hr (vs 60 unauthenticated)
ADMIN_SECRET=change_me_...     # Long random string — protects all admin routes
FRONTEND_ORIGIN=https://...    # Your Vercel deployment URL (for CORS)
PORT=3000                      # Local dev only
```

---

## 🚀 Local Development

```bash
cd backend
npm install
node server.js          # API on http://localhost:3000
```

Open any frontend page directly in browser (file:// or a local HTTP server):
```bash
cd frontend
python -m http.server 8080
# Open http://localhost:8080/homepage.html
```

---

## ☁️ Vercel Deployment

1. Push repository to GitHub
2. Import to Vercel
3. Set all environment variables in Vercel dashboard
4. Deploy — `vercel.json` routes `/api/*` to `backend/server.js`

---

## 🗄️ Database Setup

Run **once** in the Supabase SQL Editor:

```
backend/migrations/001_full_schema.sql
```

This creates all tables with correct constraints and seeds the 3 task definitions.

> ⚠️ **DO NOT run `seed_test_data.sql` in production.**

---

---

# 🗓️ EVENT-DAY RUNBOOK

## Pre-Event Checklist (Before Participants Arrive)

- [ ] Verify Supabase is reachable: `GET /api/health`
- [ ] Verify `ADMIN_SECRET` is set in production environment
- [ ] Verify `GITHUB_TOKEN` is set (prevents rate limit during 24 simultaneous submissions)
- [ ] Verify `GROQ_API_KEY` is set
- [ ] Verify `FRONTEND_ORIGIN` matches deployed URL
- [ ] Confirm migration `001_full_schema.sql` has been run
- [ ] Confirm tasks 1-3 exist in `main_event_tasks` table
- [ ] Open `admindashboard.html` and log in with `ADMIN_SECRET`
- [ ] Verify Dashboard → Overview shows 0 registered teams (clean state)

---

## Step 1 — Team Registration

**Who:** Coordinator  
**Where:** `team_registration.html`

1. Login with `ADMIN_SECRET`
2. Register each of 6 teams (team name + 4 member names exactly as they will type them)
3. Verify the "Registered Teams" panel shows 6 complete teams (4/4 members each)
4. **Requirement before shuffle:** All 6 teams must show `4/4 Members` badge

---

## Step 2 — Run the Shuffle

**Who:** Coordinator  
**Where:** `team_registration.html` → "Shuffle" section

1. Click **Shuffle All Teams**
2. Wait for the animation to complete (typically 1-3 seconds)
3. Verify success: "Shuffle completed. 6 groups created."
4. Switch to "Seating Arrangement" tab — verify 6 groups, each with 4 members, 1 marked as Imposter
5. Verify no team member is seated with another member of their original team

> ⚠️ **The shuffle is locked after first run.** A second accidental click will return an error.  
> To re-shuffle (testing only): use `POST /api/admin/unlock-shuffle` first, then re-shuffle.  
> **Never re-shuffle after participants have seen their roles.**

---

## Step 3 — Participant Login + Role Reveal

**Who:** Participants  
**Where:** `homepage.html`

1. Each participant opens the homepage
2. Clicks the red **START** button
3. Enters their **exact** participant name and team name (case-sensitive)
4. Sees role reveal:
   - 🟢 Specialist: sees their task + role + work description
   - 🔴 Imposter: sees their cover job + **SECRET SABOTAGE OBJECTIVE** (red block)
5. After 5-second countdown → redirected to `main_event_page.html`

> Participants should keep their phones/laptops closed during role reveal until instructed.

---

## Step 4 — Start the Main Event Timer

**Who:** Coordinator  
**Where:** `admindashboard.html` → **Event Timers** tab

1. Find the **Main Event** timer card
2. Click **▶ Start**
3. Verify timer shows `45:00` and status changes to `▶ Running`
4. Announce "The event has started!"

> Timer is authoritative server-side. Participants' pages poll the server every 5 seconds.

---

## Step 5 — Monitor GitHub Submissions

**Who:** Coordinator  
**Where:** `admindashboard.html` → **Overview** tab + **Participants** tab

- Watch the "Recent Submissions" panel update as participants submit
- Counter shows `X/24 Submitted`
- Each submission triggers automatic AI evaluation
- Status progresses: `Pending → Submitted → Evaluating → Evaluated`

> If a participant accidentally submits the wrong repo:  
> Click **🔓 Unlock** on their row → they can resubmit.

---

## Step 6 — Monitor AI Evaluations

**Who:** Coordinator  
**Where:** `admindashboard.html` → **Participants** tab

- Filter by Status = "Submitted" to see evaluations in progress
- If status is stuck at "Evaluating" for more than 3 minutes:
  - Click **🤖 Evaluate** button to manually re-trigger
- If Groq is unavailable: submissions are safe. Use **🤖 Evaluate** later when Groq recovers.

---

## Step 7 — Announce 5-Minute Warning

Tell participants:
> "5 minutes remaining. Finalize your GitHub commits and submit your repository URL."

---

## Step 8 — Open FizzBuzz Round

**Who:** Coordinator  
**Where:** `admindashboard.html` → **Event Timers** tab

1. Find the **FizzBuzz** timer card → click **▶ Start**
   - OR: Use the **FizzBuzz Round** toggle card → click **Turn ON**
2. Announce: "FizzBuzz round is now open! Each group must collaboratively write a FizzBuzz solution."
3. Participants on `main_event_page.html` will see the **"ENTER FIZZBUZZ ROUND"** button appear automatically
4. Groups navigate to `fizzbuzz.html` → `fizzbuzz_coding.html`

---

## Step 9 — Score FizzBuzz Submissions

**Who:** Coordinator  
**Where:** `admindashboard.html` → **FizzBuzz** tab

For each group that has submitted:
1. Review the submitted code/output
2. Click **✅ Mark Correct** or **❌ Mark Wrong**
3. Scores are applied automatically:
   - Correct: 20 pts (team) + speed bonus (5 pts for 1st/2nd, 2 pts for others)
   - Imposter sabotage detected: +10 pts bonus for the imposter

---

## Step 10 — Code Imposter Round

**Who:** Coordinator  
**Where:** Announce to participants

1. Participants navigate to `codeimposter.html` directly (or coordinator distributes the link)
2. Timer starts automatically when page loads
3. Each participant enters their name and clicks **SUBMIT** when finished
4. Coordinator can view submissions: `admindashboard.html` → the code-imposter submissions are in the database

---

## Step 11 — Enter Manual Scores

**Who:** Coordinator  
**Where:** `admindashboard.html` → **Manual Scoring** tab

For each of the 3 manual events (**Code Imposter**, **Sherlock Holmes**, **Drawing**):
1. Enter a score (0-100) for each team
2. Click **Save**
3. Scores update the podium immediately

---

## Step 12 — View Final Podium

**Who:** Coordinator  
**Where:** `admindashboard.html` → **Team Podium** tab

- Top 3 teams displayed with medals
- Full ranking table with breakdowns (Main Event / FizzBuzz / Manual)
- Share the screen for the final reveal!

---

## 🚨 Emergency Procedures

### Groq AI is unavailable

**Impact:** Evaluations won't complete automatically.  
**Action:**
1. No participant action needed — submissions are already saved
2. Wait until Groq recovers (usually minutes)
3. In dashboard → Participants tab, click **🤖 Evaluate** for each "Submitted" participant
4. Or score manually: use `POST /api/admin/update-main-event-score`

---

### GitHub API is unavailable

**Impact:** New GitHub submissions will fail validation.  
**Action:**
1. The server will attempt to rate-limit gracefully (assumes repo is valid if GitHub returns 403/429)
2. If participants get "Repository not found" errors, ask them to verify their URL
3. As last resort: admin can manually update `github_repo` in Supabase directly

---

### Supabase is unavailable

**Impact:** All database operations fail.  
**Action:**
1. Backend returns 500 errors with clear messages
2. Participants see "Unable to reach server" — do NOT let them retry indefinitely
3. Pause the physical event, wait for Supabase recovery (Supabase has 99.9% SLA)
4. Resume from the same state — all data was persisted before the outage

---

### Timer shows wrong time on participant pages

**Cause:** Browser clock drift or missed poll.  
**Action:** Participant refreshes page — timer re-syncs from authoritative server value.

---

### Participant can't log in ("Invalid team or participant name")

**Cause:** Name mismatch (spaces, capitalization).  
**Action:**
1. Check `team_registration.html` → Registered Teams for exact name
2. Participant must type exactly as registered (case-sensitive)
3. If name was registered incorrectly: coordinator can edit in Supabase `participants` table

---

### Participant accidentally submitted wrong GitHub repo

**Action:**
1. Dashboard → Participants tab
2. Find participant → click **🔓 Unlock**
3. Tell participant to resubmit with correct URL

---

### Need to re-shuffle (testing only — NEVER during live event)

```
POST /api/admin/unlock-shuffle   (with Authorization: Bearer <token>)
POST /api/start-shuffle          (with Authorization: Bearer <token>)
```

> ⚠️ Re-shuffling after event starts will erase all submissions and scores.

---

## 🔐 Security Notes

- `ADMIN_SECRET` must be a long random string (min 32 chars)
- Admin sessions expire after 12 hours
- All admin API routes require `Authorization: Bearer <token>`
- Participant UUIDs are random 128-bit values — not enumerable
- GitHub URLs are validated against `github.com` pattern (no SSRF)
- ZIP files are capped at 30MB and path-traversal protected
- AI evaluation separates system instructions from untrusted source code

---

## 👥 Team

Developed for **ASTHRA 2K26 Coding Event** — St. Joseph's College of Engineering & Technology.
