import { randomBytes, randomUUID } from "node:crypto";
import type { AgentTarget } from "../surfaces/contract.js";
import { targetKey, type ConnectionRepository } from "./connections.js";
import { isPerProduct, readCredentials, type CredentialForm, type OwnAppForm } from "./credentialForms.js";
import type { ChannelKind } from "./types.js";

const failure = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
export const webhookUrl = (origin: string, kind: ChannelKind, scope: string): string => `${origin}/v1/channels/${kind}/${scope}/webhook`;

/**
 * An Expert's own bot for one Product, on a platform where a bot is made by hand (Telegram). Each bot is its own tenant, named by a fresh scope:
 * saving a token proves it, points the platform's webhook at that scope, and replaces whatever bot the Product had; removing it ends the webhook.
 */
export class OwnApps {
  constructor(private deps: {
    connections: ConnectionRepository; seal: { seal(value: unknown): string; open<T>(sealed: string): T };
    forms: Partial<Record<ChannelKind, CredentialForm>>; origin: string; ownsProduct: (accountId: string, productId: string) => Promise<boolean>;
  }) {}

  private form(kind: ChannelKind): OwnAppForm {
    const form = this.deps.forms[kind];
    if (!isPerProduct(form)) throw failure(404, "not_found", "Route not found.");
    return form;
  }

  /** The Product's bot, if it has one: where it lives and what was sealed for it. */
  private async current(accountId: string, kind: ChannelKind, target: AgentTarget): Promise<{ scope: string; credentials: Record<string, any> } | undefined> {
    const own = (await this.deps.connections.owned(accountId)).find(connection => connection.channel === kind && connection.audience === "public" && targetKey(connection.target) === targetKey(target) && connection.hasCredentials);
    const sealed = own && await this.deps.connections.credentialsOf(kind, own.scope);
    return sealed ? { scope: own!.scope, credentials: this.deps.seal.open(sealed) } : undefined;
  }

  /** The handle of the Product's own bot, when it has one. */
  async username(accountId: string, kind: ChannelKind, productId: string): Promise<string | undefined> {
    return (await this.current(accountId, kind, { kind: "product", productId }))?.credentials.username;
  }

  async save(accountId: string, kind: ChannelKind, productId: string, body: Record<string, unknown>): Promise<void> {
    const form = this.form(kind);
    if (!await this.deps.ownsProduct(accountId, productId)) throw failure(404, "product_not_found", "Product was not found.");
    const credentials = readCredentials(form, body);
    if (!credentials) throw failure(400, "invalid_credentials", "A bot token is required.");
    const target: AgentTarget = { kind: "product", productId };
    const scope = randomUUID();
    const previous = await this.current(accountId, kind, target);
    try { Object.assign(credentials, await form.provision!(form.build(credentials, scope), { webhookUrl: webhookUrl(this.deps.origin, kind, scope), secret: randomBytes(24).toString("hex") })); }
    catch (cause) { throw failure(422, `${kind}_probe_failed`, cause instanceof Error ? cause.message : String(cause)); }
    await this.deps.connections.saveCredentials(accountId, kind, this.deps.seal.seal(credentials), scope, target);
    // The same bot saved again was already pointed here by its probe; a different one is let go.
    if (previous && previous.credentials.token !== credentials.token) await form.release?.(form.build(previous.credentials, previous.scope)).catch(() => undefined);
  }

  async remove(accountId: string, kind: ChannelKind, productId: string): Promise<void> {
    const form = this.form(kind);
    const current = await this.current(accountId, kind, { kind: "product", productId });
    if (!current) return;
    await form.release?.(form.build(current.credentials, current.scope)).catch(() => undefined);
    await this.deps.connections.revokeTenant(kind, current.scope);
  }
}
