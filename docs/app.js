import { formatCount, formatMs, parsePlan, PlanError } from "./analyze.js";

const input = document.querySelector("#plan-input");
const fileInput = document.querySelector("#file-input");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
const metrics = document.querySelector("#metrics");
const findings = document.querySelector("#findings");
const hotspots = document.querySelector("#hotspots");
const tree = document.querySelector("#tree");
const exampleButtons = {
  slow: document.querySelector("#slow-example"),
  tuned: document.querySelector("#tuned-example"),
  "account-before": document.querySelector("#account-before"),
  "account-after": document.querySelector("#account-after"),
};
const exampleCache = new Map();
let currentReport = null;
let currentNodes = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

function setExample(name) {
  for (const [key, button] of Object.entries(exampleButtons)) {
    button.setAttribute("aria-pressed", String(key === name));
  }
}

function addMetric(label, value, detail) {
  const card = element("div", "metric");
  card.append(element("span", "metric-label", label), element("strong", "metric-value", value),
    element("span", "metric-detail", detail));
  metrics.append(card);
}

function focusNode(id) {
  let node = currentNodes.get(id);
  while (node) {
    const details = document.getElementById(`plan-${node.id.replaceAll(".", "-")}`);
    if (details) details.open = true;
    node = node.parentId ? currentNodes.get(node.parentId) : null;
  }
  const target = document.getElementById(`plan-${id.replaceAll(".", "-")}`);
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
  target?.querySelector("summary")?.focus({ preventScroll: true });
}

function renderFindings(report) {
  findings.replaceChildren();
  if (!report.findings.length) {
    findings.append(element("p", "empty-note", "No current rule was triggered. That does not prove the query is fast; compare with your workload and inspect the plan tree."));
    return;
  }
  for (const finding of report.findings) {
    const card = element("article", "finding");
    card.dataset.level = finding.level;
    card.append(element("h4", "", finding.title), element("p", "", finding.evidence),
      element("p", "", finding.next));
    if (finding.nodeId) {
      const focus = element("button", "", "Show this node ↗");
      focus.type = "button";
      focus.addEventListener("click", () => focusNode(finding.nodeId));
      card.append(focus);
    }
    findings.append(card);
  }
}

function renderHotspots(report) {
  hotspots.replaceChildren();
  if (!report.hasActual) {
    hotspots.append(element("p", "empty-note", "Runtime hotspots need EXPLAIN ANALYZE. Estimated costs are planner units, not milliseconds."));
    return;
  }
  const largest = Math.max(1, ...report.hotspots.map((node) => node.workMs));
  for (const node of report.hotspots) {
    const row = element("div", "hotspot");
    const heading = element("div");
    const focus = element("button", "", node.type);
    focus.type = "button";
    focus.addEventListener("click", () => focusNode(node.id));
    heading.append(focus, element("small", "", node.relation || node.index || `node ${node.id}`));
    const bar = element("div", "bar");
    const fill = element("i");
    fill.style.width = `${Math.max(1, (node.workMs / largest) * 100)}%`;
    bar.append(fill);
    row.append(heading, element("span", "", formatMs(node.workMs)), bar);
    hotspots.append(row);
  }
}

function renderTree(report) {
  tree.replaceChildren();
  const byParent = new Map();
  for (const node of report.nodes) {
    const key = node.parentId ?? "root";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(node);
  }
  function createNode(node) {
    const item = element("li", "tree-item");
    const details = element("details");
    details.id = `plan-${node.id.replaceAll(".", "-")}`;
    details.open = node.depth < 2;
    const summary = element("summary");
    summary.append(element("span", "tree-name", node.type),
      element("span", "tree-relation", node.relation || node.index),
      element("span", "tree-time", node.workMs === null ? `cost ${formatCount(node.totalCost)}` : formatMs(node.workMs)));
    const detail = element("div", "tree-detail");
    detail.append(element("span", "", `Plan rows ${formatCount(node.planRows)}`),
      element("span", "", `Actual rows/loop ${formatCount(node.actualRows)}`),
      element("span", "", `Loops ${formatCount(node.loops)}`),
      element("span", "", `Shared reads ${formatCount(node.sharedRead)}`));
    if (node.tempWritten !== null) detail.append(element("span", "", `Temp writes ${formatCount(node.tempWritten)}`));
    details.append(summary, detail);
    const children = byParent.get(node.id);
    if (children?.length) {
      const list = element("ul");
      children.forEach((child) => list.append(createNode(child)));
      details.append(list);
    }
    item.append(details);
    return item;
  }
  const list = element("ul", "tree-list");
  list.append(createNode(report.nodes[0]));
  tree.append(list);
}

function analyze() {
  try {
    const report = parsePlan(input.value);
    currentReport = report;
    currentNodes = new Map(report.nodes.map((node) => [node.id, node]));
    metrics.replaceChildren();
    addMetric("Execution", formatMs(report.executionMs), report.executionMs === null ? "Not supplied" : "Query wall time from EXPLAIN");
    addMetric("Nodes", formatCount(report.nodes.length), "Plan operations");
    addMetric("Shared blocks", formatCount(report.rootSharedAccesses), "Root hits + reads; includes children");
    addMetric("Signals", formatCount(report.findings.length), "Heuristics to investigate");
    renderFindings(report);
    renderHotspots(report);
    renderTree(report);
    results.hidden = false;
    setStatus(`${report.nodes.length} nodes analyzed locally. ${report.findings.length} signal${report.findings.length === 1 ? "" : "s"} to inspect.`);
  } catch (error) {
    currentReport = null;
    results.hidden = true;
    setStatus(error instanceof PlanError ? error.message : "This plan could not be analyzed.", true);
  }
}

async function loadExample(name) {
  try {
    input.value = await exampleText(name);
    setExample(name);
    analyze();
    if (name.startsWith("account-")) {
      setStatus(`Recorded ${name === "account-before" ? "before" : "after"} plan loaded. This is a measured local PGlite run, not production traffic.`);
      results.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      setStatus(`Synthetic ${name} example loaded. These numbers are teaching data, not a measured database run.`);
    }
  } catch {
    setStatus("Could not load the example. Try serving the docs directory over HTTP.", true);
  }
}

async function exampleText(name) {
  if (!exampleCache.has(name)) {
    const response = await fetch(`./examples/${name}.json`);
    if (!response.ok) throw new Error("Example unavailable");
    exampleCache.set(name, await response.text());
  }
  return exampleCache.get(name);
}

async function showCaseStudy() {
  try {
    for (const phase of ["before", "after"]) {
      const report = parsePlan(await exampleText(`account-${phase}`));
      const root = report.nodes[0];
      const blocks = root.sharedHit === null || root.sharedRead === null
        ? null : root.sharedHit + root.sharedRead;
      document.querySelector(`#case-${phase}-shape`).textContent = report.nodes.map((node) => node.type).join(" → ");
      document.querySelector(`#case-${phase}-time`).textContent = formatMs(report.executionMs);
      document.querySelector(`#case-${phase}-blocks`).textContent = formatCount(blocks);
    }
  } catch {
    document.querySelector("#case-note").prepend("Recorded examples unavailable. ");
  }
}

document.querySelector("#analyze-button").addEventListener("click", () => { setExample(null); analyze(); });
document.querySelector("#clear-button").addEventListener("click", () => {
  input.value = "";
  fileInput.value = "";
  currentReport = null;
  results.hidden = true;
  setExample(null);
  setStatus("Plan cleared from this tab.");
  input.focus();
});
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  if (file.size > 2_000_000) return setStatus("File exceeds the 2 MB local limit.", true);
  input.value = await file.text();
  setExample(null);
  analyze();
});
for (const name of Object.keys(exampleButtons)) exampleButtons[name].addEventListener("click", () => loadExample(name));
document.querySelector("#copy-button").addEventListener("click", async () => {
  if (!currentReport) return;
  const report = currentReport;
  const summary = ["PlanClinic summary", `Nodes: ${report.nodes.length}`,
    `Execution: ${formatMs(report.executionMs)}`,
    `Shared blocks (root hits + reads, includes children): ${formatCount(report.rootSharedAccesses)}`,
    ...report.findings.map((finding) => `- ${finding.title}: ${finding.evidence}`),
    "Heuristics are investigation prompts, not tuning prescriptions."].join("\n");
  try {
    await navigator.clipboard.writeText(summary);
    setStatus("Short summary copied. Review it before sharing; table or relation names may be included.");
  } catch {
    setStatus("Clipboard unavailable in this browser. The on-screen analysis remains available.", true);
  }
});

loadExample("slow");
showCaseStudy();
