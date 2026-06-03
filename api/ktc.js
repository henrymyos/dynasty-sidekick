// Historical KeepTradeCut rookie ADP, scraped from Wayback Machine snapshots
// taken shortly after each year's NFL draft so the relevant rookie class is
// already in the data.
//
// Each season returns a map of normalized player name -> { rank, value, position }.
// The frontend joins this against Sleeper rookie draft picks to compute
// "how far ahead/behind ADP" each pick was.

const SEASON_SNAPSHOTS = {
  // season: wayback timestamp (YYYYMMDDhhmmss)
  "2020": "20210101000000",
  "2021": "20210724022232",
  "2022": "20220516093752",
  "2023": "20231001195348",
  "2024": "20240622170419",
  "2025": "20250510141825",
};

function normalizeName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/’|‘|ʼ/g, "'")
    .replace(/[.,'`]/g, "")
    .replace(/\s+jr\b|\s+sr\b|\s+ii\b|\s+iii\b|\s+iv\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const memCache = {}; // season -> parsed snapshot

async function fetchSnapshot(season, timestamp) {
  if (memCache[season]) return memCache[season];

  const url = `https://web.archive.org/web/${timestamp}/https://keeptradecut.com/dynasty-rankings`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 draft-picks-bot" },
  });
  if (!r.ok) throw new Error(`Wayback ${season}: HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/playersArray\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error(`Wayback ${season}: no playersArray`);

  let players;
  try {
    players = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`Wayback ${season}: JSON parse failed`);
  }

  // Index by normalized name; keep only player entries (skip RDP pick assets)
  const byName = {};
  for (const p of players) {
    if (!p.playerName || p.position === "RDP" || p.position === "PICK") continue;
    const one = p.oneQBValues || {};
    if (one.rank == null) continue;
    byName[normalizeName(p.playerName)] = {
      name: p.playerName,
      position: p.position,
      rank: one.rank,
      positionRank: one.positionalRank,
      value: one.value,
      rookie: !!p.rookie,
    };
  }
  memCache[season] = { snapshot: timestamp, players: byName };
  return memCache[season];
}

export default async function handler(req, res) {
  try {
    const seasons = await Promise.all(
      Object.entries(SEASON_SNAPSHOTS).map(async ([season, ts]) => {
        try {
          const data = await fetchSnapshot(season, ts);
          return [season, data];
        } catch (e) {
          return [season, { error: e.message, snapshot: ts, players: {} }];
        }
      })
    );
    const out = {};
    for (const [season, data] of seasons) out[season] = data;
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    res.json({ seasons: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
