// Default league (Henry's). Any Sleeper league can be loaded by passing
// ?league_id= — the response shape is identical.
const DEFAULT_LEAGUE_ID = "1312076332460425216";
const SLEEPER = "https://api.sleeper.app/v1";

function resolveLeagueId(req) {
  const q = req.query && req.query.league_id;
  return typeof q === "string" && /^\d{10,20}$/.test(q) ? q : DEFAULT_LEAGUE_ID;
}

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
  const [drafts, users, rosters, winnersBracket] = await Promise.all([
    get(`/league/${lg.league_id}/drafts`),
    get(`/league/${lg.league_id}/users`),
    get(`/league/${lg.league_id}/rosters`),
    get(`/league/${lg.league_id}/winners_bracket`).catch(() => []),
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

  // Weekly matchups (per-team points + matchup_id pairing) for schedule-luck /
  // expected-wins analysis. Empty arrays for unplayed/future weeks.
  const matchups = await Promise.all(
    Array.from({ length: 18 }, (_, i) =>
      get(`/league/${lg.league_id}/matchups/${i + 1}`).catch(() => [])
    )
  );

  return { league: lg, users, rosters, drafts: draftsWithPicks, trades, winnersBracket, matchups };
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
    const leagueId = resolveLeagueId(req);
    const chain = await leagueChain(leagueId);
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
        depth_chart_order: typeof p.depth_chart_order === "number" ? p.depth_chart_order : null,
      };
    });

    const slim = seasonData.map(sd => ({
      season: sd.league.season,
      league_id: sd.league.league_id,
      league_name: sd.league.name,
      status: sd.league.status,
      // League format info so the frontend can adapt to any league: starting
      // lineup shape (drives 1QB-vs-superflex values and lineup math) and
      // playoff size. Brackets let standings be computed for leagues that
      // don't assign draft slots in reverse order of finish.
      roster_positions: sd.league.roster_positions || [],
      playoff_teams: (sd.league.settings && sd.league.settings.playoff_teams) || null,
      playoff_week_start: (sd.league.settings && sd.league.settings.playoff_week_start) || null,
      // TE reception bonus → which KTC value scale (tep/tepp/teppp) applies.
      bonus_rec_te: (sd.league.scoring_settings && sd.league.scoring_settings.bonus_rec_te) || 0,
      winners_bracket: (sd.winnersBracket || []).map(m => ({
        r: m.r, p: m.p != null ? m.p : null, t1: m.t1, t2: m.t2, w: m.w, l: m.l,
      })),
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
        // A league can hold the NEXT year's rookie draft (created mid-season
        // before renewal), so the draft's own season matters for grouping.
        season: d.season || sd.league.season,
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
      matchups: (sd.matchups || []).map(week =>
        (week || []).map(m => ({ roster_id: m.roster_id, matchup_id: m.matchup_id, points: m.points }))),
    }));

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=86400");
    // All currently-pending traded picks for the current league (covers every
    // future season). Used to value each roster's pick assets.
    const tradedPicks = await get(`/league/${leagueId}/traded_picks`).catch(() => []);
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
