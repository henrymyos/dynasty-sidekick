// KeepTradeCut superflex (2QB) rookie rankings, pulled from Wayback Machine
// snapshots of KTC's rookie-rankings page. Each snapshot is chosen to match
// — as closely as possible — when the user's fantasy rookie draft happened
// that year, so users can click the snapshot URL to verify the numbers.
//
// The frontend uses each rookie's `rookieRank` as ADP. Older snapshots
// (pre-2021) don't carry a rookieRank field, so we always re-derive it by
// sorting rookies on `superflexValues.value` desc — the same way KTC does.

const SEASON_SNAPSHOTS = {
  "2020": { ts: "20201126095831", original: "https://keeptradecut.com/dynasty-rankings/rookie-rankings" },
  "2021": { ts: "20210503211711", original: "https://keeptradecut.com/dynasty-rankings/rookie-rankings" },
  "2022": { ts: "20220628220026", original: "https://keeptradecut.com/dynasty-rankings/rookie-rankings" },
  "2023": { ts: "20230316174702", original: "https://keeptradecut.com/dynasty-rankings/rookie-rankings" },
  "2024": { ts: "20240429230806", original: "https://keeptradecut.com/dynasty-rankings/rookie-rankings" },
  "2025": { ts: "20250524035708", original: "https://keeptradecut.com/dynasty-rankings/rookie-rankings" },
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

  // Re-derive rookieRank from superflex value desc so older years (no
  // rookieRank field) still work and we exactly match KTC's ordering.
  const rookies = players
    .filter(p => p.playerName && p.position !== "RDP" && p.position !== "PICK")
    .map(p => ({ p, value: (p.superflexValues || {}).value || 0 }))
    .sort((a, b) => b.value - a.value);

  const byName = {};
  rookies.forEach(({ p }, idx) => {
    const sf = p.superflexValues || {};
    byName[normalizeName(p.playerName)] = {
      name: p.playerName,
      position: p.position,
      rookieRank: idx + 1,
      value: sf.value,
    };
  });

  memCache[season] = {
    snapshot: ts,
    pageUrl: `https://web.archive.org/web/${ts}/${original}`,
    players: byName,
  };
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
