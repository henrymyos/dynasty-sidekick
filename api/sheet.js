const SHEET_ID = "116MXUbHLTCDdSgVx5dZZYW0lydVyAN0rkeItdq-U7Bo";
const RANGE = "A1:AM350";

export default async function handler(req, res) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) {
    res.status(500).json({ error: "GOOGLE_API_KEY env var not set on Vercel." });
    return;
  }

  const fields = "sheets.data.rowData.values(formattedValue,effectiveFormat.backgroundColor)";
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}` +
    `?includeGridData=true&ranges=${encodeURIComponent(RANGE)}` +
    `&fields=${encodeURIComponent(fields)}&key=${key}`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      res.status(r.status).json({ error: "Sheets API error", detail: text });
      return;
    }
    const data = await r.json();
    const rowData = (data.sheets && data.sheets[0] && data.sheets[0].data && data.sheets[0].data[0] && data.sheets[0].data[0].rowData) || [];
    const rows = rowData.map(row =>
      (row.values || []).map(cell => ({
        v: cell.formattedValue || "",
        bg: cell.effectiveFormat && cell.effectiveFormat.backgroundColor || null,
      }))
    );
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=300");
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
