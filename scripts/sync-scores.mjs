// Fetches live World Cup standings from football-data.org and upserts
// per-team W/D/L + group-stage points into the Supabase team_scores table.
// Runs in GitHub Actions on a schedule (see .github/workflows/sync-scores.yml).
//
// Env:
//   FOOTBALL_DATA_KEY  - required, free key from football-data.org
//   FD_FIXTURE         - optional path to a local standings JSON (testing)
//   DRY_RUN            - optional, print the upsert instead of writing

import { readFileSync, writeFileSync } from 'node:fs';

const SUPABASE_URL = 'https://kqwitbmocklwsmjcuxoy.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtxd2l0Ym1vY2tsd3NtamN1eG95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NjIxNzUsImV4cCI6MjA5NjUzODE3NX0.0CSZvNAy_Av4D4Kl0apgHCiEj2ecW-K1AXtYQUFSJRI';

// The 48 team codes used by the app (TEAMS array in index.html)
const VALID_IDS = new Set([
  'MEX','KOR','RSA','CZE','CAN','SUI','QAT','BIH','BRA','MAR','SCO','HAI',
  'USA','TUR','PAR','AUS','GER','ECU','CIV','CUW','NED','JPN','SWE','TUN',
  'BEL','IRN','EGY','NZL','ESP','URU','KSA','CPV','FRA','SEN','NOR','IRQ',
  'ARG','ALG','AUT','JOR','POR','COL','UZB','COD','ENG','CRO','GHA','PAN',
]);

// football-data.org names/TLAs that differ from ours
const ALIASES = {
  'czech republic':'CZE', 'czechia':'CZE',
  "cote d'ivoire":'CIV', 'ivory coast':'CIV',
  'turkey':'TUR', 'turkiye':'TUR',
  'korea republic':'KOR', 'south korea':'KOR',
  'ir iran':'IRN', 'iran':'IRN',
  'cape verde islands':'CPV', 'cape verde':'CPV',
  'dr congo':'COD', 'congo dr':'COD', 'democratic republic of the congo':'COD',
  'bosnia and herzegovina':'BIH', 'bosnia-herzegovina':'BIH',
  'saudi arabia':'KSA', 'south africa':'RSA',
  'united states':'USA', 'usa':'USA',
  'netherlands':'NED', 'switzerland':'SUI', 'croatia':'CRO', 'portugal':'POR',
  'germany':'GER', 'japan':'JPN', 'spain':'ESP', 'argentina':'ARG',
  'uruguay':'URU', 'paraguay':'PAR', 'algeria':'ALG', 'denmark':'DEN',
  'new zealand':'NZL', 'scotland':'SCO', 'england':'ENG', 'wales':'WAL',
};

const deburr = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function resolveTeamId(entryTeam) {
  const tla = (entryTeam.tla || '').toUpperCase();
  if (VALID_IDS.has(tla)) return tla;
  for (const cand of [entryTeam.name, entryTeam.shortName]) {
    if (!cand) continue;
    const key = deburr(cand);
    if (ALIASES[key] && VALID_IDS.has(ALIASES[key])) return ALIASES[key];
  }
  return null;
}

// Repo secret takes precedence if one is ever configured; otherwise use
// the league's committed key (free tier, no payment attached).
const FD_KEY = process.env.FOOTBALL_DATA_KEY || '2f27120af3bb4f278030fbed1ff6ac40';

async function fdGet(path) {
  const res = await fetch(`https://api.football-data.org/v4${path}`, {
    headers: { 'X-Auth-Token': FD_KEY },
  });
  if (!res.ok) {
    console.error(`football-data.org ${path} responded ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

async function fetchStandings() {
  if (process.env.FD_FIXTURE) {
    return JSON.parse(readFileSync(process.env.FD_FIXTURE, 'utf8'));
  }
  return fdGet('/competitions/2000/standings');
}

async function fetchMatches() {
  if (process.env.FD_MATCHES_FIXTURE) {
    return JSON.parse(readFileSync(process.env.FD_MATCHES_FIXTURE, 'utf8'));
  }
  return fdGet('/competitions/2000/matches');
}

const data = await fetchStandings();
const upserts = [];
const unmatched = [];
for (const standing of data.standings || []) {
  if (standing.type !== 'TOTAL') continue;
  for (const entry of standing.table || []) {
    const id = resolveTeamId(entry.team || {});
    if (!id) { unmatched.push(entry.team?.name || '?'); continue; }
    upserts.push({
      team_id: id,
      wins: entry.won || 0,
      draws: entry.draw || 0,
      losses: entry.lost || 0,
      stage: 'GROUP',
      points: (entry.won || 0) * 3 + (entry.draw || 0),
      updated_at: new Date().toISOString(),
    });
  }
}

console.log(`Parsed ${upserts.length} teams` + (unmatched.length ? `; unmatched: ${unmatched.join(', ')}` : ''));

// ── matches.json for the Schedule tab ──────────────────────────────────────
const matchData = await fetchMatches();
const compact = (matchData.matches || [])
  .filter(m => m.utcDate)
  .map(m => ({
    d: m.utcDate,
    s: m.status,
    st: m.stage || null,                       // GROUP_STAGE, LAST_32, LAST_16, … (for the Budget tab's KO scoring)
    h: resolveTeamId(m.homeTeam || {}) || (m.homeTeam?.tla || m.homeTeam?.name || '?'),
    a: resolveTeamId(m.awayTeam || {}) || (m.awayTeam?.tla || m.awayTeam?.name || '?'),
    hs: m.score?.fullTime?.home ?? null,
    as: m.score?.fullTime?.away ?? null,
    w: m.score?.winner === 'HOME_TEAM' ? 'H'    // actual winner incl. extra time / penalties
       : m.score?.winner === 'AWAY_TEAM' ? 'A' : null,
  }));
writeFileSync('matches.json', JSON.stringify({ updated: new Date().toISOString(), matches: compact }) + '\n');
console.log(`Wrote matches.json with ${compact.length} matches.`);

if (upserts.length === 0) { console.log('No standings to write.'); process.exit(0); }

if (process.env.DRY_RUN) {
  console.log(JSON.stringify(upserts, null, 2));
  process.exit(0);
}

const res = await fetch(`${SUPABASE_URL}/rest/v1/team_scores`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON,
    'Authorization': 'Bearer ' + SUPABASE_ANON,
    'Prefer': 'return=minimal,resolution=merge-duplicates',
  },
  body: JSON.stringify(upserts),
});
if (!res.ok) {
  console.error(`Supabase upsert failed ${res.status}: ${await res.text()}`);
  process.exit(1);
}
console.log(`Upserted ${upserts.length} team scores to Supabase.`);
