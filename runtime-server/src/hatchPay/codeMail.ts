import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentCorpusResolverLike } from "../agentCorpus.js";
import { log } from "../observability/log.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import type { EmailSender } from "./email.js";
import { DEFAULT_RETRY_DELAYS_MS, htmlToText, renderTemplate, retryTransient } from "../agentBox/reportEmail.js";

export const DEFAULT_TEMPLATE_PROMPT = "access-code-email-default";
export const DEFAULT_SUBJECT_PROMPT = "access-code-email-default-subject";

/** The platform's default email text, by name: a row of hatch_prompts (name, body), edited with an UPDATE, no deploy. */
export interface PromptRows { get(name: string): Promise<string> }

export class PostgresPromptRows implements PromptRows {
  constructor(private readonly db: PostgresQueryExecutor) {}
  async get(name: string) {
    const body = (await this.db.query<{ body: string }>("SELECT body FROM hatch_prompts WHERE name = $1", [name])).rows[0]?.body;
    if (!body?.trim()) throw new Error(`hatch_prompts has no row named ${name}`);
    return body;
  }
}

/** What the mail says about a Product, and where its own template would be (the Product Corpus root). */
export type ProductMailInfo = { productName: string; expertName?: string; corpusRoot?: string };
export interface ProductMailInfos { describe(productId: string): Promise<ProductMailInfo> }

export class CorpusProductMailInfos implements ProductMailInfos {
  constructor(private readonly corpora: AgentCorpusResolverLike | undefined) {}
  async describe(productId: string): Promise<ProductMailInfo> {
    try {
      const resolved = await this.corpora?.resolveByProduct(productId);
      if (resolved) {
        const expert = resolved.corpus.creator.name;
        return { productName: resolved.corpus.product.name, ...expert && expert !== "Expert" ? { expertName: expert } : {}, corpusRoot: resolved.root };
      }
    } catch (error) { log.warn("hatch_pay_corpus_unavailable", { productId, error }); }
    return { productName: "Hatch" };
  }
}

/** An Expert's own template, in the Product Corpus; either file may be absent. */
async function corpusTemplate(corpusRoot: string | undefined): Promise<{ html?: string; subject?: string }> {
  if (!corpusRoot) return {};
  const read = (name: string) => readFile(path.join(corpusRoot, "runtime", "email", name), "utf8").then(text => text.trim() || undefined, () => undefined);
  const [html, subject] = await Promise.all([read("code.html"), read("code-subject.txt")]);
  return { ...html ? { html } : {}, ...subject ? { subject } : {} };
}

export interface CodeMailer { send(input: { code: string; productId: string; to: string; name?: string }): Promise<void> }

/** The access code email: the Product's own template, else the platform default; both rendered with the same variables. */
export class AccessCodeMailer implements CodeMailer {
  constructor(private readonly deps: {
    sender: EmailSender; from: string; prompts: PromptRows; products: ProductMailInfos; priceFen: number;
    /** Where a code's page is: `<origin>/c/<CODE>`. */
    origin?: string;
    /** Waits before each retry of a transient failure (1s, 5s, 20s), as the report email. */
    retryDelaysMs?: number[];
  }) {}

  async send({ code, productId, to, name }: { code: string; productId: string; to: string; name?: string }): Promise<void> {
    const product = await this.deps.products.describe(productId);
    const own = await corpusTemplate(product.corpusRoot);
    const [html, subject] = await Promise.all([own.html ?? this.deps.prompts.get(DEFAULT_TEMPLATE_PROMPT), own.subject ?? this.deps.prompts.get(DEFAULT_SUBJECT_PROMPT)]);
    const values = {
      product_name: product.productName, expert_name: product.expertName, name, code,
      amount: (this.deps.priceFen / 100).toFixed(2), code_url: `${this.deps.origin ?? "https://gethatchapp.com"}/c/${code}`
    };
    const rendered = renderTemplate(html, values);
    const message = {
      from: this.deps.from, to, subject: renderTemplate(subject, values, true).replace(/\s+/g, " ").trim(), html: rendered, text: htmlToText(rendered),
      // The same code is mailed at most once, whatever retries.
      idempotencyKey: `access-code-${code}`
    };
    await retryTransient(() => this.deps.sender.send(message), this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
      (attempt, error) => log.warn("hatch_pay_email_retry", { code, attempt, error }));
  }
}
