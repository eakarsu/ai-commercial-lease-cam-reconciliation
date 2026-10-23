// Feature pack: search/filter helpers, CSV export, deterministic record insights.
// Insights never call a provider; they are a labelled deterministic fallback.
export function filterRecords(rows, query = {}) {
  const q = String(query.q || query.search || "").trim().toLowerCase();
  const status = String(query.status || "").trim();
  const risk = String(query.risk || "").trim();
  return (rows || []).filter((row) => {
    if (status && String(row.status ?? row.state ?? "") !== status) return false;
    if (risk && String(row.risk ?? "") !== risk) return false;
    if (!q) return true;
    const hay = [row.reference, row.title, row.subject, row.status, row.state, row.owner, row.risk, JSON.stringify(row.payload || {})].join(" ").toLowerCase();
    return hay.includes(q);
  });
}
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export function recordsToCsv(rows) {
  const cols = ["id", "reference", "title", "status", "owner", "risk", "due_date", "amount"];
  const lines = [cols.join(",")];
  for (const row of rows || []) lines.push(cols.map((c) => csvCell(c === "title" ? (row.title ?? row.subject ?? "") : c === "status" ? (row.status ?? row.state ?? "") : row[c])).join(","));
  return lines.join("\n") + "\n";
}
export function buildRecordInsights(rows, domainLabel = "record") {
  const list = rows || [];
  const totalValue = list.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const highRisk = list.filter((r) => ["High", "Critical"].includes(r.risk));
  const open = list.filter((r) => !["Approved", "Closed"].includes(r.status ?? r.state));
  const zeroAmount = list.filter((r) => Number(r.amount) === 0);
  const sorted = [...list].sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));
  const top = sorted.slice(0, 3).map((r) => ({ reference: r.reference ?? "", amount: Number(r.amount) || 0, risk: r.risk ?? "", status: r.status ?? r.state ?? "" }));
  return {
    aiGenerated: false,
    source: "deterministic-fallback",
    label: "Deterministic fallback — computed locally from your records; no provider call was made.",
    domain: domainLabel,
    summary: { totalRecords: list.length, openRecords: open.length, highRiskRecords: highRisk.length, zeroAmountRecords: zeroAmount.length, totalValue, hasRecords: list.length > 0 },
    insights: [
      { id: "risk-concentration", title: `${domainLabel} risk concentration`, detail: highRisk.length ? `${highRisk.length} of ${list.length} records are High or Critical risk.` : `0 records are High or Critical risk.`, value: highRisk.length, empty: highRisk.length === 0 },
      { id: "value-outliers", title: `${domainLabel} value outliers`, detail: top.length ? `Largest records: ${top.map((t) => `${t.reference} (${t.amount})`).join(", ")}.` : "No records yet — value outliers will appear once records exist.", value: top, empty: top.length === 0 },
      { id: "next-actions", title: `${domainLabel} next actions`, detail: open.length ? `${open.length} records are still open; start with the highest-value High/Critical items.` : "No open records require action.", value: open.length, empty: open.length === 0 },
    ],
  };
}
export function mountFeaturePack(app, { pool, auth, featureById, accountScoped = false, domainLabel = "record" }) {
  const guard = typeof auth === "function" ? auth : (_req, _res, next) => next();
  app.get("/api/features/:id/records/export", guard, async (req, res, next) => {
    try {
      const feature = featureById(req.params.id);
      const rows = accountScoped
        ? (await pool.query("SELECT * FROM feature_records WHERE account_id=$1 AND feature_id=$2 ORDER BY updated_at DESC,id DESC", [req.user.account_id, feature.id])).rows
        : (await pool.query("SELECT * FROM feature_records WHERE feature_id=$1 ORDER BY updated_at DESC,id DESC", [feature.id])).rows;
      const filtered = filterRecords(rows, req.query);
      if (String(req.query.format || "csv").toLowerCase() === "json") return res.json({ items: filtered, count: filtered.length });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${feature.id}-records.csv"`);
      return res.send(recordsToCsv(filtered));
    } catch (e) { return next(e); }
  });
  app.post("/api/features/:id/insights", guard, async (req, res, next) => {
    try {
      const feature = featureById(req.params.id);
      const rows = accountScoped
        ? (await pool.query("SELECT * FROM feature_records WHERE account_id=$1 AND feature_id=$2 ORDER BY updated_at DESC,id DESC", [req.user.account_id, feature.id])).rows
        : (await pool.query("SELECT * FROM feature_records WHERE feature_id=$1 ORDER BY updated_at DESC,id DESC", [feature.id])).rows;
      return res.json(buildRecordInsights(rows, domainLabel));
    } catch (e) { return next(e); }
  });
}
