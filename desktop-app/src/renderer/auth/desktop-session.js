import { fetchAgents } from "../agents/agent-directory.js";
import { isAuthInvalid } from "../http.js";
import { Observable } from "../observable.js";

/**
 * The window's account state. Two identities only — signed out or signed in;
 * "loading" and "unreachable" are transport states of a signed-in shell, so
 * the shell renders immediately on launch and keeps its sidebar when offline.
 *
 * state: { phase: "launching" | "signed-out" | "signed-in",
 *          token, account, agents, agentsStatus: "loading" | "ready" | "error", error }
 */
export class DesktopSession extends Observable {
  constructor({ tokens, accounts, fetchAgentsImpl = fetchAgents }) {
    super({ phase: "launching", token: null, account: null, agents: [], agentsStatus: "loading", error: null });
    Object.assign(this, { tokens, accounts, fetchAgentsImpl });
    this.refreshing = null;
  }

  async launch() {
    let token = null;
    try {
      token = await this.tokens.read();
    } catch {
      token = null;
    }
    if (!token) {
      this.setState({ phase: "signed-out", token: null, account: null, agents: [], error: null });
      return;
    }
    this.setState({ phase: "signed-in", token, agentsStatus: "loading", error: null });
    await this.refresh();
  }

  /** Re-read identity and Agents; keeps what is on screen while it runs. */
  refresh() {
    const token = this.state.token;
    if (!token) return Promise.resolve();
    this.refreshing ??= (async () => {
      try {
        const account = await this.accounts.me(token);
        const agents = await this.fetchAgentsImpl(token);
        if (this.state.token === token) this.setState({ account, agents, agentsStatus: "ready", error: null });
      } catch (error) {
        if (this.state.token !== token) return;
        if (isAuthInvalid(error)) await this.expire();
        else this.setState({ agentsStatus: this.state.agents.length ? "ready" : "error", error });
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** The Registry rejected the token: drop it, back to signed out. */
  async expire() {
    await this.tokens.clear().catch(() => {});
    this.toSignedOut();
  }

  /** Sign out: the bounded server revoke never delays the local clear. */
  async signOut() {
    const token = this.state.token;
    void this.accounts.revoke(token);
    await this.tokens.clear();
    this.toSignedOut();
  }

  toSignedOut() {
    this.setState({ phase: "signed-out", token: null, account: null, agents: [], agentsStatus: "loading", error: null });
  }
}
