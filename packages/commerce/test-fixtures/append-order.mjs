import { access } from "node:fs/promises";
import { CommerceLedger } from "../src/index.js";

const [filePath, startFile, idempotencyKey, orderId] = process.argv.slice(2);
if (!filePath || !startFile || !idempotencyKey || !orderId) {
  throw new Error("filePath, startFile, idempotencyKey, and orderId are required");
}

const ledger = await CommerceLedger.open({ filePath });
process.stdout.write("READY\n");
while (true) {
  try {
    await access(startFile);
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

try {
  const event = await ledger.append("order.placed", {
    order_id: orderId,
    buyer_id: "buyer_concurrent",
    buyer_display_name: "Concurrent Buyer",
    creator_id: "creator_concurrent",
    agent_id: "agent_concurrent",
    product_id: "product_concurrent",
    corpus_digest: `sha256:${"d".repeat(64)}`,
    gross_minor: 4900,
    currency: "USD"
  }, { idempotencyKey });
  process.stdout.write(`${JSON.stringify({ ok: true, event })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    code: error?.code,
    message: error instanceof Error ? error.message : String(error)
  })}\n`);
  process.exitCode = 1;
}
