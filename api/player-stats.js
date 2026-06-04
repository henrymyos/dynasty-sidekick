// Fantasy point totals per player per season, used to grade rookie picks by
// how they've actually performed since being drafted (rather than by current
// dynasty value).

const SLEEPER = "https://api.sleeper.app/v1";
const LEAGUE_ID = "1312076332460425216";
const SEASONS = ["2020", "2021", "2022", "2023", "2024", "2025"];

const memCache = {};
let scoringCache = null;
let scoringCacheAt = 0;

async function getLeagueScoring() {
  if (scoringCache && Date.now() - scoringCacheAt < 6 * 60 * 60 * 1000) return scoringCache;
  const r = await fetch(`${SLEEPER}/league/${LEAGUE_ID}`);
  if (!r.ok) throw new Error(`league: HTTP ${r.status}`);
  const lg = await r.json();
  scoringCache = lg.scoring_settings || {};
  scoringCacheAt = Date.now();
  return scoringCache;
}

// Apply a scoring map to a raw stat object. Sum stat × multiplier for every
// scoring key that has a matching raw stat. Negative values are honored.
function scoreStats(rawStats, scoring) {
  let pts = 0;
  for (const k in scoring) {
    const mult = scoring[k];
    if (!mult) continue;
    const v = rawStats[k];
    if (v) pts += v * mult;
  }
  return pts;
}

async function fetchSeason(season, scoring) {
  const cacheKey = season + "::v2";
  if (memCache[cacheKey]) return memCache[cacheKey];
  const r = await fetch(`${SLEEPER}/stats/nfl/regular/${season}`);
  if (!r.ok) throw new Error(`stats ${season}: HTTP ${r.status}`);
  const raw = await r.json();
  const slim = {};
  for (const pid in raw) {
    const s = raw[pid] || {};
    const ptsLeague = scoreStats(s, scoring);
    slim[pid] = {
      pts_ppr: s.pts_ppr || 0,
      pts_half_ppr: s.pts_half_ppr || 0,
      pts_league: Math.round(ptsLeague * 100) / 100,
      games: s.gms_active || 0,
      pos_rank_ppr: s.pos_rank_ppr || null,
      pos_rank_half_ppr: s.pos_rank_half_ppr || null,
    };
  }
  memCache[cacheKey] = slim;
  return slim;
}

export default async function handler(req, res) {
  try {
    const scoring = await getLeagueScoring();
    const results = await Promise.all(
      SEASONS.map(async season => {
        try {
          const stats = await fetchSeason(season, scoring);
          return [season, stats];
        } catch (e) {
          return [season, { _error: e.message }];
        }
      })
    );
    const out = {};
    for (const [season, stats] of results) out[season] = stats;
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    res.json({
      seasons: out,
      scoring_keys: Object.keys(scoring).filter(k => scoring[k] !== 0).length,
      updated: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
