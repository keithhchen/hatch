/** One event of a Kimi session, as the platform sends it. */
export type KimiEvent = { id?: string; type?: string; data?: any };

export type KimiArtifact = { id: string; name: string; createdAt?: string };

/** What the Runtime does on Kimi Hosted Agents: the platform's session API and nothing else. */
export interface KimiHostedApi {
  createSession(input: { title: string }): Promise<{ id: string }>;
  sendUserMessage(sessionId: string, text: string): Promise<void>;
  /** The session's state, whatever the stream says: the way to learn it ended while this process was away. */
  getSession(sessionId: string): Promise<{ status: string; stopReason?: string }>;
  /** Events after `cursor` (all of them when absent); the stream ends when the connection does. */
  stream(sessionId: string, cursor: string | undefined, signal: AbortSignal): AsyncGenerator<{ cursor?: string; event: KimiEvent }>;
  listArtifacts(sessionId: string): Promise<KimiArtifact[]>;
  artifactContent(artifactId: string): Promise<Buffer>;
  interrupt(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
}

/** The platform could not be asked, or refused: a Run's failure, never a success. */
export class KimiHostedError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "KimiHostedError"; }
}

export type KimiHostedConfig = { apiKey: string; baseUrl: string; agentId: string; environmentId: string; vaultId?: string };

/** KIMI_HOSTED_API_KEY (or LLM_API_KEY), KIMI_HOSTED_AGENT_ID, KIMI_HOSTED_ENVIRONMENT_ID, optional KIMI_HOSTED_VAULT_ID and KIMI_HOSTED_BASE_URL. Undefined when the ids or the key are missing. */
export function kimiHostedConfigFromEnvironment(environment: NodeJS.ProcessEnv): KimiHostedConfig | undefined {
  const value = (name: string) => environment[name]?.trim() || undefined;
  const apiKey = value("KIMI_HOSTED_API_KEY") ?? value("LLM_API_KEY"), agentId = value("KIMI_HOSTED_AGENT_ID"), environmentId = value("KIMI_HOSTED_ENVIRONMENT_ID");
  if (!apiKey || !agentId || !environmentId) return undefined;
  return { apiKey, agentId, environmentId, baseUrl: value("KIMI_HOSTED_BASE_URL") ?? "https://api.moonshot.cn/v1", ...value("KIMI_HOSTED_VAULT_ID") ? { vaultId: value("KIMI_HOSTED_VAULT_ID") } : {} };
}

const RETRIES = 4;

export class HttpKimiHostedApi implements KimiHostedApi {
  constructor(private readonly config: KimiHostedConfig, private readonly fetcher: typeof fetch = fetch) {}

  private headers(json: boolean): Record<string, string> {
    return { authorization: `Bearer ${this.config.apiKey}`, "kimi-api-version": "2026-09-01-beta", ...json ? { "content-type": "application/json" } : {} };
  }

  /** A call with a few retries on 429 and 5xx; any other refusal is final and carries the platform's own message (never the key). */
  private async call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await this.fetcher(this.config.baseUrl + path, { method, headers: this.headers(body !== undefined), ...body !== undefined ? { body: JSON.stringify(body) } : {}, ...signal ? { signal } : {} });
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt >= RETRIES) throw new KimiHostedError("kimi_unreachable", `Kimi Hosted Agents could not be reached: ${(error as Error).message}`);
      }
      const retryable = !response || response.status >= 500 || response.status === 429;
      if (response && (response.ok || !retryable || attempt >= RETRIES)) {
        if (response.ok) return response;
        throw new KimiHostedError(`kimi_http_${response.status}`, `${method} ${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }

  async createSession({ title }: { title: string }) {
    const body = { agent_id: this.config.agentId, environment_id: this.config.environmentId, title, ...this.config.vaultId ? { resources: [{ type: "vault", vault_id: this.config.vaultId }] } : {} };
    const session = await (await this.call("POST", "/sessions", body)).json() as { id?: string };
    if (!session.id) throw new KimiHostedError("kimi_bad_answer", "Creating a session returned no id.");
    return { id: session.id };
  }

  async sendUserMessage(sessionId: string, text: string) {
    await this.call("POST", `/sessions/${sessionId}/events`, { events: [{ type: "user.message", data: { content: [{ type: "text", text }] } }] });
  }

  async getSession(sessionId: string) {
    const session = await (await this.call("GET", `/sessions/${sessionId}`)).json() as { status?: string; stop_reason?: { type?: string } };
    return { status: session.status ?? "unknown", ...session.stop_reason?.type ? { stopReason: session.stop_reason.type } : {} };
  }

  async *stream(sessionId: string, cursor: string | undefined, signal: AbortSignal) {
    const response = await this.call("GET", `/sessions/${sessionId}/events/stream${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, signal);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let id: string | undefined, name: string | undefined, data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data || name === "control") continue;
        let event: KimiEvent;
        try { event = JSON.parse(data) as KimiEvent; } catch { continue; }
        if (name === "error") event = { type: "stream.error", data: event };
        yield { ...id ? { cursor: id } : {}, event };
      }
    }
  }

  async listArtifacts(sessionId: string) {
    const found: KimiArtifact[] = [];
    let token: string | undefined;
    do {
      const page = await (await this.call("GET", `/artifacts?session_id=${encodeURIComponent(sessionId)}&page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`)).json() as { items?: Array<{ id: string; name: string; delivered_at?: string; created_at?: string }>; next_page_token?: string };
      // The platform stamps an artifact with delivered_at (observed on the real API); created_at is accepted too.
      for (const item of page.items ?? []) { const at = item.delivered_at ?? item.created_at; found.push({ id: item.id, name: item.name, ...at ? { createdAt: at } : {} }); }
      token = page.next_page_token || undefined;
    } while (token);
    return found;
  }

  async artifactContent(artifactId: string) {
    return Buffer.from(await (await this.call("GET", `/artifacts/${artifactId}/content`)).arrayBuffer());
  }

  async interrupt(sessionId: string) {
    await this.call("POST", `/sessions/${sessionId}/events`, { events: [{ type: "user.interrupt" }] });
  }

  async archive(sessionId: string) {
    await this.call("POST", `/sessions/${sessionId}/archive`);
  }
}
