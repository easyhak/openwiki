import { z } from "zod";
import { normalizeWikiPagePath } from "../../claims/brains/code/paths.js";

/**
 * Canonical generated Markdown page accepted by generation state.
 */
export const CanonicalPageSchema = z
  .string()
  .min(1)
  .max(500)
  .superRefine((page, context) => {
    try {
      if (normalizeWikiPagePath(page) !== page) {
        context.addIssue({
          code: "custom",
          message: "must use the canonical /openwiki/...md path",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: "must be a grounded Markdown page below /openwiki",
      });
    }
  });

/**
 * Stable non-empty identifier shared across persisted workflow records.
 */
const StableIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim(), {
    message: "must not contain surrounding whitespace",
  });

/**
 * Bounded diagnostic text safe to persist between runs.
 */
const DiagnosticSchema = z.string().trim().min(1).max(1_000);

/**
 * One normalized unit of page work.
 */
export const PageJobSchema = z
  .object({
    id: StableIdSchema,
    page: CanonicalPageSchema,
    operation: z.enum([
      "create",
      "reconcile",
      "repair",
      "delete",
      "quickstart",
    ]),
    reasons: z.array(StableIdSchema).min(1).max(100),
    sourceHints: z.array(z.string().trim().min(1).max(500)).max(100),
    wave: z.number().int().nonnegative(),
    priority: z.number().int().min(0).max(1_000),
  })
  .strict();

/**
 * One normalized page job.
 */
export type PageJob = z.infer<typeof PageJobSchema>;

/**
 * Evidence identity proposed without a model-authored version.
 */
export const ClaimEvidenceDraftSchema = z
  .object({
    resource: z.string().trim().min(1).max(1_000),
  })
  .strict();

/**
 * Complete proposed representation of one page Claim.
 */
export const ClaimDraftSchema = z
  .object({
    id: StableIdSchema.optional(),
    statement: z.string().trim().min(1).max(4_000),
    evidence: z.array(ClaimEvidenceDraftSchema).min(1).max(20),
  })
  .strict();

/**
 * Structured output of the page Claims reconciler.
 */
export const ClaimProposalSchema = z
  .object({
    disposition: z.enum(["write", "delete", "defer"]),
    claims: z.array(ClaimDraftSchema).max(500),
    reason: DiagnosticSchema,
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.disposition === "write" && proposal.claims.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A write proposal must contain at least one Claim.",
        path: ["claims"],
      });
    }
    if (proposal.disposition === "delete" && proposal.claims.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A delete proposal cannot contain Claims.",
        path: ["claims"],
      });
    }
  });

/**
 * Structured output of the page Claims reconciler.
 */
export type ClaimProposal = z.infer<typeof ClaimProposalSchema>;

/**
 * Structured output of the tool-free Markdown author.
 */
export const PageAuthorOutputSchema = z
  .object({
    markdown: z.string().min(1).max(500_000),
    representedClaimIds: z.array(StableIdSchema).max(500),
  })
  .strict();

/**
 * Structured output of the tool-free Markdown author.
 */
export type PageAuthorOutput = z.infer<typeof PageAuthorOutputSchema>;

/**
 * Compact page-local failure returned to a parent graph.
 */
export const PageFailureSchema = z
  .object({
    code: z.enum([
      "reconciler_failed",
      "claims_invalid",
      "author_failed",
      "page_invalid",
      "commit_failed",
      "deferred",
    ]),
    message: DiagnosticSchema,
  })
  .strict();

/**
 * Compact page-local failure returned to a parent graph.
 */
export type PageFailure = z.infer<typeof PageFailureSchema>;

/**
 * Compact result returned by one PageGraph invocation.
 */
export const PageResultSchema = z
  .object({
    page: CanonicalPageSchema,
    wave: z.number().int().nonnegative(),
    status: z.enum(["committed", "unchanged", "deleted", "deferred", "failed"]),
    pageVersion: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    claimRevision: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    reconcilerInvocations: z.number().int().nonnegative(),
    authorInvocations: z.number().int().nonnegative(),
    changedLinks: z.array(CanonicalPageSchema).max(500),
    failure: PageFailureSchema.optional(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Compact result returned by one PageGraph invocation.
 */
export type PageResult = z.infer<typeof PageResultSchema>;

/**
 * Durable unfinished work that must block a future no-op.
 */
export const PendingWorkItemSchema = z
  .object({
    id: StableIdSchema,
    kind: z.enum([
      "page",
      "review-gap",
      "translation",
      "unmapped-change",
      "finalizer",
    ]),
    page: CanonicalPageSchema.optional(),
    reason: DiagnosticSchema,
    sourceHints: z.array(z.string().trim().min(1).max(500)).max(100),
    attempts: z.number().int().nonnegative(),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
  })
  .strict();

/**
 * Durable unfinished work item.
 */
export type PendingWorkItem = z.infer<typeof PendingWorkItemSchema>;

/**
 * Versioned pending-work document owned by OpenWiki.
 */
export const PendingWorkDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(PendingWorkItemSchema).max(2_000),
  })
  .strict();

/**
 * Versioned pending-work document owned by OpenWiki.
 */
export type PendingWorkDocument = z.infer<typeof PendingWorkDocumentSchema>;

/**
 * One deterministic repository discovery partition.
 */
export const DiscoveryPartitionSchema = z
  .object({
    id: StableIdSchema,
    roots: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
    manifests: z.array(z.string().trim().min(1).max(500)).max(100),
  })
  .strict();

/**
 * One deterministic repository discovery partition.
 */
export type DiscoveryPartition = z.infer<typeof DiscoveryPartitionSchema>;

/**
 * Structured discovery result for one partition.
 */
export const DiscoveryResultSchema = z
  .object({
    partitionId: StableIdSchema,
    jobs: z.array(PageJobSchema.omit({ id: true, wave: true })).max(200),
    deferrals: z.array(DiagnosticSchema).max(100),
  })
  .strict();

/**
 * Structured discovery result for one partition.
 */
export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;

/**
 * Structured reviewer/planner gap converted into deterministic work.
 */
export const ReviewGapSchema = z
  .object({
    id: StableIdSchema,
    page: CanonicalPageSchema.optional(),
    reason: DiagnosticSchema,
    sourceHints: z.array(z.string().trim().min(1).max(500)).max(100),
  })
  .strict();

/**
 * Structured reviewer/planner gap.
 */
export type ReviewGap = z.infer<typeof ReviewGapSchema>;

/**
 * Shared structured output for bounded planning and review passes.
 */
export const ReviewOutputSchema = z
  .object({
    jobs: z.array(PageJobSchema.omit({ id: true, wave: true })).max(500),
    gaps: z.array(ReviewGapSchema).max(500),
    resolvedPendingIds: z.array(StableIdSchema).max(500),
  })
  .strict();

/**
 * Shared structured output for bounded planning and review passes.
 */
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/**
 * Terminal summary returned by a generation graph.
 */
export const GenerationSummarySchema = z
  .object({
    status: z.enum(["complete", "partial"]),
    planned: z.number().int().nonnegative(),
    committed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    deferred: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Terminal summary returned by a generation graph.
 */
export type GenerationSummary = z.infer<typeof GenerationSummarySchema>;

/**
 * One stable repository-wide QA question.
 */
export const QaQuestionSchema = z
  .object({
    id: StableIdSchema,
    question: z.string().trim().min(1).max(2_000),
    acceptanceCriteria: z
      .array(z.string().trim().min(1).max(1_000))
      .min(1)
      .max(20),
  })
  .strict();

/**
 * One stable repository-wide QA question.
 */
export type QaQuestion = z.infer<typeof QaQuestionSchema>;

/**
 * Structured output of the one-time question finder.
 */
export const QaQuestionSetSchema = z
  .object({ questions: z.array(QaQuestionSchema).max(12) })
  .strict();

/**
 * Structured output of the one-time question finder.
 */
export type QaQuestionSet = z.infer<typeof QaQuestionSetSchema>;

/**
 * One bounded QA verification result.
 */
export const QaResultSchema = z
  .object({
    id: StableIdSchema,
    status: z.enum(["pass", "partial", "fail"]),
    reason: DiagnosticSchema,
    page: CanonicalPageSchema.optional(),
    sourceHints: z.array(z.string().trim().min(1).max(500)).max(100),
    wave: z.number().int().nonnegative(),
  })
  .strict();

/**
 * One bounded QA verification result.
 */
export type QaResult = z.infer<typeof QaResultSchema>;

/**
 * Structured output for one verifier batch.
 */
export const QaBatchResultSchema = z
  .object({
    results: z
      .array(QaResultSchema.omit({ wave: true }))
      .min(1)
      .max(3),
  })
  .strict();

/**
 * Structured output for one verifier batch.
 */
export type QaBatchResult = z.infer<typeof QaBatchResultSchema>;
