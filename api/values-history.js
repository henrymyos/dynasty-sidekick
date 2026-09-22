// Weekly value snapshots (KTC value + Flock rank per player, KTC value per pick)
// kept in Upstash so the app can show who's rising and falling.
//
// Storage (Upstash Redis over REST, KV_REST_API_URL / KV_REST_API_TOKEN):
//   dp:values:index            → ["2026-09-22", ...]  (ISO dates, ascending)
//   dp:values:snap:<date>      → { date, ktc: {norm: value}, flock: {norm: rank}, picks: {key: value} }
//
// Snapshots are lazy: a GET that finds the newest snapshot older than 6 days
// pulls the live KTC + Flock feeds from this same deployment and writes a new
// one, so the series grows just by people using the site. The response is a
// compact per-player series for the last WEEKS snapshots.

const INDEX_KEY = "dp:values:index";
const SNAP_KEY = d => "dp:values:snap:" + d;
const WEEKS = 10;            // series length sent to the client
const STALE_DAYS = 6;
const MAX_SNAPS = 60;

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function redis(cmd) {
  const r = await fetch(URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error("redis " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const getJson = async k => { const v = await redis(["GET", k]); return v ? JSON.parse(v) : null; };
const setJson = (k, v) => redis(["SET", k, JSON.stringify(v)]);

function isoDate(ms = Date.now()) { return new Date(ms).toISOString().slice(0, 10); }
function daysBetween(a, b) { return (Date.parse(b) - Date.parse(a)) / 86400000; }

// Build today's snapshot from the live feeds served by this deployment.
async function takeSnapshot(host) {
  const base = (host.startsWith("localhost") ? "http://" : "https://") + host;
  const [ktcRes, flockRes] = await Promise.all([
    fetch(base + "/api/ktc-dynasty", { headers: { accept: "application/json" } }),
    fetch(base + "/api/flock-live", { headers: { accept: "application/json" } }).catch(() => null),
  ]);
  if (!ktcRes.ok) throw new Error("ktc-dynasty HTTP " + ktcRes.status);
  const ktcData = await ktcRes.json();
  const ktc = {};
  Object.entries(ktcData.players || {}).forEach(([norm, e]) => { if (e && e.value) ktc[norm] = e.value; });
  const picks = ktcData.picks || {};
  const flock = {};
  if (flockRes && flockRes.ok) {
    const f = await flockRes.json();
    (f.allPlayers || []).forEach(p => { flock[p.normName] = p.averageRank; });
  }
  return { date: isoDate(), ktc, flock, picks };
}

async function ensureFresh(host) {
  let index = (await getJson(INDEX_KEY)) || [];
  const latest = index[index.length - 1];
  if (latest && daysBetween(latest, isoDate()) < STALE_DAYS) return index;
  const snap = await takeSnapshot(host);
  if (Object.keys(snap.ktc).length < 100) throw new Error("snapshot looks empty");
  await setJson(SNAP_KEY(snap.date), snap);
  index = index.filter(d => d !== snap.date).concat([snap.date]).sort();
  while (index.length > MAX_SNAPS) {
    const drop = index.shift();
    await redis(["DEL", SNAP_KEY(drop)]);
  }
  await setJson(INDEX_KEY, index);
  return index;
}

export default async function handler(req, res) {
  if (!URL || !TOKEN) {
    res.status(500).json({ error: "KV_REST_API_URL / KV_REST_API_TOKEN not set" });
    return;
  }
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host || "";
    const index = await ensureFresh(host);
    const dates = index.slice(-WEEKS);
    const snaps = await Promise.all(dates.map(d => getJson(SNAP_KEY(d))));
    // Per-player series aligned to `dates` (null where a snapshot lacks the player).
    const players = {};
    const picks = {};
    snaps.forEach((s, i) => {
      if (!s) return;
      Object.entries(s.ktc || {}).forEach(([n, v]) => {
        if (!players[n]) players[n] = { v: new Array(dates.length).fill(null), f: new Array(dates.length).fill(null) };
        players[n].v[i] = v;
      });
      Object.entries(s.flock || {}).forEach(([n, r]) => {
        if (!players[n]) players[n] = { v: new Array(dates.length).fill(null), f: new Array(dates.length).fill(null) };
        players[n].f[i] = r;
      });
      Object.entries(s.picks || {}).forEach(([k, v]) => {
        if (!picks[k]) picks[k] = new Array(dates.length).fill(null);
        picks[k][i] = v;
      });
    });
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.json({ dates, players, picks, total: index.length, first: index[0] || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
