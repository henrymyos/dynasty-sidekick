// Google Apps Script for the "Dynasty Leaderboards" sheet. Fills each
// completed week's column on the "Leaderboard <season>" tab in the existing
// format — places 1-6 "Name (PF : W-L)", places 7-12 "Name (Max PF : W-L)" —
// using the same rules as the site's Standings tab:
//   seeds alternate best record (PF tiebreak) / most points among the teams
//   left; non-playoff teams rank by Max PF, highest first (place 12 = 1.01).
//
// Install: in the sheet, Extensions → Apps Script, paste this file, save,
// then run installTrigger once (approve the permissions prompt). It runs
// every morning after that. Run syncLeaderboard any time to update by hand.
//
// It only writes a week whose column is empty, plus the latest completed
// week (to pick up stat corrections), so hand-entered weeks are left alone.

const SITE_API = "https://draft-picks-eight.vercel.app/api/sleeper";
const PLAYOFF_TEAMS = 6;

// Sleeper user_id → the name the sheet uses.
const SHEET_NAMES = {
  "338472345645641728": "Me",
  "315270787781124096": "Ethan",
  "448911379567472640": "Dad",
  "449690204052123648": "Jacques",
  "300354033099497472": "Isaac",
  "441097256750280704": "Jake",
  "449739408694833152": "Seth",
  "522215629870362624": "Joseph",
  "560170368714358784": "Paige",
  "439619168275263488": "Charlie",
  "449765829966295040": "John",
  "462331384107626496": "Simon",
};

function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "syncLeaderboard")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("syncLeaderboard").timeBased().everyDays(1).atHour(7).create();
  syncLeaderboard();
}

function syncLeaderboard() {
  const data = JSON.parse(UrlFetchApp.fetch(SITE_API + "?_=" + Date.now()).getContentText());
  const season = data.seasons[data.seasons.length - 1];
  const played = Math.max(0, ...season.rosters.map(r => (r.wins || 0) + (r.losses || 0) + (r.ties || 0)));
  if (!played) return;
  const lastReg = (season.playoff_week_start || 15) - 1;

  const sheet = SpreadsheetApp.getActive().getSheetByName("Leaderboard " + season.season);
  if (!sheet) throw new Error('No "Leaderboard ' + season.season + '" tab — add one laid out like last year\'s.');
  const grid = sheet.getDataRange().getValues();
  const colForWeek = {};
  grid[0].forEach((v, c) => { if (c > 0 && v !== "") colForWeek[Number(v)] = c; });
  const rowForPlace = {};
  grid.forEach((row, r) => { if (r > 0 && row[0] !== "" && !isNaN(Number(row[0]))) rowForPlace[Number(row[0])] = r; });

  const nameOf = {};
  season.rosters.forEach(r => {
    const u = season.users.find(x => x.user_id === r.owner_id);
    nameOf[r.roster_id] = SHEET_NAMES[r.owner_id] || (u && u.display_name) || ("Team " + r.roster_id);
  });
  const cum = {};
  season.rosters.forEach(r => { cum[r.roster_id] = { rid: r.roster_id, w: 0, l: 0, t: 0, pf: 0, maxPf: 0 }; });

  for (let wk = 1; wk <= Math.min(played, lastReg); wk++) {
    const entries = (season.matchups[wk - 1] || []).filter(e => e.matchup_id != null && cum[e.roster_id]);
    const byMatch = {};
    entries.forEach(e => { (byMatch[e.matchup_id] = byMatch[e.matchup_id] || []).push(e); });
    Object.values(byMatch).forEach(pair => {
      if (pair.length !== 2) return;
      const [a, b] = pair;
      if (a.points > b.points) { cum[a.roster_id].w++; cum[b.roster_id].l++; }
      else if (b.points > a.points) { cum[b.roster_id].w++; cum[a.roster_id].l++; }
      else { cum[a.roster_id].t++; cum[b.roster_id].t++; }
    });
    entries.forEach(e => {
      cum[e.roster_id].pf += e.points || 0;
      cum[e.roster_id].maxPf += e.max_points != null ? e.max_points : (e.points || 0);
    });

    const col = colForWeek[wk];
    if (col == null) continue;
    const isEmpty = Object.values(rowForPlace).every(r => grid[r][col] === "");
    if (!isEmpty && wk !== played) continue;

    const places = rankWeek(Object.values(cum).map(t => ({ ...t })));
    places.forEach((t, i) => {
      const r = rowForPlace[i + 1];
      if (r == null) return;
      const pts = i < PLAYOFF_TEAMS ? t.pf : t.maxPf;
      const rec = t.w + "-" + t.l + (t.t ? "-" + t.t : "");
      sheet.getRange(r + 1, col + 1).setValue(nameOf[t.rid] + " (" + pts.toFixed(2) + " : " + rec + ")");
    });
  }
}

// Places 1-12: alternating record / points seeds, then the rest by Max PF desc.
function rankWeek(teams) {
  teams.forEach(t => { const g = t.w + t.l + t.t; t.pct = g ? (t.w + 0.5 * t.t) / g : 0; });
  const byRecord = (a, b) => (b.pct - a.pct) || (b.pf - a.pf);
  const byPoints = (a, b) => b.pf - a.pf;
  const seeds = [];
  for (let i = 0; i < PLAYOFF_TEAMS; i++) {
    const left = teams.filter(t => !seeds.includes(t)).sort(i % 2 === 0 ? byRecord : byPoints);
    if (left.length) seeds.push(left[0]);
  }
  const rest = teams.filter(t => !seeds.includes(t)).sort((a, b) => b.maxPf - a.maxPf);
  return seeds.concat(rest);
}
