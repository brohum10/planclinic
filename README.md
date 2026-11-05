# PlanClinic

An interactive, browser-only explorer for PostgreSQL JSON `EXPLAIN` output. Paste a plan or open one of the clearly labeled synthetic examples to see the execution tree, inclusive-time hotspots, and specific clues worth investigating. No account, backend, analytics, or plan upload.

**Live demo:** https://brohum10.github.io/planclinic/

## Why this exists

A JSON plan has the evidence, but the nesting makes it hard to scan. PlanClinic keeps the interpretation modest: it surfaces disk sorts, hash batching, row-estimate gaps, heavily filtered sequential scans, repeated inner branches, and temporary I/O. Each clue shows the observed numbers and a next question. It does not promise that an index or configuration change will fix the query.

## Run locally

```bash
python3 -m http.server 8000 --directory docs
```

Open `http://localhost:8000`. The app starts with a **synthetic slow join**; use the second example to see how the readout changes. For your own database, paste output from `EXPLAIN (FORMAT JSON)` or, when appropriate, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. **ANALYZE executes the statement**; review side effects before using it on writes or production workloads. The tool itself only reads the JSON you paste or select in your browser.

## Interpretation rules

- PostgreSQL node `Actual Total Time` and `Actual Rows` are per loop. PlanClinic multiplies time by `Actual Loops` for an **inclusive work signal** while comparing planned and actual rows per loop.
- Parent time and buffer counts include descendants. Hotspot bars must **not** be summed into query wall time. The top-level `Execution Time`, when present, is shown separately.
- A plan without `ANALYZE` has estimated cost but no measured runtime. The tool keeps these values visibly unknown instead of converting planner cost units into milliseconds.
- Numeric thresholds are investigation heuristics, not optimizer advice. The synthetic examples are teaching data, not measured PostgreSQL runs.

These rules follow the [PostgreSQL EXPLAIN documentation](https://www.postgresql.org/docs/current/using-explain.html) and [EXPLAIN command reference](https://www.postgresql.org/docs/current/sql-explain.html).

## Engineering notes

- `docs/analyze.js` is a pure parser and analyzer; `docs/app.js` handles the UI. All dynamic plan text enters the page through `textContent`, not HTML injection.
- Input is capped at 2 MB, 5,000 nodes, and 80 levels. The app renders no SQL predicate text and uses no storage, account, or telemetry endpoint. Example JSON is fetched from the same static site.
- Tests cover malformed plans, safety limits, per-loop accounting, estimated-only input, disk/temporary I/O, and false-positive boundaries.
- The site is static, dependency-free JavaScript and CSS served by GitHub Pages from `docs/`.

## Verify

```bash
npm test
npm run bench
```

`bench` measures JSON parsing and pure analysis of a synthetic 3,001-node plan, excluding browser rendering. Results vary by machine and are not database query benchmarks.

## Limits

PlanClinic is a triage aid. It does not connect to PostgreSQL, inspect schema/index definitions, compare plans, or substitute for workload-aware query tuning. Pasted plans can contain private table names or literals in the original JSON; the app processes them locally, but review any text you copy or share.

MIT licensed. See [LICENSE](LICENSE).
