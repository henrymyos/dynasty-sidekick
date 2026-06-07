// Live FlockFantasy expert-average rookie rankings (superflex hybrid).
//
// Auth handling: Flock's backend wraps Cognito (the client is confidential —
// secret is server-side at Flock). We auto-login at api.flockfantasy.com/auth/login
// with FLOCK_USERNAME / FLOCK_PASSWORD env vars to get a fresh access token
// whenever the cached one is within 5 minutes of expiry or 401s mid-call.
// FLOCK_TOKEN remains a one-shot fallback so the system keeps working if
// the username/password aren't set yet.

const FLOCK_URL =
  "https://api.flockfantasy.com/rankings" +
  "?format=SUPERFLEX&pickType=hybrid&year=2025" +
  "&deltaRankType=overall&deltaFormat=DYNASTY&deltaSubformat=SUPERFLEX";
const LOGIN_URL = "https://api.flockfantasy.com/auth/login";

function normalizeName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[’‘ʼ]/g, "'")
    .replace(/[.,'`]/g, "")
    .replace(/\s+jr\b|\s+sr\b|\s+ii\b|\s+iii\b|\s+iv\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeJwtExp(token) {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const obj = JSON.parse(json);
    return typeof obj.exp === "number" ? obj.exp * 1000 : null;
  } catch { return null; }
}

let tokenCache = null;          // { token, expMs }
let rankingsCache = null;       // { payload, at }
const RANKINGS_TTL_MS = 5 * 60 * 1000;

async function loginAndMintToken() {
  const username = process.env.FLOCK_USERNAME;
  const password = process.env.FLOCK_PASSWORD;
  if (!username || !password) throw new Error("FLOCK_USERNAME/FLOCK_PASSWORD env vars not set");
  const r = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://flockfantasy.com",
      "User-Agent": "Mozilla/5.0 draft-picks-bot",
    },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error("Flock /auth/login " + r.status + ": " + text.slice(0, 200));
  }
  const data = await r.json();
  const token = data && data.accessToken;
  if (!token) throw new Error("Flock /auth/login: missing accessToken");
  return token;
}

async function getValidAccessToken() {
  const now = Date.now();
  // Use cached token if still fresh (5-minute safety margin).
  if (tokenCache && tokenCache.expMs - now > 5 * 60 * 1000) return tokenCache.token;
  // Prefer auto-login via stored credentials.
  if (process.env.FLOCK_USERNAME && process.env.FLOCK_PASSWORD) {
    const token = await loginAndMintToken();
    const expMs = decodeJwtExp(token) || (now + 60 * 60 * 1000);
    tokenCache = { token, expMs };
    return token;
  }
  // Fallback: a one-shot manual access token in FLOCK_TOKEN.
  const fallback = process.env.FLOCK_TOKEN;
  if (fallback) {
    const expMs = decodeJwtExp(fallback) || (now + 60 * 60 * 1000);
    if (expMs - now > 5 * 60 * 1000) {
      tokenCache = { token: fallback, expMs };
      return fallback;
    }
    throw new Error("FLOCK_TOKEN expired and no FLOCK_USERNAME/FLOCK_PASSWORD set for auto-login");
  }
  throw new Error("No FLOCK_USERNAME/FLOCK_PASSWORD or FLOCK_TOKEN env vars set");
}

async function callRankings(token) {
  return fetch(FLOCK_URL, {
    headers: {
      Authorization: "Bearer " + token,
      Origin: "https://flockfantasy.com",
      "User-Agent": "Mozilla/5.0 draft-picks-bot",
    },
  });
}

export default async function handler(req, res) {
  try {
    const now = Date.now();
    if (rankingsCache && now - rankingsCache.at < RANKINGS_TTL_MS) {
      res.setHeader("Cache-Control", "s-maxage=300");
      res.json(rankingsCache.payload);
      return;
    }
    let token = await getValidAccessToken();
    let r = await callRankings(token);
    if (r.status === 401 && (process.env.FLOCK_USERNAME && process.env.FLOCK_PASSWORD)) {
      // Token rejected mid-flight — invalidate cache, re-login, retry once.
      tokenCache = null;
      token = await getValidAccessToken();
      r = await callRankings(token);
    }
    if (!r.ok) throw new Error("Flock HTTP " + r.status);
    const body = await r.json();
    if (body.statusCode && body.statusCode >= 400) {
      throw new Error("Flock body error: " + JSON.stringify(body).slice(0, 200));
    }
    // Every actual player in the dataset (rookies + vets), sorted by Flock's
    // expert-avg rank ascending. Pick assets (draft picks like "2026 Mid 1st")
    // are excluded so this is comparable to a KTC dynasty player feed.
    const allPlayers = (body.data || [])
      .filter(p => p.position && !p.isDraftPick && p.averageRank != null)
      .map(p => ({
        name: p.playerName,
        normName: normalizeName(p.playerName),
        position: p.position,
        team: p.team || null,
        averageRank: p.averageRank,
        isRookie: !!p.isRookie,
      }))
      .sort((a, b) => a.averageRank - b.averageRank);
    // Implied 0–10000 value scale so we can blend with KTC's value space:
    // #1 → 10000, last → 0, linear in between.
    const total = allPlayers.length;
    allPlayers.forEach((p, i) => {
      p.dynastyRank = i + 1;
      p.flockValue = total > 1 ? Math.round(10000 * (1 - i / (total - 1))) : 0;
    });

    const rookies = allPlayers.filter(p => p.isRookie);
    rookies.forEach((p, i) => { p.rookieRank = i + 1; });

    const payload = {
      players: rookies,
      allPlayers,
      subscribed: !!body.subscribed,
      year: body.year,
      updated: Date.now(),
    };
    rankingsCache = { payload, at: Date.now() };
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
