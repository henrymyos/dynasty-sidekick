// Lightweight live snapshot of the current rookie draft for the Live Draft
// workspace. Polled every ~15s. Cached at the CDN for 10s so heavy polling
// doesn't slam Sleeper.

const DEFAULT_LEAGUE_ID = "1312076332460425216";
const SLEEPER = "https://api.sleeper.app/v1";

function resolveLeagueId(req) {
  const q = req.query && req.query.league_id;
  return typeof q === "string" && /^\d{10,20}$/.test(q) ? q : DEFAULT_LEAGUE_ID;
}

async function get(p) {
  const r = await fetch(`${SLEEPER}${p}`);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
}

let playersCache = null;
let playersCacheAt = 0;
const PLAYERS_TTL = 6 * 60 * 60 * 1000;

async function getPlayers() {
  if (playersCache && Date.now() - playersCacheAt < PLAYERS_TTL) return playersCache;
  playersCache = await get("/players/nfl");
  playersCacheAt = Date.now();
  return playersCache;
}

export default async function handler(req, res) {
  try {
    const leagueId = resolveLeagueId(req);
    const drafts = await get(`/league/${leagueId}/drafts`);
    // A league can hold more than one draft in a season (e.g. a rookie draft
    // plus a later supplemental one), so pick by what's actually happening
    // now: in-progress first, then upcoming, then the most recent finished
    // one. Prefer the 3-round rookie shape (this league's convention) but fall
    // back to drafts of any shape so other leagues still get a board.
    const statusRank = d =>
      d.status === "drafting" || d.status === "paused" ? 0
      : d.status === "pre_draft" ? 1
      : 2;
    const mostRelevant = list => list.slice().sort((a, b) =>
      statusRank(a) - statusRank(b) || (b.created || 0) - (a.created || 0)
    )[0];
    const rookieDraft =
      mostRelevant(drafts.filter(d => d.settings && d.settings.rounds === 3))
      || mostRelevant(drafts);
    if (!rookieDraft) {
      res.status(500).json({ error: "no rookie draft found" });
      return;
    }

    const [draftFull, picks, users, rosters, tradedPicks, playersDb] = await Promise.all([
      get(`/draft/${rookieDraft.draft_id}`),
      get(`/draft/${rookieDraft.draft_id}/picks`).catch(() => []),
      get(`/league/${leagueId}/users`),
      get(`/league/${leagueId}/rosters`),
      get(`/league/${leagueId}/traded_picks`).catch(() => []),
      getPlayers(),
    ]);

    const playerIds = new Set();
    picks.forEach(p => p.player_id && playerIds.add(p.player_id));
    rosters.forEach(r => (r.players || []).forEach(pid => playerIds.add(pid)));
    const playersOut = {};
    playerIds.forEach(id => {
      const p = playersDb[id];
      if (p) playersOut[id] = {
        name: `${p.first_name || ""} ${p.last_name || ""}`.trim() || id,
        position: p.position || null,
        team: p.team || null,
        years_exp: p.years_exp,
        rookie: p.years_exp === 0,
      };
    });

    const ownedIds = new Set();
    rosters.forEach(r => (r.players || []).forEach(pid => ownedIds.add(pid)));

    // Also expose rookies of the upcoming class so we can match them against KTC
    const allRookies = [];
    for (const id in playersDb) {
      const p = playersDb[id];
      if (!p) continue;
      if (p.years_exp !== 0) continue;            // years_exp 0 = current rookie class
      if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
      allRookies.push({
        player_id: id,
        name: `${p.first_name || ""} ${p.last_name || ""}`.trim(),
        position: p.position,
        team: p.team || null,
      });
    }

    // Non-rookies are draftable too (the supplemental draft runs off the same
    // board), so ship the unrostered veterans the client can value against KTC.
    // Limited to players active on an NFL roster — the rest is noise.
    const freeAgents = [];
    for (const id in playersDb) {
      const p = playersDb[id];
      if (!p || p.years_exp === 0) continue;
      if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
      if (!p.team || p.status !== "Active") continue;
      if (ownedIds.has(id)) continue;
      freeAgents.push({
        player_id: id,
        name: `${p.first_name || ""} ${p.last_name || ""}`.trim(),
        position: p.position,
        team: p.team,
        years_exp: p.years_exp,
      });
    }

    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
    res.json({
      draft: {
        draft_id: rookieDraft.draft_id,
        status: rookieDraft.status,
        season: rookieDraft.season,
        rounds: (rookieDraft.settings && rookieDraft.settings.rounds) || 3,
        slot_to_roster_id: draftFull.slot_to_roster_id || {},
        type: rookieDraft.type,
        start_time: rookieDraft.start_time,
        last_picked: rookieDraft.last_picked,
      },
      picks: picks.map(p => ({
        pick_no: p.pick_no,
        round: p.round,
        draft_slot: p.draft_slot,
        player_id: p.player_id,
        roster_id: p.roster_id,
        picked_by: p.picked_by,
      })),
      users: users.map(u => ({
        user_id: u.user_id,
        display_name: u.display_name,
        team_name: u.metadata && u.metadata.team_name,
      })),
      rosters: rosters.map(r => ({
        roster_id: r.roster_id,
        owner_id: r.owner_id,
        players: r.players || [],
      })),
      // Picks traded but not yet drafted, for the current draft's season only.
      // Each entry maps original slot owner (roster_id) → current owner (owner_id).
      traded_picks: tradedPicks
        .filter(t => t.season === rookieDraft.season)
        .map(t => ({
          season: t.season,
          round: t.round,
          roster_id: t.roster_id,
          previous_owner_id: t.previous_owner_id,
          owner_id: t.owner_id,
        })),
      players: playersOut,
      rookies: allRookies,
      free_agents: freeAgents,
      updated: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
