import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { SystemBrowser } from "./browser.js";
import { HatchClient } from "./client.js";
import { FileCredentialStore } from "./credentialStore.js";
import { LoopbackReceiver } from "./loopback.js";

export const DEFAULT_URL = "https://gethatchapp.com";

// Everything a command may touch, injected so commands stay pure of process globals.
export class HatchContext {
  constructor({
    env = {}, fetch = globalThis.fetch, store, browser, stdin, stdout, stderr, cwd = process.cwd(), home,
    sleep = (ms) => delay(ms), receiverFactory = (opts) => new LoopbackReceiver(opts),
    json = false, profile = "default", pollMs = 5000
  }) {
    Object.assign(this, { env, fetch, store, browser, stdin, stdout, stderr, cwd, home, sleep, receiverFactory, json, profile, pollMs });
    this.exitCode = 0;
  }

  get apiUrl() { return this.env.HATCH_API_URL || DEFAULT_URL; }
  get webUrl() { return this.env.HATCH_WEB_URL || this.apiUrl; }

  // Resolved credentials: HATCH_API_KEY overrides the stored profile.
  async credentials() {
    const stored = await this.store.get(this.profile);
    const apiUrl = this.env.HATCH_API_URL || stored?.api_url || DEFAULT_URL;
    if (this.env.HATCH_API_KEY) return { api_url: apiUrl, token: this.env.HATCH_API_KEY, kind: "api_key", account: null, source: "env" };
    return stored ? { ...stored, api_url: apiUrl, source: "file" } : null;
  }

  clientWith(token, apiUrl = this.apiUrl) { return HatchClient.create({ baseUrl: apiUrl, fetch: this.fetch, token }); }
  anonymousClient(apiUrl = this.apiUrl) { return HatchClient.create({ baseUrl: apiUrl, fetch: this.fetch, authenticated: false }); }

  async client() {
    const creds = await this.credentials();
    return this.clientWith(creds?.token ?? null, creds?.api_url ?? this.apiUrl);
  }

  print(text) { this.stdout.write(`${text}\n`); }
  log(text) { this.stderr.write(`${text}\n`); }
}

export function realDeps() {
  const home = process.env.HOME || homedir();
  return {
    env: process.env, fetch: globalThis.fetch, home, cwd: process.cwd(),
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
    store: FileCredentialStore.atHome(home), browser: new SystemBrowser()
  };
}
