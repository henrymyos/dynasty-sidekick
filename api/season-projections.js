// Per-week projected fantasy points for every rostered player, across the
// regular season. Used by the Playoff Odds simulation to project each team's
// optimal-lineup points each week (which also naturally handles bye weeks —
// a player on bye has no projection that week, so the lineup fills around it).
const DEFAULT_LEAGUE_ID = "1312076332460425216";
const V1 = "https://api.sleeper.app/v1";
const V2 = "https://api.sleeper.com";

function resolveLeagueId(req) {
  const q = req.query && req.query.league_id;
  return typeof q === "string" && /^\d{10,20}$/.test(q) ? q : DEFAULT_LEAGUE_ID;
}

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

// Same math as the frontend scoreProjection: sum stat * scoring weight.
function scoreStats(stats, scoring) {
  if (!stats || !scoring) return 0;
  let pts = 0;
  for (const k in scoring) {
    const v = stats[k];
    if (v) pts += v * scoring[k];
  }
  return pts;
}

export default async function handler(req, res) {
  try {
    const LEAGUE_ID = resolveLeagueId(req);
    const [stateNfl, league, rosters] = await Promise.all([
      get(`${V1}/state/nfl`),
      get(`${V1}/league/${LEAGUE_ID}`),
      get(`${V1}/league/${LEAGUE_ID}/rosters`),
    ]);
    const season = league.season;
    const pws = (league.settings && league.settings.playoff_week_start) || 15;
    const scoring = league.scoring_settings || {};
    const currentWeek = stateNfl.display_week || stateNfl.week || 1;

    const rostered = new Set();
    rosters.forEach(r => (r.players || []).forEach(pid => rostered.add(pid)));

    const weeks = [];
    for (let w = 1; w < pws; w++) weeks.push(w);

    const pos = "&position[]=QB&position[]=RB&position[]=WR&position[]=TE";
    const perWeek = await Promise.all(weeks.map(async w => {
      try {
        const arr = await get(`${V2}/projections/nfl/${season}/${w}?season_type=regular${pos}&order_by=ppr`);
        const m = {};
        for (const e of arr) {
          if (!e.player_id || !rostered.has(e.player_id) || !e.stats) continue;
          const p = scoreStats(e.stats, scoring);
          if (p) m[e.player_id] = Math.round(p * 10) / 10;
        }
        return [w, m];
      } catch (e) {
        return [w, {}];
      }
    }));

    const pointsByWeek = {};
    perWeek.forEach(([w, m]) => { pointsByWeek[w] = m; });

    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    res.json({ season, playoff_week_start: pws, current_week: currentWeek, weeks, pointsByWeek });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
