import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { parsePlan } from "../docs/analyze.js";

const ROWS = 50_000;
const WARMUPS = 3;
const SAMPLES = 15;
const query = `SELECT id, account_id, created_at
FROM audit_events
WHERE account_id = 42
ORDER BY created_at DESC
LIMIT 20`;
const explain = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`;
const paths = {
  before: new URL("../docs/examples/account-before.json", import.meta.url),
  after: new URL("../docs/examples/account-after.json", import.meta.url),
  results: new URL("./results.json", import.meta.url),
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function nodeTypes(plan) {
  return parsePlan(JSON.stringify(plan)).nodes.map((node) => node.type);
}

async function capture(db) {
  for (let i = 0; i < WARMUPS; i++) await db.query(explain);
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const result = await db.query(explain);
    const plan = result.rows[0]?.["QUERY PLAN"];
    assert.ok(Array.isArray(plan) && plan.length === 1, "PostgreSQL must return one JSON plan");
    samples.push(plan);
  }
  const times = samples.map((sample) => sample[0]["Execution Time"]);
  assert.ok(times.every((time) => Number.isFinite(time) && time >= 0));
  const middle = median(times);
  const representative = samples.find((sample) => sample[0]["Execution Time"] === middle);
  const report = parsePlan(JSON.stringify(representative));
  return {
    plan: representative,
    times,
    medianMs: middle,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    nodeTypes: report.nodes.map((node) => node.type),
    rootSharedHits: report.nodes[0].sharedHit,
    rootSharedReads: report.nodes[0].sharedRead,
  };
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "--verify" && mode !== "--write") {
    throw new Error("Use --verify to check the case study or --write to record fixtures.");
  }
  const db = await PGlite.create();
  try {
    const engine = (await db.query("SELECT version() AS version")).rows[0].version;
    await db.exec(`
      CREATE TABLE audit_events (
        id integer PRIMARY KEY,
        account_id integer NOT NULL,
        created_at timestamp NOT NULL,
        payload text NOT NULL
      );
      INSERT INTO audit_events
      SELECT g, g % 1000, timestamp '2026-01-01' + g * interval '1 minute', repeat('x', 120)
      FROM generate_series(1, ${ROWS}) AS g;
      ANALYZE audit_events;
    `);

    const beforeRows = (await db.query(query)).rows;
    const before = await capture(db);
    await db.exec(`
      CREATE INDEX audit_events_account_created_idx
      ON audit_events (account_id, created_at DESC);
      ANALYZE audit_events;
    `);
    const afterRows = (await db.query(query)).rows;
    const after = await capture(db);
    assert.deepEqual(afterRows, beforeRows, "Index must preserve the query result");
    assert.equal(beforeRows.length, 20);
    assert.ok(before.nodeTypes.includes("Seq Scan"));
    assert.ok(before.nodeTypes.includes("Sort"));
    assert.ok(after.nodeTypes.includes("Index Scan"));
    assert.ok(!after.nodeTypes.includes("Seq Scan"));

    if (mode === "--write") {
      const results = {
        engine,
        dataset: "Deterministic, generated audit events; one row per ID, account_id = ID % 1000",
        rows: ROWS,
        returnedRows: beforeRows.length,
        query,
        index: "CREATE INDEX audit_events_account_created_idx ON audit_events (account_id, created_at DESC)",
        warmups: WARMUPS,
        samples: SAMPLES,
        before: { timesMs: before.times, medianMs: before.medianMs, minMs: before.minMs, maxMs: before.maxMs,
          nodeTypes: before.nodeTypes, rootSharedHits: before.rootSharedHits, rootSharedReads: before.rootSharedReads },
        after: { timesMs: after.times, medianMs: after.medianMs, minMs: after.minMs, maxMs: after.maxMs,
          nodeTypes: after.nodeTypes, rootSharedHits: after.rootSharedHits, rootSharedReads: after.rootSharedReads },
      };
      await writeFile(paths.before, `${JSON.stringify(before.plan, null, 2)}\n`);
      await writeFile(paths.after, `${JSON.stringify(after.plan, null, 2)}\n`);
      await writeFile(paths.results, `${JSON.stringify(results, null, 2)}\n`);
    } else {
      for (const phase of ["before", "after"]) {
        const stored = JSON.parse(await readFile(paths[phase], "utf8"));
        assert.deepEqual(nodeTypes(stored), phase === "before" ? before.nodeTypes : after.nodeTypes,
          `${phase} fixture must match the reproducible query shape`);
      }
      const stored = JSON.parse(await readFile(paths.results, "utf8"));
      assert.equal(stored.rows, ROWS);
      assert.equal(stored.samples, SAMPLES);
      assert.equal(stored.returnedRows, beforeRows.length);
    }
    console.log(JSON.stringify({ engine: engine.match(/PostgreSQL [^ ]+ \(PGlite [^)]+\)/)?.[0] ?? engine,
      rows: ROWS, returnedRows: beforeRows.length,
      before: { nodes: before.nodeTypes, medianMs: before.medianMs, sharedBlocks: before.rootSharedHits + before.rootSharedReads },
      after: { nodes: after.nodeTypes, medianMs: after.medianMs, sharedBlocks: after.rootSharedHits + after.rootSharedReads },
      mode }, null, 2));
  } finally {
    await db.close();
  }
}

await main();
