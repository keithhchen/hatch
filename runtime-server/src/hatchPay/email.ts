/** One email out. `idempotencyKey` makes a repeat of the same send a no-op at the provider (same shape as the report email's). */
export type EmailMessage = { from: string; to: string; subject: string; html: string; text: string; idempotencyKey: string };

export interface EmailSender {
  /** Returns the provider's message id; throws when the mail was not accepted. */
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
    });
    const body = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (!response.ok || !body.id) throw new Error(`Resend ${response.status}: ${body.message ?? "no message id"}`);
    return { id: body.id };
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ESCAPES[c]!);

/** The access code and, when the way back is known, the link that opens the chat with it filled in. */
export function accessCodeEmail(input: { from: string; to: string; code: string; link?: string }): EmailMessage {
  const { code, link } = input;
  return {
    from: input.from, to: input.to, subject: `你的兑换码：${code}`,
    html: `<p style="font:16px/1.7 system-ui,sans-serif">你的兑换码</p><p style="font:700 28px ui-monospace,monospace;letter-spacing:4px">${escapeHtml(code)}</p><p style="font:16px/1.7 system-ui,sans-serif">用这个兑换码随时查看你的诊断结果。</p>${link ? `<p><a href="${escapeHtml(link)}">打开对话</a></p>` : ""}`,
    text: `你的兑换码：${code}\n用这个兑换码随时查看你的诊断结果。${link ? `\n${link}` : ""}`,
    // The same code is mailed at most once, whatever retries.
    idempotencyKey: `access-code-${code}`
  };
}
