/** Pure, bounded PostgreSQL JSON EXPLAIN analysis. No DOM or network access. */

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlanError";
  }
}

const MAX_TEXT_BYTES = 2_000_000;
const MAX_NODES = 5_000;
const MAX_DEPTH = 80;

function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function label(value, fallback = "Unknown") {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : fallback;
}

function firstPlan(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new PlanError("Paste one EXPLAIN result at a time.");
    return value[0];
  }
  return value;
}

export function parsePlan(text) {
  if (typeof text !== "string" || !text.trim()) throw new PlanError("Paste PostgreSQL JSON EXPLAIN output first.");
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) throw new PlanError("Plan exceeds the 2 MB local limit.");
  let document;
  try {
    document = firstPlan(JSON.parse(text));
  } catch (error) {
    if (error instanceof PlanError) throw error;
    throw new PlanError("This is not valid JSON. Use EXPLAIN (FORMAT JSON), then paste its JSON output.");
  }
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      !document.Plan || typeof document.Plan !== "object" || Array.isArray(document.Plan)) {
    throw new PlanError("Expected a PostgreSQL JSON EXPLAIN result containing a Plan object.");
  }

  const nodes = [];
  const stack = [{ raw: document.Plan, id: "0", parentId: null, depth: 0 }];
  while (stack.length) {
    const { raw, id, parentId, depth } = stack.pop();
    if (depth > MAX_DEPTH || nodes.length >= MAX_NODES) throw new PlanError("Plan exceeds the 5,000-node or 80-level safety limit.");
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw["Node Type"] !== "string") {
      throw new PlanError(`Node ${id} is missing a valid Node Type.`);
    }
    const children = raw.Plans ?? [];
    if (!Array.isArray(children)) throw new PlanError(`Node ${id} has a non-list Plans field.`);
    const loops = number(raw["Actual Loops"]);
    const actualTotal = number(raw["Actual Total Time"]);
    const planRows = number(raw["Plan Rows"]);
    const actualRows = number(raw["Actual Rows"]);
    const workMs = loops === null || actualTotal === null ? null : actualTotal * loops;
    if (workMs !== null && !Number.isFinite(workMs)) throw new PlanError(`Node ${id} has an unrepresentable runtime.`);
    const node = {
      id, parentId, depth,
      type: label(raw["Node Type"]),
      relation: label(raw["Relation Name"], ""),
      index: label(raw["Index Name"], ""),
      joinType: label(raw["Join Type"], ""),
      loops, actualTotal, actualRows, planRows,
      totalCost: number(raw["Total Cost"]),
      workMs,
      sharedHit: number(raw["Shared Hit Blocks"]),
      sharedRead: number(raw["Shared Read Blocks"]),
      tempRead: number(raw["Temp Read Blocks"]),
      tempWritten: number(raw["Temp Written Blocks"]),
      sortMethod: label(raw["Sort Method"], ""),
      sortSpaceType: label(raw["Sort Space Type"], ""),
      sortSpaceUsed: number(raw["Sort Space Used"]),
      hashBatches: number(raw["Hash Batches"]),
      rowsRemoved: number(raw["Rows Removed by Filter"]),
      childIds: children.map((_, index) => `${id}.${index}`),
    };
    nodes.push(node);
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ raw: children[index], id: `${id}.${index}`, parentId: id, depth: depth + 1 });
    }
  }

  const root = nodes[0];
  const hasActual = root.workMs !== null;
  const findings = buildFindings(nodes, hasActual);
  return {
    nodes, findings, hasActual,
    planningMs: number(document["Planning Time"]),
    executionMs: number(document["Execution Time"]),
    rootReadBlocks: root.sharedRead,
    rootTempWrittenBlocks: root.tempWritten,
    hotspots: hasActual
      ? [...nodes].filter((node) => node.workMs !== null).sort((a, b) => b.workMs - a.workMs).slice(0, 8)
      : [],
  };
}

function buildFindings(nodes, hasActual) {
  if (!hasActual) {
    return [{ id: "estimated-only", level: "note", title: "Planner estimates only",
      evidence: "No actual runtime or loop counts were provided.",
      next: "Use ANALYZE on a safe read-only query if you need measured execution evidence." }];
  }
  const findings = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const add = (node, kind, level, title, evidence, next) =>
    findings.push({ id: `${node.id}-${kind}`, nodeId: node.id, level, title, evidence, next });
  for (const node of nodes) {
    if (node.sortSpaceType.toLowerCase() === "disk" || /external/i.test(node.sortMethod)) {
      add(node, "sort-spill", "high", "Sort used disk", `${node.type} used ${node.sortMethod || "a disk sort"}${node.sortSpaceUsed !== null ? ` (${node.sortSpaceUsed} kB)` : ""}.`,
        "Check the sort keys, input size, and available work_mem before changing a setting or index.");
    }
    if (node.hashBatches !== null && node.hashBatches > 1) {
      add(node, "hash-batches", "high", "Hash needed multiple batches", `${node.type} reported ${node.hashBatches} hash batches.`,
        "Inspect join input size and memory pressure; this alone does not prove which change will help.");
    }
    if ((node.tempRead ?? 0) + (node.tempWritten ?? 0) > 0 &&
        node.sortSpaceType.toLowerCase() !== "disk" && node.hashBatches === null) {
      add(node, "temp-io", "watch", "Temporary blocks observed", `${node.type} reports ${node.tempRead ?? 0} temp reads and ${node.tempWritten ?? 0} temp writes.`,
        "Inspect sort, hash, and materialization work beneath this node; buffer counts include children.");
    }
    if (node.planRows !== null && node.actualRows !== null && node.loops > 0) {
      const ratio = Math.max((node.actualRows + 1) / (node.planRows + 1), (node.planRows + 1) / (node.actualRows + 1));
      const childRepeatsEstimate = node.childIds.some((id) => {
        const child = byId.get(id);
        return child?.planRows === node.planRows && child?.actualRows === node.actualRows;
      });
      if (ratio >= 10 && Math.max(node.actualRows, node.planRows) >= 100 && !childRepeatsEstimate) {
        add(node, "row-estimate", "watch", "Row estimate is far off",
          `${node.type}: planned ${formatCount(node.planRows)} vs. actual ${formatCount(node.actualRows)} rows per loop (${ratio.toFixed(1)}× gap).`,
          "Review table statistics and filter selectivity; estimates and actual rows are compared per loop.");
      }
    }
    if (node.type === "Seq Scan" && node.rowsRemoved !== null && node.actualRows !== null &&
        node.rowsRemoved >= 1_000 && node.rowsRemoved >= 10 * Math.max(1, node.actualRows)) {
      add(node, "filtered-scan", "watch", "Sequential scan discards many rows",
        `${node.relation || "Relation"}: ${formatCount(node.rowsRemoved)} removed vs. ${formatCount(node.actualRows)} returned per loop.`,
        "Check selectivity and existing indexes; a sequential scan can still be the right plan.");
    }
    if (node.parentId && node.loops !== null && node.loops >= 1_000 && node.workMs !== null && node.workMs >= 50) {
      const parent = byId.get(node.parentId);
      if (parent?.type === "Nested Loop") {
        add(node, "repeated-inner", "watch", "Inner branch repeats heavily",
          `${node.type} ran ${formatCount(node.loops)} times, with ${node.workMs.toFixed(1)} ms summed node time.`,
          "Inspect join keys and the inner access path; summed node time is not query wall time.");
      }
    }
  }
  const priority = { high: 0, watch: 1, note: 2 };
  return findings.sort((a, b) => priority[a.level] - priority[b.level]);
}

export function formatCount(value) {
  return value === null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

export function formatMs(value) {
  return value === null ? "—" : `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`;
}
