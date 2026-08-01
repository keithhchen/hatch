import { FileEntitlementResolver } from "./entitlements.js";
import { createRuntimeServer } from "./index.js";
import { CreatorReleaseResolver } from "./release.js";

const releasesDirectory = requiredEnvironment("HATCH_RELEASES_DIR");
const entitlementsFile = requiredEnvironment("HATCH_ENTITLEMENTS_FILE");
const commerceLedgerFile = requiredEnvironment("HATCH_COMMERCE_LEDGER_FILE");
const port = Number(process.env.PORT ?? 8400);
const { CommerceLedger, LedgerCommerceSink } = await import(new URL("../../packages/commerce/src/index.js", import.meta.url).href) as {
  CommerceLedger: { open(options: { filePath: string }): Promise<any> };
  LedgerCommerceSink: new (ledger: any) => { ingest(type: string, payload: Record<string, unknown>, options: { idempotencyKey: string }): Promise<unknown> };
};
const ledger = await CommerceLedger.open({ filePath: commerceLedgerFile });
const recognizedSink = new LedgerCommerceSink(ledger);
const sink: import("./delivery.js").CommerceEventSink = {
  append: (type, payload, options) => recognizedSink.ingest(type, payload, options),
  findByIdempotencyKey: (key) => ledger.findByIdempotencyKey(key)
};

const runtime = createRuntimeServer({
  releaseResolver: new CreatorReleaseResolver(releasesDirectory),
  entitlementResolver: new FileEntitlementResolver(entitlementsFile),
  commerceEventSink: sink
});

runtime.server.listen(port, "127.0.0.1", () => {
  console.log(`Hatch Consumer Runtime listening on ws://127.0.0.1:${port}/runtime`);
  console.log(`Creator Releases: ${releasesDirectory}`);
  console.log(`Entitlements: ${entitlementsFile}`);
  console.log(`Commerce ledger: ${commerceLedgerFile}`);
});

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
