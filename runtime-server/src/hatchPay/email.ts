import { isTransientStatus, TransientEmailError } from "../agentBox/reportEmail.js";

/** One email out. `idempotencyKey` makes a repeat of the same send a no-op at the provider (same shape as the report email's). */
export type EmailMessage = { from: string; to: string; subject: string; html: string; text: string; idempotencyKey: string };

export interface EmailSender {
  /** Returns the provider's message id; throws TransientEmailError for what is worth another try (network failure, 429, 5xx), any other Error when the mail was refused. */
  send(message: EmailMessage): Promise<{ id: string }>;
}

/** Resend over its HTTP API. */
export class ResendSender implements EmailSender {
  constructor(private readonly apiKey: string, private readonly options: { fetch?: typeof fetch; endpoint?: string } = {}) {}

  async send({ idempotencyKey, ...mail }: EmailMessage) {
    const response = await (this.options.fetch ?? fetch)(this.options.endpoint ?? "https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ from: mail.from, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
      signal: AbortSignal.timeout(15_000)
    }).catch(error => { throw new TransientEmailError(error instanceof Error ? error.message : "send failed"); });
    const body = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok || !body.id) {
      const error = `Resend ${response.status}: ${body.message ?? "no message id"}`;
      throw isTransientStatus(response.status) ? new TransientEmailError(error) : new Error(error);
    }
    return { id: body.id };
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ESCAPES[c]!);
