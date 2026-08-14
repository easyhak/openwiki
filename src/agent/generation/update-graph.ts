import { createHash } from "node:crypto";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";
import { ClaimsStore } from "../../claims/brains/code/store.js";
import { runClaimsPreflight } from "../../claims/brains/code/preflight.js";
import { parseRepositoryEvidenceResource } from "../../claims/evidence/repository/resource.js";
import type { EvidenceResolver } from "../../claims/core/types.js";
import { OpenWikiIgnore } from "../openwiki-ignore.js";
import type { RunContext } from "../types.js";
import {
  GENERATION_RECURSION_LIMIT,
  MAX_PLANNER_INVOCATIONS,
  MAX_UPDATE_REPAIR_WAVES,
} from "./config.js";
import {
  type GenerationSummary,
  type PageJob,
  type PageResult,
  type PendingWorkItem,
  type ReviewOutput,
} from "./contracts.js";
import { collectGitDelta, type GitDelta } from "./git-delta.js";
import {
  mergePageJobs,
  mergePageResults,
  mergeStableIds,
  type ProposedPageJob,
} from "./jobs.js";
import type { PageGraphRunner } from "./page-graph.js";
import { PendingWorkStore } from "./pending-work-store.js";
import {
  isRetryableSpecialistFailure,
  type GenerationSpecialists,
} from "./specialists.js";

/**
 * UpdateGraph construction dependencies.
 */
export interface UpdateGraphDependencies {
  /**
   * Absolute repository root.
   */
  rootDir: string;

  /**
   * Current run context and prior Git head.
   */
  context: RunContext;

  /**
   * Active repository read boundary.
   */
  openWikiIgnore: OpenWikiIgnore;

  /**
   * Claims persistence.
   */
  claimsStore: ClaimsStore;

  /**
   * Deterministic evidence resolver.
   */
  resolver: EvidenceResolver;

  /**
   * Durable pending work.
   */
  pending: PendingWorkStore;

  /**
   * Shared page runner.
   */
  pages: PageGraphRunner;

  /**
   * Narrow planners/reviewers.
   */
  specialists: GenerationSpecialists;

  /**
   * Optional user instruction added to planning evidence.
   *
   * @default undefined.
   */
  userMessage?: string;
}

/**
 * UpdateGraph parent state containing compact serializable values only.
 */
const UpdateState = Annotation.Root({
  delta: Annotation<GitDelta | null>,
  inheritedPending: Annotation<PendingWorkItem[]>,
  jobs: Annotation<PageJob[]>,
  activeJob: Annotation<PageJob | null>,
  results: Annotation<PageResult[]>({
    reducer: mergePageResults,
    default: () => [],
  }),
  plannedJobIds: Annotation<string[]>({
    reducer: mergeStableIds,
    default: () => [],
  }),
  reviewWave: Annotation<number>,
  plannerInvocations: Annotation<number>,
  summary: Annotation<GenerationSummary | null>,
});

/**
 * Complete initial state supplied to UpdateGraph.
 */
export interface UpdateGraphInitialState {
  /**
   * Git delta before deterministic preparation.
   */
  delta: null;

  /**
   * Durable work inherited before preparation.
   */
  inheritedPending: PendingWorkItem[];

  /**
   * Current normalized page wave.
   */
  jobs: PageJob[];

  /**
   * Per-task page job populated only by `Send`.
   */
  activeJob: null;

  /**
   * Aggregated page outcomes.
   */
  results: PageResult[];

  /**
   * Stable identifiers for every planned job.
   */
  plannedJobIds: string[];

  /**
   * Number of changed-surface repair waves already planned.
   */
  reviewWave: number;

  /**
   * Number of impact-planner calls already made.
   */
  plannerInvocations: number;

  /**
   * Terminal summary before finalization.
   */
  summary: null;
}

/**
 * Public invocation surface of the compiled UpdateGraph.
 */
export interface CompiledUpdateGraph {
  /**
   * Invokes the graph from complete compact parent state.
   *
   * @param input - Complete initial update state.
   * @param config - Optional runnable configuration.
   * @returns State containing the terminal summary.
   */
  invoke(
    input: UpdateGraphInitialState,
    config?: RunnableConfig,
  ): Promise<{ summary: GenerationSummary | null }>;
}

/**
 * Creates an explicit incremental update workflow.
 *
 * @param dependencies - Update services closed over by graph nodes.
 * @returns Compiled update graph.
 */
export function createUpdateGraph(
  dependencies: UpdateGraphDependencies,
): CompiledUpdateGraph {
  return new StateGraph(UpdateState)
    .addNode("prepare_update", async (state, config) => {
      const [preflight, priorPending, delta] = await Promise.all([
        runClaimsPreflight(dependencies.claimsStore, dependencies.resolver),
        dependencies.pending.list(),
        collectGitDelta(
          dependencies.rootDir,
          dependencies.context.lastUpdate?.gitHead,
          dependencies.openWikiIgnore,
        ),
      ]);
      const fallback = await buildDeterministicJobs(
        dependencies.claimsStore,
        preflight.context.issues,
        priorPending,
        delta,
      );
      let planned: ProposedPageJob[] = [];
      let plannerInvocations = 0;
      let plannerFailure: unknown;
      const planningRequired =
        fallback.length > 0 ||
        delta.changes.length > 0 ||
        priorPending.some((item) => item.kind !== "translation") ||
        Boolean(dependencies.userMessage?.trim());
      while (planningRequired && plannerInvocations < MAX_PLANNER_INVOCATIONS) {
        plannerInvocations += 1;
        try {
          const output = await dependencies.specialists.review(
            "Plan every OpenWiki page affected by this update. Preserve mandatory Claims and pending jobs. Return no formatting-only work.",
            {
              delta,
              mandatoryJobs: fallback,
              priorPending,
              userMessage: dependencies.userMessage,
              priorFailure:
                plannerFailure instanceof Error
                  ? plannerFailure.message
                  : plannerFailure,
            },
            config,
          );
          planned = output.jobs.map((job) => ({
            ...job,
            operation: job.operation === "delete" ? "reconcile" : job.operation,
            wave: 0,
          }));
          const priorPendingIds = new Set(
            priorPending
              .filter(isReviewerResolvablePending)
              .map((item) => item.id),
          );
          await dependencies.pending.completeMany([
            ...output.resolvedPendingIds.filter((id) =>
              priorPendingIds.has(id),
            ),
            "review:update:planner",
          ]);
          for (const gap of output.gaps) {
            await dependencies.pending.addReviewGap(gap);
          }
          plannerFailure = undefined;
          break;
        } catch (error) {
          if (config?.signal?.aborted) throw error;
          plannerFailure = error;
          if (!isRetryableSpecialistFailure(error)) break;
        }
      }
      if (plannerFailure) {
        await dependencies.pending.add({
          id: "review:update:planner",
          kind: "review-gap",
          reason: `Update impact planner unavailable: ${messageOf(plannerFailure)}`,
          sourceHints: boundedSourceHints(
            delta.changes.map((change) => change.path),
          ),
        });
        for (const change of delta.changes) {
          const changePaths = [change.path, change.previousPath].filter(
            (value): value is string => Boolean(value),
          );
          const mapped = fallback.some((job) =>
            job.sourceHints.some((hint) => changePaths.includes(hint)),
          );
          if (!mapped) {
            await dependencies.pending.add({
              id: unmappedChangeId(change),
              kind: "unmapped-change",
              reason: `Impact planner failed; source change ${change.status} ${change.path} remains unmapped.`,
              sourceHints: boundedSourceHints(changePaths),
            });
          }
        }
      }
      const deterministicDeletePages = new Set(
        fallback
          .filter((job) => job.operation === "delete")
          .map((job) => job.page),
      );
      const jobs = mergePageJobs([
        ...fallback,
        ...planned.filter((job) => !deterministicDeletePages.has(job.page)),
      ]);
      if (jobs.length > 0) {
        await dependencies.pending.seedJobs(jobs);
      }
      return {
        delta,
        inheritedPending: priorPending,
        jobs,
        plannedJobIds: jobs.map((job) => job.id),
        plannerInvocations,
      };
    })
    .addNode("run_page", async (state, config) => {
      if (!state.activeJob) {
        throw new Error("UpdateGraph run_page received no active job.");
      }
      return {
        results: [await dependencies.pages.run(state.activeJob, config)],
      };
    })
    .addNode("review_changed_surface", async (state, config) => {
      if (state.reviewWave >= MAX_UPDATE_REPAIR_WAVES) {
        return { jobs: [] };
      }
      let output: ReviewOutput;
      try {
        output = await dependencies.specialists.review(
          "Review only the changed source surface and affected generated pages. Return repair jobs for material missing, stale, or unsupported content. Do not broaden into a full init review.",
          { delta: state.delta, results: state.results },
          config,
        );
      } catch (error) {
        if (config?.signal?.aborted) throw error;
        await dependencies.pending.add({
          id: `review:update:${state.reviewWave}`,
          kind: "review-gap",
          reason: `Changed-surface review unavailable: ${messageOf(error)}`,
          sourceHints: boundedSourceHints(
            state.delta?.changes.map((item) => item.path) ?? [],
          ),
        });
        return { jobs: [], reviewWave: state.reviewWave + 1 };
      }
      const currentPendingIds = new Set(
        (await dependencies.pending.list())
          .filter(isReviewerResolvablePending)
          .map((item) => item.id),
      );
      await dependencies.pending.completeMany([
        ...output.resolvedPendingIds.filter((id) => currentPendingIds.has(id)),
        `review:update:${state.reviewWave}`,
      ]);
      for (const gap of output.gaps) {
        await dependencies.pending.addReviewGap(gap);
      }
      const jobs = mergePageJobs(
        output.jobs.map((job) => ({
          ...job,
          operation: "repair" as const,
          wave: state.reviewWave + 1,
        })),
      );
      await dependencies.pending.seedJobs(jobs);
      return {
        jobs,
        plannedJobIds: jobs.map((job) => job.id),
        reviewWave: state.reviewWave + 1,
      };
    })
    .addNode("finalize_update", async (state) => {
      const resultByPage = new Map(
        state.results.map((result) => [result.page, result]),
      );
      const completedInheritedIds = state.inheritedPending
        .filter((item) => {
          if (!item.page) return false;
          const result = resultByPage.get(item.page);
          return (
            result?.status === "committed" ||
            result?.status === "unchanged" ||
            result?.status === "deleted"
          );
        })
        .map((item) => item.id);
      if (completedInheritedIds.length > 0) {
        await dependencies.pending.completeMany(completedInheritedIds);
      }
      const pending = await dependencies.pending.list();
      const summary = summarize(
        state.results,
        state.plannedJobIds.length,
        pending.length,
      );
      return { summary };
    })
    .addEdge(START, "prepare_update")
    .addConditionalEdges("prepare_update", routeJobs)
    .addEdge("run_page", "review_changed_surface")
    .addConditionalEdges("review_changed_surface", routeJobs)
    .addEdge("finalize_update", END)
    .compile()
    .withConfig({
      recursionLimit: GENERATION_RECURSION_LIMIT,
      runName: "UpdateGraph",
    });
}

/**
 * Routes a normalized wave to parallel PageGraph tasks or finalization.
 */
function routeJobs(
  state: typeof UpdateState.State,
): "finalize_update" | Send<"run_page", { activeJob: PageJob }>[] {
  return state.jobs.length === 0
    ? "finalize_update"
    : state.jobs.map((job) => new Send("run_page", { activeJob: job }));
}

/**
 * Builds mandatory and evidence-index fallback work without a model.
 */
async function buildDeterministicJobs(
  store: ClaimsStore,
  issues: Awaited<ReturnType<typeof runClaimsPreflight>>["context"]["issues"],
  pending: readonly PendingWorkItem[],
  delta: GitDelta,
): Promise<ProposedPageJob[]> {
  const jobs: ProposedPageJob[] = issues.map((issue) => ({
    page: issue.page,
    operation: "reconcile",
    reasons: [`claims:${issue.kind}:${issue.claimId ?? "page"}`],
    sourceHints: issue.resources ?? [],
    wave: 0,
    priority: 1_000,
  }));
  for (const item of pending) {
    if (!item.page || item.kind === "translation") continue;
    jobs.push({
      page: item.page,
      operation: "repair",
      reasons: [item.id],
      sourceHints: item.sourceHints,
      wave: 0,
      priority: 900,
    });
  }
  const changedPaths = new Set(
    delta.changes.flatMap((change) =>
      [change.path, change.previousPath].filter((value): value is string =>
        Boolean(value),
      ),
    ),
  );
  const deletedPaths = new Set(
    delta.changes
      .filter((change) => change.status === "D")
      .map((change) => change.path),
  );
  for (const page of await store.discoverPages()) {
    const pageClaims = await store.loadPage(page);
    if (!pageClaims) continue;
    const matched = new Set<string>();
    const evidencePaths: string[] = [];
    let repositoryEvidenceOnly = pageClaims.claims.length > 0;
    for (const claim of pageClaims.claims) {
      for (const evidence of claim.evidence) {
        try {
          const parsed = parseRepositoryEvidenceResource(evidence.resource);
          evidencePaths.push(parsed.path);
          if (changedPaths.has(parsed.path)) matched.add(parsed.path);
        } catch {
          // Another evidence namespace cannot participate in repo-path fallback.
          repositoryEvidenceOnly = false;
        }
      }
    }
    const deletionProvenance = [...new Set(evidencePaths)];
    if (
      repositoryEvidenceOnly &&
      deletionProvenance.length > 0 &&
      deletionProvenance.every((resourcePath) => deletedPaths.has(resourcePath))
    ) {
      jobs.push({
        page,
        operation: "delete",
        reasons: ["git:all-evidence-files-deleted"],
        sourceHints: boundedSourceHints(deletionProvenance),
        wave: 0,
        priority: 950,
      });
    } else if (matched.size > 0) {
      jobs.push({
        page,
        operation: "reconcile",
        reasons: ["git:evidence-match"],
        sourceHints: boundedSourceHints([...matched]),
        wave: 0,
        priority: 800,
      });
    }
  }
  const deterministicDeletePages = new Set(
    jobs.filter((job) => job.operation === "delete").map((job) => job.page),
  );
  return jobs.map((job) =>
    deterministicDeletePages.has(job.page)
      ? { ...job, operation: "delete" as const }
      : job,
  );
}

/**
 * Computes the terminal update summary from compact results.
 */
function summarize(
  results: readonly PageResult[],
  planned: number,
  pending: number,
): GenerationSummary {
  const count = (status: PageResult["status"]) =>
    results.filter((result) => result.status === status).length;
  return {
    status: pending === 0 ? "complete" : "partial",
    planned,
    committed: count("committed"),
    unchanged: count("unchanged"),
    deleted: count("deleted"),
    failed: count("failed"),
    deferred: count("deferred"),
    pending,
  };
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
 * Bounds and canonicalizes source hints before durable persistence.
 *
 * @param paths - Candidate repository paths.
 * @returns At most one hundred unique stable paths.
 */
function boundedSourceHints(paths: readonly string[]): string[] {
  return [...new Set(paths)]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 100);
}

/**
 * Creates a bounded stable ID for one unmapped Git change.
 *
 * @param change - Current unmapped repository change.
 * @returns Content-derived pending-work identifier.
 */
function unmappedChangeId(change: GitDelta["changes"][number]): string {
  const identity = JSON.stringify([
    change.status,
    change.previousPath ?? "",
    change.path,
  ]);
  return `unmapped:${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

/**
 * Restricts model-resolved work to reviewer-owned semantic obligations.
 *
 * Page jobs are completed only by page transactions/finalization, while
 * translation and finalizer work are owned by their dedicated lifecycle steps.
 *
 * @param item - Durable pending obligation.
 * @returns Whether a reviewer may mark the item resolved or obsolete.
 */
function isReviewerResolvablePending(item: PendingWorkItem): boolean {
  return item.kind === "review-gap" || item.kind === "unmapped-change";
}
