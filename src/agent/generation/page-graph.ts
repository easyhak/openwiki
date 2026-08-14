import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  parseFrontmatterFields,
  validateOkfFrontmatter,
} from "../../okf/frontmatter.js";
import { ClaimsStore } from "../../claims/brains/code/store.js";
import { reconcileCompleteClaimSet } from "../../claims/brains/code/reconcile.js";
import {
  ClaimsPersistenceError,
  EvidenceResolutionError,
} from "../../claims/core/errors.js";
import type { PageClaims } from "../../claims/brains/code/types.js";
import type { Claim, EvidenceResolver } from "../../claims/core/types.js";
import {
  MAX_CLAIM_RECONCILER_INVOCATIONS,
  MAX_PAGE_ELAPSED_MS,
  MAX_PAGE_AUTHOR_INVOCATIONS,
  GENERATION_RECURSION_LIMIT,
} from "./config.js";
import {
  CanonicalPageSchema,
  PageResultSchema,
  type ClaimProposal,
  type PageAuthorOutput,
  type PageFailure,
  type PageJob,
  type PageResult,
} from "./contracts.js";
import { AtomicRepositoryFiles } from "./atomic-files.js";
import { PageCommitter } from "./page-commit.js";
import {
  isRetryableSpecialistFailure,
  type GenerationSpecialists,
} from "./specialists.js";

/**
 * PageGraph construction dependencies.
 */
export interface PageGraphDependencies {
  /**
   * Absolute repository root.
   */
  rootDir: string;

  /**
   * Claims sidecar persistence.
   */
  claimsStore: ClaimsStore;

  /**
   * Deterministic evidence resolver.
   */
  resolver: EvidenceResolver;

  /**
   * Narrow model specialists.
   */
  specialists: GenerationSpecialists;

  /**
   * Page/sidecar transaction service.
   */
  committer: PageCommitter;

  /**
   * Monotonic-enough wall clock used for elapsed budgets and result timing.
   *
   * @default Date.now
   */
  now?: () => number;

  /**
   * Creates an abort signal for the remaining page budget.
   *
   * @default AbortSignal.timeout
   */
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal;
}

/**
 * Small callable PageGraph boundary used by parent graphs.
 */
export interface PageGraphRunner {
  /**
   * Runs one normalized page job.
   *
   * @param job - Seeded page job.
   * @param config - Optional parent runnable config.
   * @returns Compact terminal result.
   */
  run(job: PageJob, config?: RunnableConfig): Promise<PageResult>;
}

/**
 * Page-local state retained only for one subgraph invocation.
 */
const PageState = Annotation.Root({
  job: Annotation<PageJob>,
  startedAt: Annotation<number>,
  existingMarkdown: Annotation<string | null>,
  existingClaims: Annotation<PageClaims | null>,
  proposal: Annotation<ClaimProposal | null>,
  claims: Annotation<Claim[]>,
  authorOutput: Annotation<PageAuthorOutput | null>,
  reconcilerInvocations: Annotation<number>,
  reconcilerCanRetry: Annotation<boolean>,
  authorInvocations: Annotation<number>,
  authorCanRetry: Annotation<boolean>,
  claimErrors: Annotation<string[]>,
  pageErrors: Annotation<string[]>,
  failureCode: Annotation<PageFailure["code"] | null>,
  result: Annotation<PageResult | null>,
});

/**
 * Creates the standalone PageGraph vertical slice.
 *
 * @param dependencies - Page-local deterministic and specialist services.
 * @returns Callable runner exposing only compact PageResult state.
 */
export function createPageGraphRunner(
  dependencies: PageGraphDependencies,
): PageGraphRunner {
  const files = new AtomicRepositoryFiles(dependencies.rootDir);
  const now = dependencies.now ?? Date.now;
  const createTimeoutSignal =
    dependencies.createTimeoutSignal ??
    ((timeoutMs) => AbortSignal.timeout(timeoutMs));

  const graph = new StateGraph(PageState)
    .addNode("load_page", async (state) => ({
      existingMarkdown: await files.readText(
        state.job.page.replace(/^\//u, ""),
      ),
      existingClaims: await dependencies.claimsStore.loadPage(state.job.page),
    }))
    .addNode("reconcile_claims", async (state, config) => {
      if (pageDeadlineExceeded(state.startedAt, now)) {
        return {
          proposal: null,
          claimErrors: [
            `PageGraph exceeded its ${MAX_PAGE_ELAPSED_MS / 60_000}-minute elapsed-time budget.`,
          ],
          failureCode: "reconciler_failed" as const,
          reconcilerCanRetry: false,
        };
      }
      const invocation = state.reconcilerInvocations + 1;
      const attemptConfig = withPageBudget(
        config,
        state.startedAt,
        now,
        createTimeoutSignal,
      );
      try {
        const proposal = await dependencies.specialists.reconcilePage(
          {
            job: state.job,
            existingMarkdown: state.existingMarkdown,
            existingClaims: state.existingClaims?.claims ?? [],
            repairErrors: state.claimErrors,
          },
          attemptConfig,
        );
        return {
          proposal,
          claimErrors: [],
          failureCode: null,
          reconcilerInvocations: invocation,
          reconcilerCanRetry: true,
        };
      } catch (error) {
        if (config?.signal?.aborted) throw error;
        const retryable = isRetryableSpecialistFailure(error);
        return {
          proposal: null,
          claimErrors: [messageOf(error)],
          failureCode: "reconciler_failed" as const,
          reconcilerInvocations: invocation,
          reconcilerCanRetry:
            retryable && !pageDeadlineExceeded(state.startedAt, now),
        };
      }
    })
    .addNode("validate_claims", async (state) => {
      if (!state.proposal) {
        return {};
      }
      if (state.proposal.disposition === "defer") {
        return {
          claimErrors: [state.proposal.reason],
          failureCode: "deferred" as const,
        };
      }
      if (
        state.proposal.disposition === "delete" &&
        state.job.operation !== "delete"
      ) {
        return {
          claimErrors: [
            "A page may be deleted only by a deterministically planned delete job.",
          ],
          failureCode: "claims_invalid" as const,
        };
      }
      try {
        const claims = await reconcileCompleteClaimSet({
          existing: state.existingClaims?.claims ?? [],
          proposal: state.proposal,
          resolver: dependencies.resolver,
        });
        return { claims, claimErrors: [], failureCode: null };
      } catch (error) {
        if (isSystemicClaimFailure(error)) {
          throw error;
        }
        return {
          claimErrors: [messageOf(error)],
          failureCode: "claims_invalid" as const,
        };
      }
    })
    .addNode("author_page", async (state, config) => {
      if (pageDeadlineExceeded(state.startedAt, now)) {
        return {
          authorOutput: null,
          pageErrors: [
            `PageGraph exceeded its ${MAX_PAGE_ELAPSED_MS / 60_000}-minute elapsed-time budget.`,
          ],
          failureCode: "author_failed" as const,
          authorCanRetry: false,
        };
      }
      const invocation = state.authorInvocations + 1;
      const attemptConfig = withPageBudget(
        config,
        state.startedAt,
        now,
        createTimeoutSignal,
      );
      try {
        const authorOutput = await dependencies.specialists.authorPage(
          {
            job: state.job,
            existingMarkdown: state.existingMarkdown,
            claims: state.claims,
            repairErrors: state.pageErrors,
          },
          attemptConfig,
        );
        return {
          authorOutput,
          pageErrors: [],
          failureCode: null,
          authorInvocations: invocation,
          authorCanRetry: true,
        };
      } catch (error) {
        if (config?.signal?.aborted) throw error;
        const retryable = isRetryableSpecialistFailure(error);
        return {
          authorOutput: null,
          pageErrors: [messageOf(error)],
          failureCode: "author_failed" as const,
          authorInvocations: invocation,
          authorCanRetry:
            retryable && !pageDeadlineExceeded(state.startedAt, now),
        };
      }
    })
    .addNode("validate_page", (state) => {
      if (!state.authorOutput) {
        return {};
      }
      const errors = validateAuthoredPage(state.authorOutput, state.claims);
      return errors.length === 0
        ? { pageErrors: [], failureCode: null }
        : {
            pageErrors: errors,
            failureCode: "page_invalid" as const,
          };
    })
    .addNode("commit_page", async (state) => {
      try {
        const committed =
          state.proposal?.disposition === "delete"
            ? await dependencies.committer.delete(state.job)
            : await dependencies.committer.commit(
                state.job,
                requireAuthorOutput(state).markdown,
                state.claims,
              );
        return {
          result: PageResultSchema.parse({
            page: state.job.page,
            wave: state.job.wave,
            ...committed,
            reconcilerInvocations: state.reconcilerInvocations,
            authorInvocations: state.authorInvocations,
            changedLinks:
              state.authorOutput === null
                ? []
                : extractCanonicalWikiLinks(state.authorOutput.markdown),
            durationMs: Math.max(0, now() - state.startedAt),
          }),
        };
      } catch (error) {
        if (
          error instanceof AggregateError ||
          error instanceof ClaimsPersistenceError
        ) {
          throw error;
        }
        return {
          failureCode: "commit_failed" as const,
          pageErrors: [messageOf(error)],
        };
      }
    })
    .addNode("fail_page", (state) => ({
      result: PageResultSchema.parse({
        page: state.job.page,
        wave: state.job.wave,
        status: state.failureCode === "deferred" ? "deferred" : "failed",
        reconcilerInvocations: state.reconcilerInvocations,
        authorInvocations: state.authorInvocations,
        changedLinks: [],
        failure: {
          code: state.failureCode ?? "page_invalid",
          message:
            [...state.claimErrors, ...state.pageErrors]
              .join("; ")
              .slice(0, 1_000) ||
            "Page generation failed without a diagnostic.",
        },
        durationMs: Math.max(0, now() - state.startedAt),
      }),
    }))
    .addEdge(START, "load_page")
    .addEdge("load_page", "reconcile_claims")
    .addConditionalEdges("reconcile_claims", routeAfterReconciler, [
      "reconcile_claims",
      "validate_claims",
      "fail_page",
    ])
    .addConditionalEdges("validate_claims", routeAfterClaimValidation, [
      "reconcile_claims",
      "author_page",
      "commit_page",
      "fail_page",
    ])
    .addConditionalEdges("author_page", routeAfterAuthor, [
      "author_page",
      "validate_page",
      "fail_page",
    ])
    .addConditionalEdges("validate_page", routeAfterPageValidation, [
      "author_page",
      "commit_page",
      "fail_page",
    ])
    .addConditionalEdges("commit_page", (state) =>
      state.result ? END : "fail_page",
    )
    .addEdge("fail_page", END)
    .compile()
    .withConfig({
      recursionLimit: GENERATION_RECURSION_LIMIT,
      runName: "PageGraph",
    });

  return {
    async run(job, config) {
      const state = await graph.invoke(
        {
          job,
          startedAt: now(),
          existingMarkdown: null,
          existingClaims: null,
          proposal: null,
          claims: [],
          authorOutput: null,
          reconcilerInvocations: 0,
          reconcilerCanRetry: true,
          authorInvocations: 0,
          authorCanRetry: true,
          claimErrors: [],
          pageErrors: [],
          failureCode: null,
          result: null,
        },
        config,
      );
      if (!state.result) {
        throw new Error(`PageGraph ended without a result for ${job.page}.`);
      }
      return state.result;
    },
  };
}

/**
 * Routes reconciler transport/schema failures through bounded retry.
 */
function routeAfterReconciler(
  state: typeof PageState.State,
): "reconcile_claims" | "validate_claims" | "fail_page" {
  if (state.proposal) return "validate_claims";
  return state.reconcilerCanRetry &&
    state.reconcilerInvocations < MAX_CLAIM_RECONCILER_INVOCATIONS
    ? "reconcile_claims"
    : "fail_page";
}

/**
 * Routes deterministic Claim validation and delete handling.
 */
function routeAfterClaimValidation(
  state: typeof PageState.State,
): "reconcile_claims" | "author_page" | "commit_page" | "fail_page" {
  if (state.claimErrors.length > 0) {
    if (state.failureCode === "deferred") return "fail_page";
    return state.reconcilerCanRetry &&
      state.reconcilerInvocations < MAX_CLAIM_RECONCILER_INVOCATIONS
      ? "reconcile_claims"
      : "fail_page";
  }
  return state.proposal?.disposition === "delete"
    ? "commit_page"
    : "author_page";
}

/**
 * Routes author transport/schema failures through bounded retry.
 */
function routeAfterAuthor(
  state: typeof PageState.State,
): "author_page" | "validate_page" | "fail_page" {
  if (state.authorOutput) return "validate_page";
  return state.authorCanRetry &&
    state.authorInvocations < MAX_PAGE_AUTHOR_INVOCATIONS
    ? "author_page"
    : "fail_page";
}

/**
 * Routes deterministic Markdown validation through bounded repair.
 */
function routeAfterPageValidation(
  state: typeof PageState.State,
): "author_page" | "commit_page" | "fail_page" {
  if (state.pageErrors.length === 0) return "commit_page";
  return state.authorCanRetry &&
    state.authorInvocations < MAX_PAGE_AUTHOR_INVOCATIONS
    ? "author_page"
    : "fail_page";
}

/**
 * Validates OKF and exact Claim representation.
 */
function validateAuthoredPage(
  output: PageAuthorOutput,
  claims: readonly Claim[],
): string[] {
  const errors: string[] = [];
  const frontmatter = validateOkfFrontmatter(output.markdown);
  if (!frontmatter.valid) {
    errors.push(
      ...frontmatter.issues.map(
        (issue) =>
          `OKF ${issue.code}${issue.line ? ` line ${issue.line}` : ""}: ${issue.message}`,
      ),
    );
  }
  const fields = parseFrontmatterFields(output.markdown);
  for (const field of ["title", "description"] as const) {
    if (typeof fields?.[field] !== "string" || !fields[field].trim()) {
      errors.push(
        `OKF missing_${field}: Required field \`${field}\` is missing.`,
      );
    }
  }
  const expected = [...claims.map((claim) => claim.id)].sort();
  const represented = [...new Set(output.representedClaimIds)].sort();
  if (represented.length !== output.representedClaimIds.length) {
    errors.push("representedClaimIds contains duplicates.");
  }
  if (JSON.stringify(expected) !== JSON.stringify(represented)) {
    errors.push(
      `representedClaimIds must equal the complete Claim set. Expected ${expected.join(", ")}; received ${represented.join(", ")}.`,
    );
  }
  if (containsHostAbsolutePath(output.markdown)) {
    errors.push("Markdown contains a host-absolute path.");
  }
  for (const link of extractWikiLinkCandidates(output.markdown)) {
    if (!CanonicalPageSchema.safeParse(link).success) {
      errors.push(`Markdown contains non-canonical OpenWiki link ${link}.`);
    }
  }
  return errors;
}

/**
 * Requires a successful author output before commit.
 */
function requireAuthorOutput(state: typeof PageState.State): PageAuthorOutput {
  if (!state.authorOutput) {
    throw new Error(`Missing author output for ${state.job.page}.`);
  }
  return state.authorOutput;
}

/**
 * Extracts canonical `/openwiki/*.md` links for navigation decisions.
 */
function extractCanonicalWikiLinks(markdown: string): string[] {
  return [...extractWikiLinkCandidates(markdown)]
    .filter((link) => CanonicalPageSchema.safeParse(link).success)
    .sort();
}

/**
 * Extracts absolute OpenWiki Markdown link targets before schema validation.
 *
 * @param markdown - Complete authored Markdown.
 * @returns Unique candidate targets.
 */
function extractWikiLinkCandidates(markdown: string): Set<string> {
  const links = new Set<string>();
  for (const match of markdown.matchAll(
    /\[[^\]]*\]\((\/openwiki\/[^)#?]+\.md)(?:#[^)]+)?\)/gu,
  )) {
    links.add(match[1]);
  }
  return links;
}

/**
 * Detects common Unix, macOS, file-URL, and Windows host paths.
 *
 * Canonical `/openwiki/...` links remain allowed. Repository source paths are
 * expected to be relative, so a host-specific prefix is always accidental.
 *
 * @param markdown - Complete authored Markdown.
 * @returns Whether the page leaks a host-absolute path.
 */
function containsHostAbsolutePath(markdown: string): boolean {
  return /(?:file:\/\/\/(?:Users|home|private|tmp|var\/folders)\/|\/(?:Users|home|private|tmp|var\/folders)\/|\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])/iu.test(
    markdown,
  );
}

/**
 * Converts an unknown failure to bounded diagnostic text.
 */
function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1_000,
  );
}

/**
 * Checks the explicit elapsed-time budget for one page workflow.
 *
 * @param startedAt - PageGraph start time from `Date.now()`.
 * @returns Whether another model attempt is forbidden.
 */
function pageDeadlineExceeded(startedAt: number, now: () => number): boolean {
  return now() - startedAt >= MAX_PAGE_ELAPSED_MS;
}

/**
 * Composes caller cancellation with the remaining PageGraph elapsed budget.
 *
 * @param config - Parent runnable configuration.
 * @param startedAt - PageGraph start time.
 * @param now - Injected wall clock.
 * @param createTimeoutSignal - Timeout-signal factory.
 * @returns Attempt configuration bounded by the remaining page budget.
 */
function withPageBudget(
  config: RunnableConfig | undefined,
  startedAt: number,
  now: () => number,
  createTimeoutSignal: (timeoutMs: number) => AbortSignal,
): RunnableConfig {
  const remainingMs = Math.max(0, MAX_PAGE_ELAPSED_MS - (now() - startedAt));
  const timeout = createTimeoutSignal(remainingMs);
  return {
    ...config,
    signal: config?.signal
      ? AbortSignal.any([config.signal, timeout])
      : timeout,
  };
}

/**
 * Identifies deterministic infrastructure failures that must interrupt a run.
 *
 * Model-authored Claim/resource validation remains page-local and repairable;
 * malformed owned persistence and repository I/O cannot safely be treated as
 * a bad proposal.
 *
 * @param error - Unknown Claim reconciliation failure.
 * @returns Whether parent metadata must record an interrupted run.
 */
function isSystemicClaimFailure(error: unknown): boolean {
  return (
    error instanceof ClaimsPersistenceError ||
    error instanceof EvidenceResolutionError
  );
}
