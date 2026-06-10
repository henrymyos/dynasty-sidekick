// Weekly Sleeper projections + current NFL week + league scoring settings,
// bundled for the Lineup and Waivers views. Frontend scores each projection
// using your league's scoring_settings (same math as /api/player-stats used).

const LEAGUE_ID = "1312076332460425216";
const SLEEPER_V1 = "https://api.sleeper.app/v1";
const SLEEPER_V2 = "https://api.sleeper.com";

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  try {
    const [stateNfl, league] = await Promise.all([
      get(`${SLEEPER_V1}/state/nfl`),
      get(`${SLEEPER_V1}/league/${LEAGUE_ID}`),
    ]);
    // "display_week" is what Sleeper shows in the UI even pre-season; safer
    // than `week` which can be 0 during off-season.
    const week = stateNfl.display_week || stateNfl.week || 1;
    const season = league.season;
    const url = `${SLEEPER_V2}/projections/nfl/${season}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&order_by=ppr`;
    const projRaw = await get(url);
    // Slim the response: one row per player with the raw stats Sleeper used.
    const projections = {};
    for (const entry of projRaw) {
      if (!entry.player_id || !entry.stats) continue;
      projections[entry.player_id] = {
        stats: entry.stats,
        opponent: entry.opponent || null,
        injury_status: entry.player && entry.player.injury_status,
        team: entry.player && entry.player.team,
      };
    }
    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
    res.json({
      week,
      season,
      season_type: stateNfl.season_type,
      league: {
        league_id: LEAGUE_ID,
        roster_positions: league.roster_positions || [],
        scoring_settings: league.scoring_settings || {},
      },
      projections,
      updated: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
