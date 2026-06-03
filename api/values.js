// Proxy for FantasyCalc's free dynasty values API.
// Returns a slim map keyed by Sleeper player_id so the frontend can join
// trade values into Sleeper-derived data without re-pulling the full feed.

const FC_URL = "https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=1&numTeams=12&ppr=1";

export default async function handler(req, res) {
  try {
    const r = await fetch(FC_URL);
    if (!r.ok) {
      const text = await r.text();
      res.status(r.status).json({ error: "FantasyCalc " + r.status, detail: text.slice(0, 200) });
      return;
    }
    const arr = await r.json();
    const bySleeperId = {};
    for (const row of arr) {
      const sid = row.player && row.player.sleeperId;
      if (!sid) continue;
      bySleeperId[sid] = {
        name: row.player.name,
        position: row.player.position,
        team: row.player.maybeTeam || null,
        value: row.value,
        overallRank: row.overallRank,
        positionRank: row.positionRank,
        trend30: row.trend30Day,
        redraftValue: row.redraftValue,
      };
    }
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.json({ updated: Date.now(), players: bySleeperId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
