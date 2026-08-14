import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startDashboardServer } from "../server.mjs";
import { CommerceLedger } from "../../packages/commerce/src/ledger.js";
import { CommerceService } from "../../packages/commerce/src/service.js";

const dashboardPort = Number(process.env.HATCH_E2E_PORT ?? 18_500);
const registryPort = Number(process.env.HATCH_E2E_REGISTRY_PORT ?? dashboardPort + 1);
const accessServiceToken = "e2e-registry-access-secret";
const commerceServiceToken = "e2e-runtime-commerce-secret";
const controlToken = "hatch-commerce-v2-e2e-control";
const CREATOR_ID = "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21";
const PUBLIC_PRODUCT_ID = "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42";
const PAGINATION_PRODUCT_ID = "d4b6f3a1-2c87-4e59-9a10-6b7c8d9e0f12";
const BLOCKED_PRODUCT_ID = "b7c1d2e3-4f56-4789-a012-3456789abcde";
const BROWSER_PRODUCT_IDS = [
  "c1e2f3a4-5b67-4890-ab12-3456789def01",
  "c2e3f4a5-6b78-4901-bc23-456789def012"
];
const corpusDigest = `sha256:${"a".repeat(64)}`;
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-e2e-"));
const accounts = new Map([
  ["buyer@example.test", { id: "a4f1c2d3-5678-4a90-bcde-1234567890ab", role: "user", display_name: "Jordan Buyer", password: "buyer-password", token: "buyer-e2e-token" }],
  ["creator@example.test", { id: CREATOR_ID, role: "creator", display_name: "Maya Creator", password: "creator-password", token: "creator-e2e-token" }]
]);
const accountsByToken = new Map([...accounts.values()].map((account) => [account.token, account]));
const access = new Map();
const factoryAnswerSubmissions = [];
let dashboard;
let lastReleaseActivation = null;
let failNextReleaseActivation = false;
let offerControlSequence = 0;

const baseAgent = {
  creator_id: CREATOR_ID,
  creator_name: "Maya Creator",
  creator_verified: true,
  agent_id: PUBLIC_PRODUCT_ID,
  product_id: PUBLIC_PRODUCT_ID,
  product_name: "Signal Resume Review",
  product_description: "Turn a real resume into an evidence-backed rewrite plan.",
  product_promise: "Find the strongest credible signal without inventing evidence.",
  product_boundaries: ["Does not invent employers, metrics, or outcomes."],
  corpus_digest: corpusDigest,
  status: "published",
  published_at: "2026-08-12T08:00:00.000Z",
  product_offer: {
    offer_id: "e4f5a6b7-8c90-4d12-a345-6789abcdef01",
    revision: 1,
    model: "per_delivery",
    purchase_model: "per_delivery",
    amount_minor: 0,
    currency: "USD",
    unit: "delivery",
    included_units: 1,
    refund_policy_version: "free-v1",
    version_policy: "pinned",
    status: "active"
  },
  presentation: {
    inputs: ["A resume and target role"],
    outputs: ["Evidence-backed rewrite plan"],
    privacy_copy: "Your Workspace files and conversation stay out of Creator commerce views."
  }
};
const agents = new Map([[baseAgent.product_id, baseAgent]]);
const factoryRuns = new Map([
  ...BROWSER_PRODUCT_IDS.flatMap((productId, retry) => {
    return [
      factoryRun({ productId, version: 1, retry }),
      factoryRun({ productId, version: 2, retry })
    ];
  }).map((run) => [run.id, run]),
  ["factory_blocked_browser", factoryRun({
    productId: BLOCKED_PRODUCT_ID,
    version: 1,
    retry: "blocked",
    verified: false,
    failedCriticalCases: 1
  })],
  ["factory_question_replacement", factoryQuestionRun()]
]);

const registry = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://registry.e2e");
    if (url.pathname.startsWith("/__e2e/")) {
      if (request.headers["x-hatch-e2e-control"] !== controlToken) {
        return json(response, 404, { detail: "Not found." });
      }
      if (request.method === "POST" && url.pathname === "/__e2e/offer") {
        const body = await readJson(request);
        const current = agents.get(String(body.product_id));
        if (!current) return json(response, 404, { detail: "Product not found." });
        current.product_offer = { ...current.product_offer, ...body.offer };
        const offer = current.product_offer;
        const existingOffer = dashboard.commerce.getOfferRevision(offer.offer_id, offer.revision);
        if (!existingOffer) {
          await dashboard.commerce.createOfferRevision({
            ...offer,
            creator_id: current.creator_id,
            product_id: current.product_id,
            idempotency_key: `e2e-offer:${current.product_id}:${offer.revision}`
          });
        } else if (Number(existingOffer.amount_minor) !== Number(offer.amount_minor)
          || existingOffer.currency !== offer.currency) {
          return json(response, 409, { detail: "Control offer revision conflicts with the immutable Commerce revision." });
        }
        const operationId = `e2e-offer-activation:${current.product_id}:${offer.revision}:${++offerControlSequence}`;
        const active_offer = await dashboard.commerce.activateOfferRevision({
          offer_id: offer.offer_id,
          revision: offer.revision,
          creator_id: current.creator_id,
          product_id: current.product_id,
          release_id: current.corpus_digest,
          corpus_digest: current.corpus_digest,
          operation_id: operationId,
          idempotency_key: operationId
        });
        return json(response, 200, { agent: current, active_offer });
      }
      if (request.method === "GET" && url.pathname === "/__e2e/commerce") {
        const buyerId = String(url.searchParams.get("buyer_id") ?? "");
        const events = dashboard?.ledger.listEvents().filter((event) => !buyerId || event.buyer_id === buyerId) ?? [];
        return json(response, 200, {
          events: events.map((event) => ({
            event_id: event.event_id,
            event_type: event.event_type,
            buyer_id: event.buyer_id,
            order_id: event.order_id,
            entitlement_id: event.entitlement_id,
            idempotency_key: event.idempotency_key
          })),
          access: [...access.values()].filter((entry) => !buyerId || entry.user_id === buyerId)
        });
      }
      if (request.method === "GET" && url.pathname === "/__e2e/product-state") {
        const productId = String(url.searchParams.get("product_id") ?? "");
        return json(response, 200, {
          product: dashboard?.portalState.getCreatorProduct(CREATOR_ID, productId) ?? null,
          last_release_activation: lastReleaseActivation
        });
      }
      if (request.method === "POST" && url.pathname === "/__e2e/fail-next-release-activation") {
        failNextReleaseActivation = true;
        return json(response, 200, { armed: true });
      }
      if (request.method === "POST" && url.pathname === "/__e2e/factory-question-batch") {
        const body = await readJson(request);
        const runId = String(body.run_id ?? "factory_question_replacement");
        const run = factoryRuns.get(runId);
        if (!run) return json(response, 404, { detail: "Factory run not found." });
        const questions = Array.isArray(body.questions) ? body.questions.map((question) => ({
          id: String(question.id),
          question: String(question.question)
        })) : [];
        Object.assign(run, {
          status: "waiting_for_creator",
          stage: "awaiting_creator_answers",
          version: Number(body.version ?? run.version + 1),
          question_batch_id: String(body.question_batch_id ?? ""),
          pending_questions: questions,
          updated_at: new Date().toISOString()
        });
        if (body.reset_submissions) {
          for (let index = factoryAnswerSubmissions.length - 1; index >= 0; index -= 1) {
            if (factoryAnswerSubmissions[index].run_id === runId) factoryAnswerSubmissions.splice(index, 1);
          }
        }
        return json(response, 200, { run });
      }
      if (request.method === "GET" && url.pathname === "/__e2e/factory-answer-submissions") {
        const runId = String(url.searchParams.get("run_id") ?? "");
        return json(response, 200, {
          submissions: factoryAnswerSubmissions.filter((submission) => !runId || submission.run_id === runId)
        });
      }
      return json(response, 404, { detail: `E2E control route not found: ${request.method} ${url.pathname}` });
    }
    if (request.method === "GET" && ["/healthz", "/readyz"].includes(url.pathname)) {
      return json(response, 200, { status: "ok" });
    }
    if (request.method === "POST" && url.pathname === "/v1/auth/signin") {
      const body = await readJson(request);
      const account = accounts.get(String(body.email ?? ""));
      if (!account || account.password !== body.password) return json(response, 401, { detail: "Email or password is incorrect." });
      return json(response, 200, { token: account.token, account: publicAccount(account) });
    }
    if (request.method === "POST" && url.pathname === "/v1/auth/signup") {
      const body = await readJson(request);
      const email = String(body.email ?? "");
      if (accounts.has(email)) return json(response, 409, { detail: "Email is already registered." });
      const account = {
        id: randomUUID(),
        role: "user",
        display_name: String(body.display_name ?? "New Buyer"),
        password: String(body.password ?? ""),
        token: `buyer-e2e-token-${accounts.size + 1}`
      };
      accounts.set(email, account);
      accountsByToken.set(account.token, account);
      return json(response, 201, { token: account.token, account: publicAccount(account) });
    }
    if (request.method === "GET" && url.pathname === "/v1/auth/me") {
      const account = authenticatedAccount(request);
      return account
        ? json(response, 200, publicAccount(account))
        : json(response, 401, { detail: "A valid account token is required." });
    }
    if (request.method === "GET" && url.pathname === "/v1/public/products") {
      return json(response, 200, [...agents.values()].filter((entry) => entry.status === "published"));
    }
    const publicCreatorMatch = url.pathname.match(/^\/v1\/public\/creators\/([^/]+)$/);
    if (request.method === "GET" && publicCreatorMatch) {
      const creatorId = decodeURIComponent(publicCreatorMatch[1]);
      const products = [...agents.values()].filter((entry) => entry.status === "published" && entry.creator_id === creatorId);
      if (!products.length) return json(response, 404, { detail: "Creator not found." });
      return json(response, 200, {
        creator: { id: creatorId, name: products[0].creator_name },
        products
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/creator/products") {
      const account = authenticatedAccount(request);
      return account?.role === "creator" ? json(response, 200, [...agents.values()]) : json(response, 401, { detail: "Creator token required." });
    }
    if (request.method === "GET" && url.pathname === "/v1/creator/factory-runs") {
      const account = authenticatedAccount(request);
      return account?.role === "creator" ? json(response, 200, { runs: [...factoryRuns.values()] }) : json(response, 401, { detail: "Creator token required." });
    }
    if (request.method === "POST" && url.pathname === "/v1/creator/factory-runs") {
      const account = authenticatedAccount(request);
      if (account?.role !== "creator") return json(response, 401, { detail: "Creator token required." });
      const body = await readJson(request);
      const productId = String(body.task_name ?? "").trim();
      if (!productId) return json(response, 422, { detail: "task_name is required." });
      const runId = `factory_${productId.replaceAll("-", "_")}_v1`;
      const run = factoryRuns.get(runId) ?? factoryRun({ productId, version: 1, retry: "source" });
      run.task_name = productId;
      run.task_brief = String(body.task_brief ?? "");
      run.sources = Array.isArray(body.sources) ? body.sources : [];
      factoryRuns.set(run.id, run);
      return json(response, 202, run);
    }
    const factoryRunMatch = url.pathname.match(/^\/v1\/creator\/factory-runs\/([^/]+)$/);
    if (request.method === "GET" && factoryRunMatch) {
      const account = authenticatedAccount(request);
      if (account?.role !== "creator") return json(response, 401, { detail: "Creator token required." });
      const run = factoryRuns.get(decodeURIComponent(factoryRunMatch[1]));
      return run ? json(response, 200, run) : json(response, 404, { detail: "Factory run not found." });
    }
    const factoryAnswersMatch = url.pathname.match(/^\/v1\/creator\/factory-runs\/([^/]+)\/answers$/);
    if (request.method === "PUT" && factoryAnswersMatch) {
      const account = authenticatedAccount(request);
      if (account?.role !== "creator") return json(response, 401, { detail: "Creator token required." });
      const runId = decodeURIComponent(factoryAnswersMatch[1]);
      const run = factoryRuns.get(runId);
      if (!run) return json(response, 404, { detail: "Factory run not found." });
      const body = await readJson(request);
      if (Number(body.expected_version) !== Number(run.version)) {
        return json(response, 409, { detail: "Factory run version changed." });
      }
      if (String(body.question_batch_id ?? "") !== String(run.question_batch_id ?? "")) {
        return json(response, 409, { detail: "Factory question batch changed." });
      }
      const expectedQuestionIds = run.pending_questions.map((question) => question.id);
      const answers = Array.isArray(body.answers) ? body.answers.map((answer) => ({
        question_id: String(answer.question_id),
        answer: String(answer.answer ?? "")
      })) : [];
      if (answers.length !== expectedQuestionIds.length || answers.some((answer, index) => answer.question_id !== expectedQuestionIds[index])) {
        return json(response, 422, { detail: "Every current Factory question must be answered in order." });
      }
      factoryAnswerSubmissions.push({
        run_id: runId,
        expected_version: Number(body.expected_version),
        submission_id: String(body.submission_id ?? ""),
        question_batch_id: String(body.question_batch_id),
        answers
      });
      Object.assign(run, {
        status: "running",
        stage: "compiling_corpus",
        version: run.version + 1,
        pending_questions: [],
        updated_at: new Date().toISOString()
      });
      return json(response, 202, run);
    }
    const factoryPublishMatch = url.pathname.match(/^\/v1\/creator\/factory-runs\/([^/]+)\/publish$/);
    if (request.method === "POST" && factoryPublishMatch) {
      const account = authenticatedAccount(request);
      if (account?.role !== "creator") return json(response, 401, { detail: "Creator token required." });
      const run = factoryRuns.get(decodeURIComponent(factoryPublishMatch[1]));
      if (!run) return json(response, 404, { detail: "Factory run not found." });
      const body = await readJson(request);
      if (body.corpus_digest !== run.candidate.corpus_digest) return json(response, 409, { detail: "Candidate digest changed." });
      const published = publishedAgent(run);
      agents.set(published.product_id, published);
      return json(response, 201, published);
    }
    const activateReleaseMatch = url.pathname.match(/^\/v1\/creator\/agent-corpora\/([^/]+)\/releases\/([^/]+)\/activate$/);
    if (request.method === "POST" && activateReleaseMatch) {
      const account = authenticatedAccount(request);
      if (account?.role !== "creator") return json(response, 401, { detail: "Creator token required." });
      if (failNextReleaseActivation) {
        failNextReleaseActivation = false;
        return json(response, 503, { detail: "Injected Registry activation outage." });
      }
      const body = await readJson(request);
      const agentId = decodeURIComponent(activateReleaseMatch[1]);
      const product = [...agents.values()].find((entry) => entry.agent_id === agentId);
      if (!product) return json(response, 404, { detail: "Published product not found." });
      const digest = decodeURIComponent(activateReleaseMatch[2]);
      product.corpus_digest = digest;
      lastReleaseActivation = {
        agent_id: agentId,
        product_id: product.product_id,
        release_id: body.release_id,
        corpus_digest: digest
      };
      return json(response, 200, { ...lastReleaseActivation, status: "active" });
    }
    if (request.method === "GET" && url.pathname === "/v1/user/product-access") {
      const account = authenticatedAccount(request);
      if (!account) return json(response, 401, { detail: "Account token required." });
      return json(response, 200, [...access.values()].filter((entry) => entry.user_id === account.id && entry.status === "active"));
    }
    const grant = url.pathname.match(/^\/v1\/user\/products\/([^/]+)\/access$/);
    if (request.method === "POST" && grant) {
      if (bearer(request) !== accessServiceToken) return json(response, 403, { detail: "Access service token required." });
      const body = await readJson(request);
      const record = {
        user_id: String(body.user_id),
        creator_id: String(body.creator_id),
        agent_id: decodeURIComponent(grant[1]),
        product_id: decodeURIComponent(grant[1]),
        order_id: String(body.order_id),
        entitlement_id: String(body.entitlement_id),
        purchased_corpus_digest: String(body.purchased_corpus_digest),
        status: "active"
      };
      access.set(record.entitlement_id, record);
      return json(response, 201, record);
    }
    const revoke = url.pathname.match(/^\/v1\/user\/product-access\/([^/]+)$/);
    if (request.method === "DELETE" && revoke) {
      if (bearer(request) !== accessServiceToken) return json(response, 403, { detail: "Access service token required." });
      const body = await readJson(request);
      const entitlementId = decodeURIComponent(revoke[1]);
      const existing = access.get(entitlementId);
      if (!existing || existing.user_id !== body.user_id) return json(response, 404, { detail: "Entitlement not found." });
      const revoked = { ...existing, status: "revoked" };
      access.set(entitlementId, revoked);
      return json(response, 200, revoked);
    }
    return json(response, 404, { detail: `Registry E2E route not found: ${request.method} ${url.pathname}` });
  } catch (error) {
    return json(response, 500, { detail: error instanceof Error ? error.message : String(error) });
  }
});

await listen(registry, registryPort);
const registryAddress = registry.address();
if (!registryAddress || typeof registryAddress === "string") throw new Error("E2E Registry did not bind a TCP port");

const ledgerPath = path.join(temporaryDirectory, "commerce.jsonl");
const ledger = await CommerceLedger.open({ filePath: ledgerPath });
await seedCreatorOrders(new CommerceService(ledger));
dashboard = await startDashboardServer({
  host: "127.0.0.1",
  port: dashboardPort,
  publicOrigin: `http://127.0.0.1:${dashboardPort}`,
  registryUrl: `http://127.0.0.1:${registryAddress.port}`,
  ledger,
  ledgerPath,
  portalStatePath: path.join(temporaryDirectory, "portal-state.json"),
  registryAccessServiceToken: accessServiceToken,
  commerceRuntimeServiceToken: commerceServiceToken,
  paymentMode: "disabled"
});

console.log(`Hatch dashboard E2E ready at http://127.0.0.1:${dashboardPort}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.all([
    closeServer(dashboard.server),
    closeServer(registry)
  ]);
  await rm(temporaryDirectory, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void close().finally(() => process.exit(0)); });
}

function authenticatedAccount(request) {
  return accountsByToken.get(bearer(request));
}

function bearer(request) {
  const value = String(request.headers.authorization ?? "");
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function publicAccount(account) {
  return { id: account.id, role: account.role, display_name: account.display_name };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function factoryRun({ productId, version, retry, verified = true, failedCriticalCases = 0 }) {
  const suffix = String(retry);
  const digestCharacter = verified ? String((Number(version) + 1) % 10) : "f";
  return {
    id: verified ? `factory_${productId.replaceAll("-", "_")}_v${version}` : "factory_blocked_browser",
    agent_id: productId,
    status: "ready",
    factory_version: "browser-e2e-factory-v1",
    updated_at: `2026-08-12T0${Math.min(9, Number(version) || 1)}:00:00.000Z`,
    product: {
      id: productId,
      name: verified ? `Browser Commerce Flow ${suffix}` : "Blocked Browser Product",
      description: verified
        ? "A browser-tested Creator product with a durable release history."
        : "A product whose candidate must remain blocked.",
      promise: verified
        ? "Turn an approved method into a shareable, immutable delivery."
        : "This promise cannot be published until critical gates pass.",
      boundaries: verified
        ? ["Does not expose Buyer Workspace content."]
        : ["Does not bypass failed evaluation gates."]
    },
    candidate: {
      version,
      corpus_digest: `sha256:${digestCharacter.repeat(64)}`,
      system_digest: `sha256:${String((Number(version) + 4) % 10 || 4).repeat(64)}`,
      corpus_verified: verified,
      regression_digest: `sha256:${"b".repeat(64)}`,
      held_out_digest: `sha256:${"c".repeat(64)}`,
      held_out_sample_count: 12,
      failed_critical_cases: failedCriticalCases,
      factory_version: "browser-e2e-factory-v1",
      material_changes: [`Candidate v${version} uses the reviewed Browser E2E behavior.`],
      known_losses: verified && version === 1
        ? [{ id: "loss-style", title: "Minor stylistic compression", description: "Some long explanations are shorter." }]
        : []
    }
  };
}

function factoryQuestionRun() {
  return {
    id: "factory_question_replacement",
    task_name: "Question batch replacement",
    task_brief: "Prove that stale Creator answers never cross a Factory question-batch boundary.",
    status: "waiting_for_creator",
    stage: "awaiting_creator_answers",
    version: 1,
    question_batch_id: "browser-question-batch-1",
    pending_questions: [{
      id: "old-reference-answer",
      question: "What evidence should the first draft prioritize?"
    }],
    updated_at: "2026-08-12T08:30:00.000Z"
  };
}

function publishedAgent(run) {
  return {
    creator_id: CREATOR_ID,
    creator_name: "Maya Creator",
    creator_verified: true,
    agent_id: run.agent_id,
    product_id: run.product.id,
    product_name: run.product.name,
    product_description: run.product.description,
    product_promise: run.product.promise,
    product_boundaries: run.product.boundaries,
    corpus_digest: run.candidate.corpus_digest,
    status: "published",
    published_at: new Date().toISOString(),
    presentation: {
      inputs: ["An approved Creator method"],
      outputs: ["A browser-verified delivery"],
      privacy_copy: "Buyer Workspace content remains private."
    }
  };
}

async function seedCreatorOrders(commerce) {
  for (let index = 1; index <= 13; index += 1) {
    await commerce.confirmCheckout({
      buyer_id: randomUUID(),
      buyer_display_name: `Pagination Buyer ${index}`,
      creator_id: CREATOR_ID,
      creator_display_name: "Maya Creator",
      agent_id: PAGINATION_PRODUCT_ID,
      product_id: PAGINATION_PRODUCT_ID,
      product_name: "Pagination Product",
      corpus_digest: `sha256:${"d".repeat(64)}`,
      release_id: `sha256:${"d".repeat(64)}`,
      offer_id: "e9f0a1b2-c3d4-4567-8901-23456789abcd",
      offer_revision: 1,
      offer_snapshot: {
        offer_id: "e9f0a1b2-c3d4-4567-8901-23456789abcd",
        revision: 1,
        purchase_model: "per_delivery",
        amount_minor: 0,
        currency: "USD",
        included_units: 1,
        unit: "delivery"
      },
      gross_minor: 0,
      currency: "USD",
      included_units: 1,
      version_policy: "pinned",
      refund_policy_version: "free-v1"
    }, { idempotencyKey: `e2e-pagination-order-${index}` });
  }
}
