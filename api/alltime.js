// All-time league history spreadsheet (separate from the rookie-draft sheet):
// head-to-head records, playoff head-to-heads, and championship-round stats.
// This data predates the Sleeper era, so it can only come from the sheet.
const SHEET_ID = "13Zcy7vSsDFhDbbbOaQMeBXED_5va1gGLLnFQ-UlPGeo";
const RANGE = "'All Time Record'!A1:Z120"; // generous; the API trims empty cells and the parser finds the names itself

export default async function handler(req, res) {
  const key = process.env.GOOGLE_API_KEY || process.env.Google_API_KEY;
  if (!key) {
    res.status(500).json({ error: "GOOGLE_API_KEY env var not set on Vercel." });
    return;
  }

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/` +
    `${encodeURIComponent(RANGE)}?key=${key}`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      res.status(r.status).json({ error: "Sheets API error", detail: text });
      return;
    }
    const data = await r.json();
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=86400");
    res.json({ rows: data.values || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
