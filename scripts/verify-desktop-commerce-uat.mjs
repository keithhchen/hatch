import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommerceLedger, projectCreatorDashboard } from "../packages/commerce/src/index.js";

const options = parseOptions(process.argv.slice(2));
const stateRoot = required(options["state-root"], "--state-root");
const artifactPath = required(options.artifact, "--artifact");
const outputPath = required(options.output, "--output");

const [entitlements, artifactBytes, ledger] = await Promise.all([
  readJson(path.join(stateRoot, "entitlements.json")),
  readFile(artifactPath),
  CommerceLedger.open({ filePath: path.join(stateRoot, "commerce-ledger.jsonl") })
]);

if (!Array.isArray(entitlements) || entitlements.length !== 1) {
  throw new Error("Desktop commerce UAT expects exactly one buyer entitlement");
}
const entitlement = entitlements[0];
const events = ledger.listEvents();
const expectedEvents = [
  "order.placed",
  "entitlement.granted",
  "task.started",
  "artifact.created",
  "delivery.completed",
  "revenue.recognized"
];
const actualEvents = events.map((event) => event.event_type);
const artifact = events.find((event) => event.event_type === "artifact.created");
const delivery = events.find((event) => event.event_type === "delivery.completed");
const revenue = events.find((event) => event.event_type === "revenue.recognized");
const order = events.find((event) => event.event_type === "order.placed");
if (!artifact || !delivery || !revenue || !order) throw new Error("Desktop commerce UAT ledger is incomplete");

const artifactDigest = `sha256:${createHash("sha256").update(artifactBytes).digest("hex")}`;
const dashboard = projectCreatorDashboard(events, entitlement.creator_id);
const dashboardOrder = dashboard.orders.find((entry) => entry.order_id === entitlement.order_id);
const allBound = events.every((event) =>
  event.order_id === entitlement.order_id
  && event.release_id === entitlement.release_id
  && event.release_digest === entitlement.release_digest
);
const checks = {
  one_entitlement: true,
  event_sequence: JSON.stringify(actualEvents) === JSON.stringify(expectedEvents),
  exact_release_binding: allBound,
  artifact_digest_matches_local_bytes: artifact.artifact_digest === artifactDigest,
  delivery_links_artifact: delivery.artifact_id === artifact.artifact_id,
  revenue_links_delivery: revenue.delivery_id === delivery.delivery_id,
  split_is_90_10: revenue.gross_minor === order.gross_minor
    && revenue.creator_share_minor === Math.floor(order.gross_minor * 0.9)
    && revenue.hatch_share_minor === order.gross_minor - Math.floor(order.gross_minor * 0.9),
  dashboard_projects_same_delivery: dashboardOrder?.status === "delivered"
    && dashboardOrder.artifact_digest === artifactDigest
    && dashboard.metrics.successful_deliveries === 1
    && dashboard.metrics.creator_share_minor === revenue.creator_share_minor
    && dashboard.metrics.hatch_share_minor === revenue.hatch_share_minor
};
const passed = Object.values(checks).every(Boolean);
if (!passed) throw new Error(`Desktop commerce UAT verification failed: ${JSON.stringify(checks)}`);

const report = {
  kind: "hatch-v1-installed-desktop-commerce-uat",
  passed,
  release: {
    release_id: entitlement.release_id,
    release_digest: entitlement.release_digest,
    product_id: entitlement.product_id,
    creator_id: entitlement.creator_id
  },
  buyer: {
    user_id: entitlement.user_id,
    order_id: entitlement.order_id,
    entitlement_id: entitlement.entitlement_id
  },
  desktop: {
    packaged_app: "Hatch Desktop Commerce UAT.app",
    local_artifact: {
      filename: path.basename(artifactPath),
      bytes: artifactBytes.length,
      digest: artifactDigest
    },
    policy: "Workspace reads were limited to Jordan's granted folder; writing the delivery required Jordan's explicit approval."
  },
  commerce: {
    task_id: artifact.task_id,
    artifact_id: artifact.artifact_id,
    delivery_id: delivery.delivery_id,
    recognition_id: revenue.recognition_id,
    event_sequence: actualEvents,
    gross_minor: revenue.gross_minor,
    creator_share_minor: revenue.creator_share_minor,
    hatch_share_minor: revenue.hatch_share_minor,
    currency: revenue.currency
  },
  dashboard: {
    metrics: dashboard.metrics,
    order: dashboardOrder
  },
  checks
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ passed, output: outputPath, release: report.release, commerce: report.commerce }, null, 2));

function parseOptions(args) {
  const output = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    output[key.slice(2)] = value;
  }
  return output;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
