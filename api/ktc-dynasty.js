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

// Cached per value scale: format "sf" (superflex, the default) or "1qb",
// optionally with a TE-premium tier ("tep" +0.5 / "tepp" +1.0 / "teppp" +1.5
// per TE reception) — KTC nests those values inside each format's object.
const caches = {};  // format|tep → { data, at }
const TTL_MS = 60 * 60 * 1000;  // 1 hour
const TEP_LEVELS = new Set(["tep", "tepp", "teppp"]);

export default async function handler(req, res) {
  const format = req.query && req.query.format === "1qb" ? "1qb" : "sf";
  const tep = req.query && TEP_LEVELS.has(req.query.tep) ? req.query.tep : "";
  const cacheKey = format + "|" + tep;
  const hit = caches[cacheKey];
  if (hit && Date.now() - hit.at < TTL_MS) {
    res.setHeader("Cache-Control", "s-maxage=3600");
    res.json(hit.data);
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
      const base = (format === "1qb" ? p.oneQBValues : p.superflexValues) || {};
      // TE-premium leagues read the nested tep/tepp/teppp object; entries
      // without one (some pick assets) fall back to the base values.
      const sf = (tep && base[tep] && base[tep].value != null) ? base[tep] : base;
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
        age: typeof p.age === "number" ? Math.floor(p.age) : null,
        rookie: !!p.rookie,
      };
    }
    const data = { players: byName, picks, format, tep: tep || null, updated: Date.now() };
    caches[cacheKey] = { data, at: Date.now() };
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
