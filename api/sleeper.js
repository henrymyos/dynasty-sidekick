const CURRENT_LEAGUE_ID = "1312076332460425216";
const SLEEPER = "https://api.sleeper.app/v1";

async function get(path) {
  const r = await fetch(`${SLEEPER}${path}`);
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

async function leagueChain(currentId) {
  const chain = [];
  let id = currentId;
  let safety = 20;
  while (id && id !== "0" && id !== null && safety-- > 0) {
    const lg = await get(`/league/${id}`);
    chain.push(lg);
    id = lg.previous_league_id;
  }
  return chain.reverse();  // oldest first
}

async function fetchSeason(lg) {
  const [drafts, users, rosters] = await Promise.all([
    get(`/league/${lg.league_id}/drafts`),
    get(`/league/${lg.league_id}/users`),
    get(`/league/${lg.league_id}/rosters`),
  ]);

  const draftsWithPicks = await Promise.all(drafts.map(async d => {
    const [full, picks] = await Promise.all([
      get(`/draft/${d.draft_id}`).catch(() => d),
      d.status === "complete"
        ? get(`/draft/${d.draft_id}/picks`).catch(() => [])
        : Promise.resolve([]),
    ]);
    return {
      ...d,
      slot_to_roster_id: full.slot_to_roster_id || {},
      picks,
    };
  }));

  const weekResults = await Promise.all(
    Array.from({ length: 18 }, (_, i) =>
      get(`/league/${lg.league_id}/transactions/${i + 1}`).catch(() => [])
    )
  );
  const transactions = weekResults.flat();
  const trades = transactions.filter(t => t.type === "trade" && t.status === "complete");

  return { league: lg, users, rosters, drafts: draftsWithPicks, trades };
}

let playersCache = null;
let playersCacheAt = 0;
const PLAYERS_TTL_MS = 6 * 60 * 60 * 1000;  // 6 hours

async function fetchPlayers() {
  if (playersCache && Date.now() - playersCacheAt < PLAYERS_TTL_MS) return playersCache;
  playersCache = await get("/players/nfl");
  playersCacheAt = Date.now();
  return playersCache;
}

export default async function handler(req, res) {
  try {
    const chain = await leagueChain(CURRENT_LEAGUE_ID);
    if (!chain.length) {
      res.status(500).json({ error: "No league chain found" });
      return;
    }

    const seasonData = await Promise.all(chain.map(fetchSeason));

    // Collect referenced player IDs
    const playerIds = new Set();
    seasonData.forEach(sd => {
      sd.drafts.forEach(d => d.picks.forEach(p => p.player_id && playerIds.add(p.player_id)));
      sd.trades.forEach(t => {
        if (t.adds) Object.keys(t.adds).forEach(id => playerIds.add(id));
        if (t.drops) Object.keys(t.drops).forEach(id => playerIds.add(id));
      });
      sd.rosters.forEach(r => (r.players || []).forEach(id => playerIds.add(id)));
    });

    const players = await fetchPlayers();
    const referenced = {};
    playerIds.forEach(id => {
      const p = players[id];
      if (p) referenced[id] = {
        name: `${p.first_name || ""} ${p.last_name || ""}`.trim() || id,
        position: p.position || null,
        team: p.team || null,
        age: typeof p.age === "number" ? p.age : null,
        years_exp: typeof p.years_exp === "number" ? p.years_exp : null,
      };
    });

    const slim = seasonData.map(sd => ({
      season: sd.league.season,
      league_id: sd.league.league_id,
      league_name: sd.league.name,
      status: sd.league.status,
      users: sd.users.map(u => ({
        user_id: u.user_id,
        display_name: u.display_name,
        team_name: (u.metadata && u.metadata.team_name) || null,
        avatar: u.avatar,
      })),
      rosters: sd.rosters.map(r => ({
        roster_id: r.roster_id,
        owner_id: r.owner_id,
        players: r.players || [],
        wins: r.settings && r.settings.wins,
        losses: r.settings && r.settings.losses,
        ties: r.settings && r.settings.ties,
        fpts: r.settings && (r.settings.fpts || 0) + ((r.settings.fpts_decimal || 0) / 100),
      })),
      drafts: sd.drafts.map(d => ({
        draft_id: d.draft_id,
        type: d.type,
        status: d.status,
        created: d.created,
        rounds: d.settings && d.settings.rounds,
        slot_to_roster_id: d.slot_to_roster_id || {},
        picks: d.picks.map(p => ({
          round: p.round,
          pick_no: p.pick_no,
          draft_slot: p.draft_slot,
          player_id: p.player_id,
          picked_by: p.picked_by,
          roster_id: p.roster_id,
          is_keeper: p.is_keeper,
        })),
      })),
      trades: sd.trades.map(t => ({
        tx_id: t.transaction_id,
        created: t.created,
        leg: t.leg,
        roster_ids: t.roster_ids,
        adds: t.adds || {},
        drops: t.drops || {},
        draft_picks: (t.draft_picks || []).map(dp => ({
          season: dp.season,
          round: dp.round,
          roster_id: dp.roster_id,
          owner_id: dp.owner_id,
          previous_owner_id: dp.previous_owner_id,
        })),
      })),
    }));

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=86400");
    // All currently-pending traded picks for the current league (covers every
    // future season). Used to value each roster's pick assets.
    const tradedPicks = await get(`/league/${CURRENT_LEAGUE_ID}/traded_picks`).catch(() => []);
    const slimTradedPicks = tradedPicks.map(t => ({
      season: t.season,
      round: t.round,
      roster_id: t.roster_id,
      owner_id: t.owner_id,
      previous_owner_id: t.previous_owner_id,
    }));
    res.json({ seasons: slim, players: referenced, traded_picks: slimTradedPicks });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
}
