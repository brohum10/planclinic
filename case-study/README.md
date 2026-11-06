# A real plan: latest account events

The synthetic examples teach PlanClinic's interface. This case study uses an actual PostgreSQL engine through [PGlite](https://github.com/electric-sql/pglite), an in-process PostgreSQL WebAssembly build. It is a **local, generated workload**, not production traffic or a server benchmark.

The question is ordinary: show the latest 20 audit events for one account. The script creates 50,000 deterministic rows across 1,000 account IDs, runs the query, adds one composite index, and runs the identical query again. It checks that the returned rows are unchanged.

```sql
SELECT id, account_id, created_at
FROM audit_events
WHERE account_id = 42
ORDER BY created_at DESC
LIMIT 20;

CREATE INDEX audit_events_account_created_idx
ON audit_events (account_id, created_at DESC);
```

## Recorded result

Recorded with PostgreSQL 18.6 via PGlite 0.5.15. Each phase used 3 warm-up `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` executions, then 15 measured executions in the same in-memory database. The plan fixture for each phase is the sample at the median execution time.

| Signal | Before index | After index |
| --- | ---: | ---: |
| Plan shape | Limit → Sort → Seq Scan | Limit → Index Scan |
| Rows returned | 20 | 20 |
| Median PostgreSQL execution time, 15 captures | 4.014 ms | 0.036 ms |
| Root shared buffer hits + reads, representative capture | 1,064 | 22 |

The index lets PostgreSQL use the account filter and timestamp order together. In this run, the plan no longer scanned all 50,000 rows or performed the separate sort. These are **observations for this generated data and warm in-memory PGlite run**. They do not predict a production speedup, network latency, cold-cache behavior, or index write/storage costs. `Execution Time` is PostgreSQL's reported time inside `EXPLAIN`, not end-to-end JavaScript or page time. Buffer counts include descendant work and are not additive across nodes.

The [raw before plan](../docs/examples/account-before.json), [raw after plan](../docs/examples/account-after.json), and [all 15 timings per phase](results.json) are committed so the summary can be checked. The live app can load both plans locally.

## Reproduce

Node.js 22 or newer is needed. No standalone PostgreSQL server or Docker is required.

```bash
npm ci
npm run case-study
```

The verification command rebuilds the dataset, checks result equality and the expected plan shapes, and compares those shapes with the committed fixtures. It prints fresh medians but does **not** demand identical timings on another machine. To replace the recorded fixtures and measurements deliberately, run `npm run case-study:record` and review the diff. PGlite is a development-only dependency; the published web app remains static and sends no pasted plan to a server.
