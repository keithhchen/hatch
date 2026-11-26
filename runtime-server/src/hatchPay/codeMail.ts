import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentCorpusResolverLike } from "../agentCorpus.js";
import { log } from "../observability/log.js";
import { DEFAULT_LOCALE, type Locale } from "../locale.js";
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

/** An Expert's own template, in the Product Corpus; either file may be absent. `code.html` is the Chinese one; another language has `code.en.html` and `code-subject.en.txt`, and never gets a template of another language. */
async function corpusTemplate(corpusRoot: string | undefined, locale: Locale): Promise<{ html?: string; subject?: string }> {
  if (!corpusRoot) return {};
  const mid = locale === DEFAULT_LOCALE ? "" : `.${locale}`;
  const read = (name: string) => readFile(path.join(corpusRoot, "runtime", "email", name), "utf8").then(text => text.trim() || undefined, () => undefined);
  const [html, subject] = await Promise.all([read(`code${mid}.html`), read(`code-subject${mid}.txt`)]);
  return { ...html ? { html } : {}, ...subject ? { subject } : {} };
}

export interface CodeMailer { send(input: { code: string; productId: string; to: string; name?: string; locale?: Locale }): Promise<void> }

/** The access code email: the Product's own template, else the platform default; both rendered with the same variables. */
export class AccessCodeMailer implements CodeMailer {
  constructor(private readonly deps: {
    sender: EmailSender; from: string; prompts: PromptRows; products: ProductMailInfos; priceFen: number;
    /** Where a code's page is: `<origin>/c/<CODE>`. */
    origin?: string;
    /** Waits before each retry of a transient failure (1s, 5s, 20s), as the report email. */
    retryDelaysMs?: number[];
  }) {}

  /** The platform default in the visitor's language (`<name>-en`, `<name>-ja`); a language whose row is missing is mailed the Chinese one, and logged. */
  private async defaultOf(name: string, locale: Locale): Promise<string> {
    if (locale === DEFAULT_LOCALE) return this.deps.prompts.get(name);
    try { return await this.deps.prompts.get(`${name}-${locale}`); } catch (error) {
      log.warn("hatch_pay_email_locale_missing", { name, locale, error });
      return this.deps.prompts.get(name);
    }
  }

  async send({ code, productId, to, name, locale = DEFAULT_LOCALE }: { code: string; productId: string; to: string; name?: string; locale?: Locale }): Promise<void> {
    const product = await this.deps.products.describe(productId);
    const own = await corpusTemplate(product.corpusRoot, locale);
    const [html, subject] = await Promise.all([own.html ?? this.defaultOf(DEFAULT_TEMPLATE_PROMPT, locale), own.subject ?? this.defaultOf(DEFAULT_SUBJECT_PROMPT, locale)]);
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
