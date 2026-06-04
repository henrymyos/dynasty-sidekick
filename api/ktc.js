// Historical KeepTradeCut rookie ADP, scraped from Wayback Machine snapshots
// taken close to each year's NFL Draft so the relevant rookie class is in
// the data. For 2020 the earliest Wayback snapshot with usable data is
// Nov 1, 2020 (still ~5 months after the league's May draft).
//
// Each season returns a map of normalized player name -> { rank, value, position }.

const SEASON_SNAPSHOTS = {
  "2020": { ts: "20201101092924", original: "https://www.keeptradecut.com/" },
  "2021": { ts: "20210724022232", original: "https://keeptradecut.com/dynasty-rankings" },
  "2022": { ts: "20220516093752", original: "https://keeptradecut.com/dynasty-rankings" },
  "2023": { ts: "20230501073945", original: "https://keeptradecut.com/" },
  "2024": { ts: "20240622170419", original: "https://keeptradecut.com/dynasty-rankings" },
  "2025": { ts: "20250510141825", original: "https://keeptradecut.com/dynasty-rankings" },
};

function normalizeName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[’‘ʼ]/g, "'")
    .replace(/[.,'`]/g, "")
    .replace(/\s+jr\b|\s+sr\b|\s+ii\b|\s+iii\b|\s+iv\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Some snapshots have inner regex/string contents that defeat a non-greedy
// .*? match for playersArray. Walk character-by-character with bracket and
// quote tracking instead.
function extractPlayersArrayJson(html) {
  let start = html.indexOf("playersArray");
  if (start < 0) return null;
  start = html.indexOf("[", start);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false, i = start;
  while (i < html.length) {
    const c = html[i];
    if (esc) {
      esc = false;
    } else if (inStr) {
      if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    i++;
  }
  if (depth !== 0) return null;
  return html.slice(start, i);
}

const memCache = {};

async function fetchSnapshot(season, ts, original) {
  if (memCache[season]) return memCache[season];

  const url = `https://web.archive.org/web/${ts}/${original}`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 draft-picks-bot" },
  });
  if (!r.ok) throw new Error(`Wayback ${season}: HTTP ${r.status}`);
  const html = await r.text();

  const arrJson = extractPlayersArrayJson(html);
  if (!arrJson) throw new Error(`Wayback ${season}: no playersArray`);

  let players;
  try {
    players = JSON.parse(arrJson);
  } catch (e) {
    throw new Error(`Wayback ${season}: JSON parse failed (${e.message})`);
  }

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
  memCache[season] = { snapshot: ts, players: byName };
  return memCache[season];
}

export default async function handler(req, res) {
  try {
    const seasons = await Promise.all(
      Object.entries(SEASON_SNAPSHOTS).map(async ([season, info]) => {
        try {
          const data = await fetchSnapshot(season, info.ts, info.original);
          return [season, data];
        } catch (e) {
          return [season, { error: e.message, snapshot: info.ts, players: {} }];
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
