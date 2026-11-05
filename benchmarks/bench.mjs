import { performance } from "node:perf_hooks";
import { parsePlan } from "../docs/analyze.js";

const children = Array.from({ length: 3000 }, (_, index) => ({
  "Node Type": index % 2 ? "Seq Scan" : "Index Scan",
  "Relation Name": `synthetic_${index}`,
  "Plan Rows": 100,
  "Actual Rows": 100,
  "Actual Total Time": 0.1,
  "Actual Loops": 1,
}));
const input = JSON.stringify([{ Plan: {
  "Node Type": "Append", "Plan Rows": 300000, "Actual Rows": 300000,
  "Actual Total Time": 300, "Actual Loops": 1, Plans: children,
}, "Execution Time": 302 }]);
const durations = [];
for (let index = 0; index < 31; index++) {
  const start = performance.now();
  const report = parsePlan(input);
  const duration = performance.now() - start;
  if (report.nodes.length !== 3001) throw new Error("benchmark fixture changed");
  if (index > 0) durations.push(duration); // one warm-up pass
}
durations.sort((a, b) => a - b);
console.log(JSON.stringify({
  fixture: "synthetic flat 3,001-node PostgreSQL-like plan",
  input_bytes: Buffer.byteLength(input),
  measured_passes: durations.length,
  runtime: process.version,
  median_ms: Number(((durations[14] + durations[15]) / 2).toFixed(2)),
  p95_ms: Number(durations[Math.ceil(durations.length * 0.95) - 1].toFixed(2)),
  scope: "JSON parse and pure analysis only; excludes browser DOM rendering",
}, null, 2));
