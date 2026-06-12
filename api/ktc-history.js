// Historical KeepTradeCut superflex values across multiple snapshots, used to
// evaluate each Sleeper trade at the time it was made. Each snapshot returns
// the parsed playersArray as a slim {name → value} map plus a {pick_key → value}
// map for RDP entries.

const SNAPSHOTS = [
  { ts: "20201101092924", url: "https://www.keeptradecut.com/", label: "2020-11-01" },
  // The 2021-04-22 dynasty-rankings capture has no playersArray; the May 14
  // homepage capture is the nearest spring-2021 snapshot that parses.
  { ts: "20210514172814", url: "https://keeptradecut.com/", label: "2021-05-14" },
  { ts: "20210724022232", url: "https://keeptradecut.com/dynasty-rankings", label: "2021-07-24" },
  { ts: "20220516093752", url: "https://keeptradecut.com/dynasty-rankings", label: "2022-05-16" },
  { ts: "20221114151715", url: "https://keeptradecut.com/dynasty-rankings", label: "2022-11-14" },
  { ts: "20230316174702", url: "https://keeptradecut.com/dynasty-rankings", label: "2023-03-16" },
  { ts: "20230611042610", url: "https://keeptradecut.com/", label: "2023-06-11" },
  { ts: "20231019003120", url: "https://keeptradecut.com/dynasty-rankings", label: "2023-10-19" },
  { ts: "20240110193417", url: "https://keeptradecut.com/dynasty-rankings", label: "2024-01-10" },
  { ts: "20240609032233", url: "https://keeptradecut.com/dynasty-rankings", label: "2024-06-09" },
  { ts: "20240917191615", url: "https://keeptradecut.com/dynasty-rankings", label: "2024-09-17" },
  { ts: "20250121023222", url: "https://keeptradecut.com/dynasty-rankings", label: "2025-01-21" },
  { ts: "20250510141825", url: "https://keeptradecut.com/dynasty-rankings", label: "2025-05-10" },
  { ts: "20250826015616", url: "https://keeptradecut.com/dynasty-rankings", label: "2025-08-26" },
];

function tsToMs(ts) {
  // YYYYMMDDhhmmss → ms
  const Y = parseInt(ts.slice(0, 4), 10);
  const M = parseInt(ts.slice(4, 6), 10) - 1;
  const D = parseInt(ts.slice(6, 8), 10);
  const h = parseInt(ts.slice(8, 10) || "0", 10);
  const m = parseInt(ts.slice(10, 12) || "0", 10);
  const s = parseInt(ts.slice(12, 14) || "0", 10);
  return Date.UTC(Y, M, D, h, m, s);
}

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
    if (esc) { esc = false; }
    else if (inStr) {
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

async function fetchWithRetry(url, attempts = 3) {
  let lastStatus = 0;
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 draft-picks-bot" } });
    if (r.ok) return r;
    lastStatus = r.status;
    if (r.status !== 429 && r.status !== 503) throw new Error("HTTP " + r.status);
    await new Promise(res => setTimeout(res, 1000 * (i + 1)));
  }
  throw new Error("HTTP " + lastStatus + " after retries");
}

// Parse a KTC pick name like "2024 Early 1st" or "2024 Mid 2nd" into a key
// {season, tier, round} we can look up later.
function parsePickName(name) {
  const m = (name || "").trim().match(/^(\d{4})\s+(Early|Mid|Late)\s+(\d+)(st|nd|rd|th)$/i);
  if (!m) return null;
  return {
    season: m[1],
    tier: m[2].toLowerCase(),
    round: parseInt(m[3], 10),
  };
}

const memCache = {};

async function fetchSnapshot(snap) {
  if (memCache[snap.ts]) return memCache[snap.ts];
  const url = `https://web.archive.org/web/${snap.ts}/${snap.url}`;
  const r = await fetchWithRetry(url);
  const html = await r.text();
  const arrJson = extractPlayersArrayJson(html);
  if (!arrJson) throw new Error("no playersArray");
  let arr;
  try { arr = JSON.parse(arrJson); }
  catch (e) { throw new Error("JSON parse failed: " + e.message); }

  const players = {};
  const picks = {};
  for (const p of arr) {
    if (!p.playerName) continue;
    const sf = p.superflexValues || {};
    const val = sf.value || 0;
    if (p.position === "RDP" || p.position === "PICK") {
      // Pick entries: key by {season, tier, round}
      const parsed = parsePickName(p.playerName);
      if (parsed) {
        picks[`${parsed.season}|${parsed.tier}|${parsed.round}`] = val;
      }
      continue;
    }
    players[normalizeName(p.playerName)] = val;
  }

  const out = {
    ts: snap.ts,
    label: snap.label,
    timestamp_ms: tsToMs(snap.ts),
    players,
    picks,
    n_players: Object.keys(players).length,
    n_picks: Object.keys(picks).length,
  };
  memCache[snap.ts] = out;
  return out;
}

export default async function handler(req, res) {
  try {
    const results = await Promise.all(
      SNAPSHOTS.map(async snap => {
        try { return await fetchSnapshot(snap); }
        catch (e) { return { ts: snap.ts, label: snap.label, timestamp_ms: tsToMs(snap.ts), players: {}, picks: {}, error: e.message }; }
      })
    );
    results.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    res.json({ snapshots: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
