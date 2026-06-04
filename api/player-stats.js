// Fantasy point totals per player per season, used to grade rookie picks by
// how they've actually performed since being drafted (rather than by current
// dynasty value).

const SLEEPER = "https://api.sleeper.app/v1";
const SEASONS = ["2020", "2021", "2022", "2023", "2024", "2025"];

const memCache = {};

async function fetchSeason(season) {
  if (memCache[season]) return memCache[season];
  const r = await fetch(`${SLEEPER}/stats/nfl/regular/${season}`);
  if (!r.ok) throw new Error(`stats ${season}: HTTP ${r.status}`);
  const raw = await r.json();
  // Slim each entry: pts_ppr, pts_half_ppr, games, position rank.
  const slim = {};
  for (const pid in raw) {
    const s = raw[pid] || {};
    slim[pid] = {
      pts_ppr: s.pts_ppr || 0,
      pts_half_ppr: s.pts_half_ppr || 0,
      games: s.gms_active || 0,
      pos_rank_ppr: s.pos_rank_ppr || null,
      pos_rank_half_ppr: s.pos_rank_half_ppr || null,
    };
  }
  memCache[season] = slim;
  return slim;
}

export default async function handler(req, res) {
  try {
    const results = await Promise.all(
      SEASONS.map(async season => {
        try {
          const stats = await fetchSeason(season);
          return [season, stats];
        } catch (e) {
          return [season, { _error: e.message }];
        }
      })
    );
    const out = {};
    for (const [season, stats] of results) out[season] = stats;
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    res.json({ seasons: out, updated: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
