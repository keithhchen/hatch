import { z } from "zod";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import type { ArtifactConfig, ArtifactConfigRepository, Intake } from "./ports.js";

/** Text a buyer reads: one string, or one per language (zh, en, ja); the web shows the reader's and falls back to another. */
const Localized = (max: number) => z.union([
  z.string().min(1).max(max),
  z.object({ zh: z.string().min(1).max(max), en: z.string().min(1).max(max), ja: z.string().min(1).max(max) }).partial().strict()
    .refine((text) => Object.keys(text).length > 0, { message: "give the text in at least one language" })
]);

const FieldSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: Localized(500),
  type: z.enum(["text", "long_text", "choice", "multi", "files"]),
  required: z.boolean().optional(),
  options: z.array(Localized(200)).max(30).optional(),
  help: Localized(500).optional()
}).strict().refine(
  (field) => (field.type === "choice" || field.type === "multi") === (field.options !== undefined && field.options.length > 0),
  { message: "choice and multi fields need options, and no other field takes them" }
);

export const IntakeSchema = z.object({ fields: z.array(FieldSchema).min(1).max(40) }).strict().refine(
  (intake) => new Set(intake.fields.map((field) => field.id)).size === intake.fields.length,
  { message: "field ids must be unique" }
);

export class InvalidArtifactConfig extends Error {
  constructor(productId: string, cause: string) {
    super(`The artifact configuration of product ${productId} is invalid: ${cause}`);
    this.name = "InvalidArtifactConfig";
  }
}

/** The one place a stored row becomes a config: a bad row fails here, loudly. */
export function parseArtifactConfig(row: { product_id: string; intake: unknown; report_template: unknown }): ArtifactConfig {
  const intake = IntakeSchema.safeParse(typeof row.intake === "string" ? safeJson(row.intake) : row.intake);
  if (!intake.success) throw new InvalidArtifactConfig(row.product_id, intake.error.issues.map((i) => `${i.path.join(".") || "intake"}: ${i.message}`).join("; "));
  if (typeof row.report_template !== "string" || !row.report_template.trim()) throw new InvalidArtifactConfig(row.product_id, "report_template is empty");
  return { productId: row.product_id, intake: intake.data as Intake, reportTemplate: row.report_template };
}

const safeJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };

export const POSTGRES_ARTIFACT_CONFIG_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_artifact_products (
  product_id TEXT PRIMARY KEY,
  intake JSONB NOT NULL,
  report_template TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export class PostgresArtifactConfigRepository implements ArtifactConfigRepository {
  constructor(private readonly db: PostgresQueryExecutor) {}

  initialize() { return this.db.query(POSTGRES_ARTIFACT_CONFIG_SCHEMA); }

  async get(productId: string): Promise<ArtifactConfig | undefined> {
    const result = await this.db.query<{ product_id: string; intake: unknown; report_template: string }>(
      "SELECT product_id, intake, report_template FROM hatch_artifact_products WHERE product_id = $1", [productId]);
    return result.rows[0] && parseArtifactConfig(result.rows[0]);
  }
}

/** Rows as the database would hold them, validated the same way. */
export class InMemoryArtifactConfigRepository implements ArtifactConfigRepository {
  private readonly rows = new Map<string, { product_id: string; intake: unknown; report_template: unknown }>();
  set(productId: string, intake: unknown, reportTemplate: unknown): this {
    this.rows.set(productId, { product_id: productId, intake, report_template: reportTemplate });
    return this;
  }
  async get(productId: string) {
    const row = this.rows.get(productId);
    return row && parseArtifactConfig(row);
  }
}
