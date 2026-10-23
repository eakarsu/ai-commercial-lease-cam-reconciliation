import test from "node:test";
import assert from "node:assert/strict";
import { filterRecords, recordsToCsv, buildRecordInsights } from "../featurePack.mjs";
const rows = [
  { id: 1, reference: "A-1", title: "Alpha case", status: "Open", owner: "Sam", risk: "High", due_date: "2026-01-01", amount: 0 },
  { id: 2, reference: "B-2", title: "Beta case", status: "Closed", owner: "Jo", risk: "Low", due_date: "2026-02-01", amount: 500 },
];
test("search/filter matches text, status and risk", () => {
  assert.equal(filterRecords(rows, { q: "alpha" }).length, 1);
  assert.equal(filterRecords(rows, { status: "Closed" }).length, 1);
  assert.equal(filterRecords(rows, { risk: "High" })[0].reference, "A-1");
  assert.equal(filterRecords(rows, { q: "missing" }).length, 0);
});
test("CSV export preserves zero and empty values", () => {
  const csv = recordsToCsv(rows);
  assert.ok(csv.startsWith("id,reference,title,status,owner,risk,due_date,amount"));
  assert.ok(csv.includes("A-1,Alpha case,Open,Sam,High,2026-01-01,0"));
});
test("insights are deterministic fallback preserving false/0/empty", () => {
  const out = buildRecordInsights(rows, "test domain");
  assert.equal(out.aiGenerated, false);
  assert.equal(out.source, "deterministic-fallback");
  assert.equal(out.summary.zeroAmountRecords, 1);
  assert.equal(out.insights.length, 3);
  const empty = buildRecordInsights([], "test domain");
  assert.equal(empty.summary.hasRecords, false);
  assert.equal(empty.summary.totalRecords, 0);
});
