// Live KeepTradeCut superflex rookie rankings, scraped from the current site
// (not Wayback). 1-minute in-memory cache so we don't hammer KTC.

function extractPlayersArrayJson(html) {
  // Current KTC pages ship the full array in a JSON script tag:
  //   <script id="ktc-players" type="application/json">[...]</script>
  // Older captures (and the Wayback ones) inline `var playersArray = [...]`.
  const tag = html.match(/<script[^>]*id="ktc-players"[^>]*>([\s\S]*?)<\/script>/);
  if (tag && tag[1].trim().startsWith("[")) return tag[1].trim();
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
const TTL_MS = 60 * 1000;

export default async function handler(req, res) {
  if (cache && Date.now() - cacheAt < TTL_MS) {
    res.setHeader("Cache-Control", "s-maxage=60");
    res.json(cache);
    return;
  }
  try {
    const r = await fetch("https://keeptradecut.com/dynasty-rankings/rookie-rankings", {
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
    const sorted = players
      .filter(p => p.playerName && p.position !== "RDP" && p.position !== "PICK")
      .map(p => {
        const sf = p.superflexValues || {};
        return {
          name: p.playerName,
          normName: normalizeName(p.playerName),
          position: p.position,
          team: p.team || null,
          value: sf.value || 0,
          rookieRank: sf.rookieRank,
        };
      })
      .sort((a, b) => b.value - a.value);
    sorted.forEach((p, i) => { if (!p.rookieRank) p.rookieRank = i + 1; });
    cache = { players: sorted, updated: Date.now() };
    cacheAt = Date.now();
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.json(cache);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
