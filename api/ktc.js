// KeepTradeCut superflex (2QB) rookie rankings, pulled from Wayback Machine
// snapshots of KTC's rookie-rankings page. Each snapshot is chosen to match
// — as closely as possible — when the user's fantasy rookie draft happened
// that year, so users can click the snapshot URL to verify the numbers.
//
// The frontend uses each rookie's `rookieRank` as ADP. Older snapshots
// (pre-2021) don't carry a rookieRank field, so we always re-derive it by
// sorting rookies on `superflexValues.value` desc — the same way KTC does.

// Snapshots aimed at each year's actual fantasy rookie draft date (per Sleeper
// last_picked timestamps). For 2023 no rookie-rankings page snapshot exists
// near the draft date, so we use the site root which embeds the same data.
const SEASON_SNAPSHOTS = {
  "2020": { ts: "20201126095831", original: "https://keeptradecut.com/dynasty-rankings/rookie-rankings" },
  "2021": { ts: "20210503211711", original: "https://keeptradecut.com/dynasty-rankings/rookie-rankings" },
  "2022": { ts: "20220628220026", original: "https://keeptradecut.com/dynasty-rankings/rookie-rankings" },
  // No KTC rookie-rankings snapshot exists in May/June 2023; Wayback redirects
  // to the closest one (Mar 16) regardless. Point both API and link at Mar 16
  // so the displayed numbers match what the verify-link shows. Caveat: this is
  // pre-NFL-draft data, where Will Levis was still a top-10 rookie consensus.
  "2023": { ts: "20230316174702", original: "https://keeptradecut.com/dynasty-rankings/rookie-rankings" },
  "2024": { ts: "20240609032233", original: "https://keeptradecut.com/dynasty-rankings/rookie-rankings" },
  "2025": { ts: "20250615024724", original: "https://keeptradecut.com/dynasty-rankings/rookie-rankings" },
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

async function fetchWithRetry(url, attempts = 3) {
  let lastStatus = 0;
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 draft-picks-bot" },
    });
    if (r.ok) return r;
    lastStatus = r.status;
    if (r.status !== 429 && r.status !== 503) throw new Error("HTTP " + r.status);
    await new Promise(res => setTimeout(res, 800 * (i + 1)));
  }
  throw new Error("HTTP " + lastStatus + " after retries");
}

async function fetchSnapshot(season, ts, original) {
  if (memCache[season]) return memCache[season];

  const url = `https://web.archive.org/web/${ts}/${original}`;
  const r = await fetchWithRetry(url);
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
  // Filter to rookies only — the rookie-rankings page is already filtered
  // but the dynasty-rankings / root snapshot includes vets too.
  const rookies = players
    .filter(p => p.playerName && p.position !== "RDP" && p.position !== "PICK" && p.rookie)
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
