'use strict';

/**
 * ASTHRA 11.0 — Test Team Seeder
 * ================================
 * Inserts 6 realistic test teams (4 participants each) directly into
 * Supabase so the full app flow can be tested end-to-end:
 *   registration → shuffle → task assignment → submission → scoring
 *
 * USAGE:
 *   node seed_test_teams.js              ← inserts teams
 *   node seed_test_teams.js --clear      ← wipes all teams + participants first
 *   node seed_test_teams.js --list       ← shows current teams in DB
 *
 * SAFE: skips any team whose name already exists (idempotent).
 * Run from the backend/ directory.
 */

require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

if (!process.env.SUPABASE_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
}
if (!process.env.SUPABASE_KEY && process.env.SUPABASE_ANON_KEY) {
  process.env.SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
}

const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('❌  SUPABASE_URL and SUPABASE_KEY must be set in backend/.env');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Team definitions ─────────────────────────────────────────────────────────
// 6 teams × 4 members = 24 participants
// Matches the shuffle engine's requirement: needs multiples of 4 for 6 groups.

const TEST_TEAMS = [
  {
    team_name: 'Team Alpha',
    members: ['Arjun Sharma', 'Priya Nair', 'Rohan Menon', 'Sneha Pillai'],
  },
  {
    team_name: 'Team Beta',
    members: ['Karthik Rajan', 'Divya Krishnan', 'Aditya Verma', 'Meera Iyer'],
  },
  {
    team_name: 'Team Gamma',
    members: ['Vikram Patel', 'Ananya Reddy', 'Suresh Kumar', 'Lakshmi Bose'],
  },
  {
    team_name: 'Team Delta',
    members: ['Rahul Nambiar', 'Kavya Suresh', 'Nikhil Joshi', 'Pooja Tiwari'],
  },
  {
    team_name: 'Team Epsilon',
    members: ['Siddharth Rao', 'Harini Venkat', 'Ajay Pillai', 'Deepika Menon'],
  },
  {
    team_name: 'Team Zeta',
    members: ['Abhishek Das', 'Roshni Nair', 'Pranav Gupta', 'Ishita Sharma'],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateTeamCode(teamName) {
  const prefix = String(teamName || '').trim().slice(0, 3).toUpperCase();
  const rand   = String(Math.floor(1000 + Math.random() * 9000));
  return `${prefix}${rand}`;
}

function pad(str, len) {
  return String(str).padEnd(len, ' ');
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function listTeams() {
  const { data: teams, error: tErr } = await supabase
    .from('teams')
    .select('*')
    .order('id');

  if (tErr) { console.error('❌  Could not fetch teams:', tErr.message); return; }
  if (!teams || teams.length === 0) { console.log('ℹ️   No teams in the database.'); return; }

  const { data: participants } = await supabase
    .from('participants')
    .select('*')
    .order('id');

  const byTeam = {};
  (participants || []).forEach(p => {
    if (!byTeam[p.team_id]) byTeam[p.team_id] = [];
    byTeam[p.team_id].push(p.participant_name);
  });

  console.log('\n── Current Teams ──────────────────────────────────────────');
  console.log(pad('ID', 5) + pad('Team Name', 20) + pad('Code', 10) + 'Members');
  console.log('─'.repeat(80));
  teams.forEach(t => {
    const members = (byTeam[t.id] || []).join(', ');
    console.log(pad(t.id, 5) + pad(t.team_name, 20) + pad(t.team_code, 10) + members);
  });
  console.log(`\nTotal: ${teams.length} teams, ${(participants || []).length} participants\n`);
}

async function clearTeams() {
  console.log('🗑️   Clearing all teams and participants...');

  const { error: aErr } = await supabase
    .from('main_event_assignments')
    .delete()
    .not('id', 'is', null);
  if (aErr) console.warn('   ⚠️  assignments:', aErr.message);

  const { error: pErr } = await supabase
    .from('participants')
    .delete()
    .not('id', 'is', null);
  if (pErr) { console.error('❌  participants:', pErr.message); return false; }

  const { error: tErr } = await supabase
    .from('teams')
    .delete()
    .not('id', 'is', null);
  if (tErr) { console.error('❌  teams:', tErr.message); return false; }

  // Reset shuffle lock so coordinator can shuffle the fresh teams
  await supabase
    .from('shuffle_lock')
    .update({ is_locked: false, locked_at: null, locked_by: null })
    .eq('id', 1);

  console.log('   ✅  Cleared.\n');
  return true;
}

async function seedTeams() {
  console.log('\n── Seeding Test Teams ─────────────────────────────────────\n');

  let inserted = 0;
  let skipped  = 0;

  for (const team of TEST_TEAMS) {
    // Skip if team name already exists
    const { data: existing } = await supabase
      .from('teams')
      .select('id')
      .ilike('team_name', team.team_name)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`   ⏭️   Skipped  "${team.team_name}" (already exists)`);
      skipped++;
      continue;
    }

    const teamCode = generateTeamCode(team.team_name);

    const { data: teamData, error: tErr } = await supabase
      .from('teams')
      .insert([{ team_name: team.team_name, team_code: teamCode }])
      .select();

    if (tErr) {
      console.error(`   ❌  Failed "${team.team_name}": ${tErr.message}`);
      continue;
    }

    const teamId = teamData?.[0]?.id;
    if (!teamId) {
      console.error(`   ❌  No ID returned for "${team.team_name}"`);
      continue;
    }

    const { error: pErr } = await supabase
      .from('participants')
      .insert(team.members.map(name => ({ team_id: teamId, participant_name: name })));

    if (pErr) {
      // Roll back
      await supabase.from('teams').delete().eq('id', teamId);
      console.error(`   ❌  Participants failed for "${team.team_name}": ${pErr.message}`);
      continue;
    }

    console.log(`   ✅  Inserted "${team.team_name}" [${teamCode}]`);
    console.log(`         Members: ${team.members.join(', ')}`);
    inserted++;
  }

  console.log(`\n── Done ────────────────────────────────────────────────────`);
  console.log(`   Inserted : ${inserted} team(s)`);
  console.log(`   Skipped  : ${skipped} team(s) (already existed)`);
  console.log(`   Total    : ${inserted + skipped} / ${TEST_TEAMS.length} teams\n`);

  if (inserted > 0) {
    console.log('Next steps:');
    console.log('  1. Open http://localhost:3000/admindashboard.html');
    console.log('  2. Go to Participants tab — you should see all teams');
    console.log('  3. Click "Run Shuffle" to assign groups and tasks');
    console.log('  4. Participants can now log in with their team_code\n');
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    await listTeams();
    return;
  }

  if (args.includes('--clear')) {
    const ok = await clearTeams();
    if (!ok) process.exit(1);
  }

  await seedTeams();

  if (!args.includes('--clear')) {
    await listTeams();
  }
}

main().catch(err => {
  console.error('❌  Unexpected error:', err.message);
  process.exit(1);
});
