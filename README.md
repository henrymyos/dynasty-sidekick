# Dynasty Sidekick

Dynasty fantasy football companion for a Sleeper league: rookie draft board, live draft, rosters, standings, lineups, trade values and league history. Static `index.html` plus Vercel serverless functions in `api/`.

## Run locally

```sh
npx vercel dev        # serves index.html and the api/ functions
```

Opening `index.html` directly works for the page shell, but the data comes from `/api/*`, so use `vercel dev` (or the deployed site).

Any Sleeper league loads with `?league=<league_id>`. Leagues other than the default skip the Google Sheets data (draft grades, all-time records).

## Tests

```sh
npm test              # node --test (Max PF lineup math)
```

## API functions

| File | What it returns |
|---|---|
| `api/sleeper.js` | Every season in the league chain: users, rosters, drafts, trades, playoff bracket, weekly matchups, traded picks |
| `api/draft-live.js` | Live snapshot of the current rookie draft |
| `api/lineup-data.js` | Weekly projections, current NFL week, scoring settings |
| `api/season-projections.js` | Per-week projected points for every rostered player |
| `api/ktc.js`, `api/ktc-live.js` | KeepTradeCut superflex rookie rankings (archived / live) |
| `api/ktc-dynasty.js` | Live KeepTradeCut values for all players |
| `api/ktc-history.js` | Historical KeepTradeCut values across snapshots |
| `api/flock-live.js` | FlockFantasy expert-average rookie rankings |
| `api/values-history.js` | Weekly value snapshots stored in Redis |
| `api/sheet.js`, `api/alltime.js` | Rookie-draft and all-time history Google Sheets |

## Environment variables (Vercel project settings)

Names only; values live in Vercel, never in the repo.

- `GOOGLE_API_KEY`: Sheets API key for `sheet.js` and `alltime.js`
- `FLOCK_USERNAME` + `FLOCK_PASSWORD`, or `FLOCK_TOKEN`: FlockFantasy login for `flock-live.js`
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or the `UPSTASH_REDIS_REST_*` pair): Redis for `values-history.js`

Without a variable, the function that needs it returns a 500 error.

## Other files

- `sheets/leaderboard-sync.gs`: Apps Script that fills the weekly leaderboard sheet from `/api/sleeper` (install steps at the top of the file; not deployed).
- `icon-1024.png`: full-size source art for the app icons (not deployed).
