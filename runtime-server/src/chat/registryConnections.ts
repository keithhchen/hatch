import type { Connection } from "../surfaces/contract.js";
import type { ConnectionDirectory } from "./contactBinding.js";

/**
 * The channel layer lives in the Registry process, so a Connection is read from there with the Runtime's service token
 * every time a contact's message binds: a revoked Connection stops serving at once, with no copy here to go stale.
 */
export class RegistryConnectionDirectory implements ConnectionDirectory {
  constructor(private readonly options: { registryUrl: string; serviceToken: string; timeoutMs?: number; fetch?: typeof fetch }) {}

  async get(connectionId: string): Promise<Connection | undefined> {
    const response = await (this.options.fetch ?? fetch)(`${this.options.registryUrl.replace(/\/$/, "")}/v1/runtime/connections/${encodeURIComponent(connectionId)}`, {
      headers: { authorization: `Bearer ${this.options.serviceToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000)
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Registry refused the Connection lookup: HTTP ${response.status}`);
    return ((await response.json()) as { connection: Connection }).connection;
  }
}
