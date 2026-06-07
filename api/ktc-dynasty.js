// Live KeepTradeCut dynasty values for ALL players (not just rookies), so the
// Live Draft workspace can value an entire roster instead of just counting
// players. Cached aggressively because dynasty values move slowly.

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

function normalizeName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[’‘ʼ]/g, "'")
    .replace(/[.,'`]/g, "")
    .replace(/\s+jr\b|\s+sr\b|\s+ii\b|\s+iii\b|\s+iv\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

let cache = null;
let cacheAt = 0;
const TTL_MS = 60 * 60 * 1000;  // 1 hour

export default async function handler(req, res) {
  if (cache && Date.now() - cacheAt < TTL_MS) {
    res.setHeader("Cache-Control", "s-maxage=3600");
    res.json(cache);
    return;
  }
  try {
    const r = await fetch("https://keeptradecut.com/dynasty-rankings", {
      headers: { "User-Agent": "Mozilla/5.0 draft-picks-bot" },
    });
    if (!r.ok) {
      res.status(r.status).json({ error: "KTC HTTP " + r.status });
      return;
    }
    const html = await r.text();
    const arrJson = extractPlayersArrayJson(html);
    if (!arrJson) {
      res.status(500).json({ error: "no playersArray" });
      return;
    }
    const players = JSON.parse(arrJson);
    const byName = {};
    const picks = {};
    // Pick names look like "2026 Early 1st" / "2026 Mid 2nd" etc.
    function parsePickName(name) {
      const m = (name || "").trim().match(/^(\d{4})\s+(Early|Mid|Late)\s+(\d+)(st|nd|rd|th)$/i);
      if (!m) return null;
      return { season: m[1], tier: m[2].toLowerCase(), round: parseInt(m[3], 10) };
    }
    for (const p of players) {
      if (!p.playerName) continue;
      const sf = p.superflexValues || {};
      const val = sf.value || 0;
      if (p.position === "RDP" || p.position === "PICK") {
        const parsed = parsePickName(p.playerName);
        if (parsed) picks[`${parsed.season}|${parsed.tier}|${parsed.round}`] = val;
        continue;
      }
      byName[normalizeName(p.playerName)] = {
        name: p.playerName,
        position: p.position,
        team: p.team || null,
        value: val,
        rank: sf.rank,
        positionRank: sf.positionalRank,
      };
    }
    cache = { players: byName, picks, updated: Date.now() };
    cacheAt = Date.now();
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.json(cache);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
