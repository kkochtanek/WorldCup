// Fetches live NFL standings and the full regular-season schedule from
// ESPN's public, unauthenticated site API and upserts them into Supabase +
// nfl/matches.json. Runs in GitHub Actions on a schedule (see
// .github/workflows/nfl-sync-scores.yml). No API key required.
//
// Env:
//   ESPN_STANDINGS_FIXTURE  - optional path to a local standings JSON (testing)
//   ESPN_WEEK_FIXTURE_DIR   - optional dir of week-N.json scoreboard fixtures (testing)
//   NFL_SEASON_YEAR         - optional override for the season year
//   DRY_RUN                 - optional, print the upserts instead of writing

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SUPABASE_URL = 'https://kqwitbmocklwsmjcuxoy.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtxd2l0Ym1vY2tsd3NtamN1eG95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NjIxNzUsImV4cCI6MjA5NjUzODE3NX0.0CSZvNAy_Av4D4Kl0apgHCiEj2ecW-K1AXtYQUFSJRI';

// The 32 team codes used by the app (TEAMS array in index.html) — these
// match ESPN's own abbreviations exactly, so no alias table is needed.
const VALID_IDS = new Set([
  'ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB',
  'HOU','IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG',
  'NYJ','PHI','PIT','SEA','SF','TB','TEN','WSH',
]);

const PTS = { win: 1, tie: 0.5 };

async function espnGet(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    console.error(`ESPN ${url} responded ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

// Walk an arbitrarily-nested standings payload looking for entries shaped
// like { team: {abbreviation}, stats: [{name,value}, ...] }. ESPN's
// standings response nests entries under conference/division groups whose
// exact depth has shifted over the years, so we search for the shape
// instead of hard-coding a path.
function collectStandingsEntries(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => collectStandingsEntries(n, out)); return out; }
  if (node.team && Array.isArray(node.stats)) out.push(node);
  Object.values(node).forEach(v => collectStandingsEntries(v, out));
  return out;
}

async function fetchStandings() {
  if (process.env.ESPN_STANDINGS_FIXTURE) {
    return JSON.parse(readFileSync(process.env.ESPN_STANDINGS_FIXTURE, 'utf8'));
  }
  return espnGet('https://site.api.espn.com/apis/site/v2/sports/football/nfl/standings');
}

function seasonYear() {
  if (process.env.NFL_SEASON_YEAR) return Number(process.env.NFL_SEASON_YEAR);
  const now = new Date();
  // NFL seasons are named for the year they kick off in (Sept); before
  // roughly March it's still the previous season's playoffs.
  return now.getUTCMonth() + 1 >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

async function fetchWeek(year, week) {
  const fixtureDir = process.env.ESPN_WEEK_FIXTURE_DIR;
  if (fixtureDir) {
    const p = `${fixtureDir}/week-${week}.json`;
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  }
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&year=${year}&week=${week}`;
  try {
    return await espnGet(url);
  } catch (e) {
    console.error(`week ${week} fetch failed: ${e.message || e}`);
    return null;
  }
}

// ── Standings → nfl_team_scores ─────────────────────────────────────────────
const standingsData = await fetchStandings();
const entries = collectStandingsEntries(standingsData);
const upserts = [];
const unmatched = [];
for (const entry of entries) {
  const id = (entry.team.abbreviation || '').toUpperCase();
  if (!VALID_IDS.has(id)) { unmatched.push(entry.team.displayName || entry.team.abbreviation || '?'); continue; }
  const stat = (name) => entry.stats.find(s => s.name === name)?.value ?? 0;
  const wins = stat('wins'), losses = stat('losses'), ties = stat('ties');
  upserts.push({
    team_id: id,
    wins, losses, ties,
    points: wins * PTS.win + ties * PTS.tie,
    updated_at: new Date().toISOString(),
  });
}
console.log(`Parsed ${upserts.length} teams` + (unmatched.length ? `; unmatched: ${unmatched.join(', ')}` : ''));

// ── Full regular-season schedule (weeks 1-18) → nfl/matches.json ──────────
const year = seasonYear();
const compact = [];
for (let week = 1; week <= 18; week++) {
  const wk = await fetchWeek(year, week);
  const events = wk?.events || [];
  for (const ev of events) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    if (!home || !away) continue;
    const state = comp.status?.type?.state; // 'pre' | 'in' | 'post'
    const status = state === 'in' ? 'IN_PLAY' : state === 'post' ? 'FINISHED' : 'SCHEDULED';
    compact.push({
      d: comp.date || ev.date,
      s: status,
      w: week,
      h: (home.team?.abbreviation || '').toUpperCase(),
      a: (away.team?.abbreviation || '').toUpperCase(),
      hs: home.score != null ? Number(home.score) : null,
      as: away.score != null ? Number(away.score) : null,
    });
  }
}
writeFileSync(new URL('../matches.json', import.meta.url), JSON.stringify({ updated: new Date().toISOString(), matches: compact }) + '\n');
console.log(`Wrote nfl/matches.json with ${compact.length} matches across ${year} weeks 1-18.`);

if (upserts.length === 0) { console.log('No standings to write.'); process.exit(0); }

if (process.env.DRY_RUN) {
  console.log(JSON.stringify(upserts, null, 2));
  process.exit(0);
}

const res = await fetch(`${SUPABASE_URL}/rest/v1/nfl_team_scores`, {
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
