import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatCount, formatMs, parsePlan, PlanError } from "../docs/analyze.js";

const slow = readFileSync(new URL("../docs/examples/slow.json", import.meta.url), "utf8");
const tuned = readFileSync(new URL("../docs/examples/tuned.json", import.meta.url), "utf8");

test("slow fixture has deterministic hierarchy, work, and evidence", () => {
  const report = parsePlan(slow);
  assert.equal(report.nodes.length, 4);
  assert.deepEqual(report.nodes.map((node) => node.id), ["0", "0.0", "0.0.0", "0.0.1"]);
  assert.equal(report.nodes[3].workMs, 220);
  assert.equal(report.executionMs, 436.8);
  assert.equal(report.rootReadBlocks, 2300);
  assert.deepEqual(report.findings.map((finding) => finding.id), [
    "0-sort-spill", "0.0.0-row-estimate", "0.0.0-filtered-scan", "0.0.1-repeated-inner",
  ]);
});

test("tuned fixture produces no false alarm from an ordinary in-memory sort", () => {
  const report = parsePlan(tuned);
  assert.equal(report.nodes.length, 5);
  assert.equal(report.findings.length, 0);
  assert.equal(report.rootTempWrittenBlocks, null);
});

test("estimated-only plans remain useful without inventing runtime", () => {
  const report = parsePlan(JSON.stringify([{ Plan: { "Node Type": "Seq Scan", "Plan Rows": 12, "Total Cost": 40 } }]));
  assert.equal(report.hasActual, false);
  assert.equal(report.executionMs, null);
  assert.equal(report.hotspots.length, 0);
  assert.equal(report.findings[0].id, "estimated-only");
});

test("hash batches and temp blocks receive cautious findings", () => {
  const report = parsePlan(JSON.stringify([{ Plan: {
    "Node Type": "Hash", "Actual Total Time": 10, "Actual Loops": 1,
    "Hash Batches": 4, "Temp Written Blocks": 50,
  } }]));
  assert.equal(report.findings[0].id, "0-hash-batches");
  assert.equal(report.findings.length, 1);
});

test("unexplained temporary I/O is noted but not summed across the tree", () => {
  const report = parsePlan(JSON.stringify([{ Plan: {
    "Node Type": "Materialize", "Actual Total Time": 10, "Actual Loops": 1,
    "Temp Read Blocks": 20, "Temp Written Blocks": 20,
  } }]));
  assert.equal(report.findings[0].id, "0-temp-io");
  assert.equal(report.rootTempWrittenBlocks, 20);
});

test("row estimate comparisons use per-loop values, not multiplied actual rows", () => {
  const report = parsePlan(JSON.stringify([{ Plan: {
    "Node Type": "Index Scan", "Actual Total Time": 0.1, "Actual Loops": 5000,
    "Plan Rows": 1, "Actual Rows": 1,
  } }]));
  assert.equal(report.nodes[0].workMs, 500);
  assert.equal(report.findings.length, 0);
});

test("multiple statements, invalid JSON, malformed nodes, and oversized input are rejected", () => {
  assert.throws(() => parsePlan("{"), PlanError);
  assert.throws(() => parsePlan("[]"), /one EXPLAIN/);
  assert.throws(() => parsePlan(JSON.stringify([{ Plan: { "Node Type": "Seq Scan" } }, { Plan: { "Node Type": "Sort" } }])), /one EXPLAIN/);
  assert.throws(() => parsePlan('{"Plan":{"Plans":[]}}'), /Node Type/);
  assert.throws(() => parsePlan('{"Plan":{"Node Type":"Sort","Plans":{}}}'), /non-list/);
  assert.throws(() => parsePlan("x".repeat(2_000_001)), /2 MB/);
  assert.throws(() => parsePlan(JSON.stringify({ Plan: {
    "Node Type": "Result", "Actual Total Time": 1e308, "Actual Loops": 1e308,
  } })), /unrepresentable runtime/);
});

test("depth and node-count limits reject pathological plans", () => {
  let deep = { "Node Type": "Result" };
  for (let index = 0; index < 81; index++) deep = { "Node Type": "Result", Plans: [deep] };
  assert.throws(() => parsePlan(JSON.stringify({ Plan: deep })), /safety limit/);
  const wide = { "Node Type": "Append", Plans: Array.from({ length: 5000 }, () => ({ "Node Type": "Result" })) };
  assert.throws(() => parsePlan(JSON.stringify({ Plan: wide })), /safety limit/);
});

test("formatting leaves unavailable data visibly unknown", () => {
  assert.equal(formatMs(null), "—");
  assert.equal(formatMs(1.234), "1.23 ms");
  assert.equal(formatCount(1200), "1,200");
  assert.equal(formatCount(null), "—");
});
