// AI trade analysis via the Anthropic Messages API (first-party REST, to match
// this project's dependency-free, fetch-based API layer). For each completed
// trade it explains why each team did it, whether it helped, and how it shifts
// their strategy. Requires ANTHROPIC_API_KEY in the environment; the model
// defaults to Claude Opus 4.8 and can be overridden with ANTHROPIC_MODEL.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

const SYSTEM = `You are a sharp, concise dynasty fantasy football analyst.

You will be given one completed trade: each manager's received and given-up assets (players with positions and draft picks), their KeepTradeCut (KTC) dynasty values, the KTC verdict for each side, and each manager's contention window (Contender = win-now, Middler, or Reloader = rebuilding).

Write an analysis of the trade. For EACH team, cover:
- Why they likely made the move, fit to their contention window and what they got vs. gave.
- Whether it actually helped them. Reference the KTC verdict and the positional/roster impact, and be willing to say a team lost the trade.
- How it may shift their strategy going forward (what they should target or do next).

Use the real player names. Be specific and insightful, not generic. Aim for 150-220 words total. You may lead each team's part with a short label like "Henry:". Use plain text only - no markdown, no bullet characters, no asterisks. Respond with only the analysis; no preamble, and don't restate the raw numbers as a list.`;

// Warm-instance cache so re-clicking the same trade doesn't re-bill.
const memCache = {};

async function readBody(req) {
  if (req.body != null) return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  const raw = await new Promise((resolve, reject) => {
    let d = "";
    req.on("data", c => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(503).json({ error: "AI analysis isn't configured yet — add an ANTHROPIC_API_KEY to this project's environment variables." });
    return;
  }
  try {
    const body = await readBody(req);
    const context = (body.context || "").toString();
    const cacheId = (body.tradeId || "").toString();
    if (!context) { res.status(400).json({ error: "missing trade context" }); return; }
    if (cacheId && memCache[cacheId]) { res.json({ analysis: memCache[cacheId], cached: true }); return; }

    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM,
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        messages: [{ role: "user", content: context }],
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      res.status(502).json({ error: "Anthropic API " + r.status + ": " + detail.slice(0, 300) });
      return;
    }
    const data = await r.json();
    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();
    if (!text) { res.status(502).json({ error: "No analysis returned (" + (data.stop_reason || "unknown") + ")." }); return; }
    if (cacheId) memCache[cacheId] = text;
    res.setHeader("Cache-Control", "no-store");
    res.json({ analysis: text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
