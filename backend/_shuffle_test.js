'use strict';

// Simulate 6 teams of 4
const teams = [1,2,3,4,5,6].map(i => ({ id: i, team_name: 'Team'+i }));
const participants = [];
let pid = 1;
teams.forEach(t => {
  for (let j = 1; j <= 4; j++) {
    participants.push({ id: pid++, team_id: t.id, participant_name: 'P'+pid });
  }
});
const byTeam = {};
participants.forEach(p => {
  if (!byTeam[p.team_id]) byTeam[p.team_id] = [];
  byTeam[p.team_id].push(p);
});

let failures = 0;
let unassigned = 0;
const RUNS = 2000;

for (let run = 0; run < RUNS; run++) {
  const teamIds = Object.keys(byTeam);
  const imposters = [];
  const specialistsByTeam = {};
  for (const teamId of teamIds) {
    const shuffled = [...byTeam[teamId]].sort(() => Math.random() - 0.5);
    imposters.push(shuffled[0]);
    specialistsByTeam[teamId] = shuffled.slice(1);
  }
  const shuffledImposters = [...imposters].sort(() => Math.random() - 0.5);
  const groups = Array.from({ length: 6 }, (_, i) => ({
    groupName: 'Group ' + (i + 1),
    imposter: shuffledImposters[i],
    specialists: []
  }));
  const allSpecialists = [];
  for (const tid of teamIds) allSpecialists.push(...specialistsByTeam[tid]);

  let assigned = false;
  for (let attempt = 0; attempt < 500 && !assigned; attempt++) {
    const working = groups.map(g => ({ groupName: g.groupName, imposter: g.imposter, specialists: [] }));
    const pool = [...allSpecialists].sort(() => Math.random() - 0.5);
    let valid = true;
    for (const spec of pool) {
      const eligible = working.filter(wg =>
        wg.specialists.length < 3 &&
        wg.imposter.team_id !== spec.team_id &&
        !wg.specialists.some(s => s.team_id === spec.team_id)
      );
      if (eligible.length === 0) { valid = false; break; }
      eligible[Math.floor(Math.random() * eligible.length)].specialists.push(spec);
    }
    if (valid && working.every(wg => wg.specialists.length === 3)) {
      assigned = true;
      working.forEach((wg, i) => { groups[i].specialists = wg.specialists; });
    }
  }

  if (!assigned) { unassigned++; continue; }

  // Verify all constraints
  for (const g of groups) {
    if (!g.imposter) { failures++; break; }
    if (g.specialists.length !== 3) { failures++; break; }
    const allTeamIds = [g.imposter.team_id, ...g.specialists.map(s => s.team_id)];
    if (new Set(allTeamIds).size !== 4) { failures++; break; }
    if (g.specialists.some(s => s.team_id === g.imposter.team_id)) { failures++; break; }
  }

  // Verify: exactly 24 participants total, 6 groups, 1 imposter + 3 specialists each
  const allAssigned = groups.flatMap(g => [g.imposter, ...g.specialists]);
  if (allAssigned.length !== 24) { failures++; }
  const uniqueIds = new Set(allAssigned.map(p => p.id));
  if (uniqueIds.size !== 24) { failures++; } // duplicate detection
}

console.log('Shuffle test (' + RUNS + ' runs):');
console.log('  Unassigned (500 attempts exhausted):', unassigned);
console.log('  Constraint violations:', failures);
console.log('  Result:', (failures === 0 && unassigned === 0) ? 'ALL PASS' : 'FAILURES DETECTED');

// ── Task mapping ──────────────────────────────────────────────────────────────
console.log('\n=== TASK MAPPING TESTS ===');
function taskForGroup(groupName) {
  const n = parseInt((groupName.match(/\d+/) || ['1'])[0], 10);
  return ((n - 1) % 3) + 1;
}
const expected = { 'Group 1':1,'Group 2':2,'Group 3':3,'Group 4':1,'Group 5':2,'Group 6':3 };
let taskFail = 0;
for (const [g, t] of Object.entries(expected)) {
  const actual = taskForGroup(g);
  const ok = actual === t;
  console.log((ok?'PASS':'FAIL'), '| ' + g + ' -> Task ' + actual + ' (expected ' + t + ')');
  if (!ok) taskFail++;
}
console.log('Task mapping:', taskFail === 0 ? 'ALL PASS' : taskFail + ' FAILURES');
