// Live FlockFantasy expert-average rookie rankings (superflex hybrid).
//
// Token handling: Flock uses AWS Cognito (us-east-2, client_id
// ua856edefug8li947i61sesba). Access tokens expire ~24h. We exchange a
// long-lived refresh token (FLOCK_REFRESH_TOKEN env var) for a fresh access
// token whenever the cached one is within 5 minutes of expiry. FLOCK_TOKEN
// is honored as a one-shot fallback so the system still works for the
// current 24h window even before the refresh token is added.

const FLOCK_URL =
  "https://api.flockfantasy.com/rankings" +
  "?format=SUPERFLEX&pickType=hybrid&year=2025" +
  "&deltaRankType=overall&deltaFormat=DYNASTY&deltaSubformat=SUPERFLEX";

const COGNITO_URL = "https://cognito-idp.us-east-2.amazonaws.com/";
const COGNITO_CLIENT_ID = "ua856edefug8li947i61sesba";

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

async function refreshAccessToken(refreshToken) {
  const r = await fetch(COGNITO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error("Cognito refresh " + r.status + ": " + text.slice(0, 200));
  }
  const data = await r.json();
  const newAccess = data && data.AuthenticationResult && data.AuthenticationResult.AccessToken;
  if (!newAccess) throw new Error("no AccessToken in Cognito response");
  return newAccess;
}

async function getValidAccessToken() {
  const now = Date.now();
  const refresh = process.env.FLOCK_REFRESH_TOKEN;
  // Use cached token if still fresh (margin: 5 min before expiry).
  if (tokenCache && tokenCache.expMs - now > 5 * 60 * 1000) return tokenCache.token;
  // Refresh path
  if (refresh) {
    const token = await refreshAccessToken(refresh);
    const expMs = decodeJwtExp(token) || (now + 24 * 60 * 60 * 1000);
    tokenCache = { token, expMs };
    return token;
  }
  // Fallback: one-shot manual access token
  const fallback = process.env.FLOCK_TOKEN;
  if (fallback) {
    const expMs = decodeJwtExp(fallback) || (now + 60 * 60 * 1000);
    tokenCache = { token: fallback, expMs };
    if (expMs - now <= 5 * 60 * 1000) throw new Error("FLOCK_TOKEN expired and no FLOCK_REFRESH_TOKEN set");
    return fallback;
  }
  throw new Error("No FLOCK_REFRESH_TOKEN or FLOCK_TOKEN env var set");
}

export default async function handler(req, res) {
  try {
    const now = Date.now();
    if (rankingsCache && now - rankingsCache.at < RANKINGS_TTL_MS) {
      res.setHeader("Cache-Control", "s-maxage=300");
      res.json(rankingsCache.payload);
      return;
    }
    const token = await getValidAccessToken();
    const r = await fetch(FLOCK_URL, {
      headers: {
        Authorization: "Bearer " + token,
        Origin: "https://flockfantasy.com",
        "User-Agent": "Mozilla/5.0 draft-picks-bot",
      },
    });
    if (r.status === 401) {
      // Access token rejected — drop the cache and retry once if we can refresh.
      tokenCache = null;
      if (process.env.FLOCK_REFRESH_TOKEN) {
        const t2 = await getValidAccessToken();
        const r2 = await fetch(FLOCK_URL, {
          headers: {
            Authorization: "Bearer " + t2,
            Origin: "https://flockfantasy.com",
            "User-Agent": "Mozilla/5.0 draft-picks-bot",
          },
        });
        if (!r2.ok) throw new Error("Flock HTTP " + r2.status + " after refresh");
        var body = await r2.json();
      } else {
        throw new Error("Flock HTTP 401 and no refresh token");
      }
    } else if (!r.ok) {
      throw new Error("Flock HTTP " + r.status);
    } else {
      var body = await r.json();
    }
    if (body.statusCode && body.statusCode >= 400) {
      throw new Error("Flock body error: " + JSON.stringify(body).slice(0, 200));
    }
    const rookies = (body.data || [])
      .filter(p => p.isRookie && p.position && p.averageRank != null)
      .map(p => ({
        name: p.playerName,
        normName: normalizeName(p.playerName),
        position: p.position,
        team: p.team || null,
        averageRank: p.averageRank,
        overallAverageRank: p.overallAverageRank,
        rookie: true,
      }))
      .sort((a, b) => a.averageRank - b.averageRank);
    rookies.forEach((p, i) => { p.rookieRank = i + 1; });

    const payload = {
      players: rookies,
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
