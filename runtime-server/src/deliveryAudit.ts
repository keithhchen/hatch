import { z } from "zod";

export const DeliveryWorkflowSchema = z.object({
  version: z.literal("1"),
  mode: z.literal("draft_claim_audit_revise"),
  audit: z.object({
    unit: z.literal("atomic_claim"),
    verdicts: z.tuple([
      z.literal("entailed"),
      z.literal("unsupported"),
      z.literal("conflicting"),
      z.literal("confidential"),
      z.literal("out_of_scope")
    ]),
    require_evidence_entailment: z.literal(true),
    check_product_boundaries: z.literal(true),
    coverage: z.object({
      unitization: z.literal("markdown_claim_clauses_v1"),
      require_all_units: z.literal(true),
      max_units: z.number().int().min(1).max(500)
    }).strict(),
    evidence_authority: z.object({
      user_fact_sources: z.tuple([
        z.literal("user_input"),
        z.literal("approved_tool_evidence")
      ]),
      creator_method_sources: z.tuple([z.literal("protected_knowledge")]),
      protected_knowledge_cannot_support_user_specific_claims: z.literal(true)
    }).strict()
  }).strict(),
  audit_instruction: z.string().min(1),
  revision_instruction: z.string().min(1),
  audit_result_format: z.record(z.string(), z.unknown()),
  max_revision_passes: z.number().int().min(1).max(3),
  on_unresolved: z.literal("return_boundary_safe_partial"),
  expose_intermediate: z.literal(false)
}).strict();

export type DeliveryWorkflow = z.infer<typeof DeliveryWorkflowSchema>;
