import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  GENERATION_RECURSION_LIMIT,
  MAX_INIT_QA_REPAIR_WAVES,
  MAX_SKELETON_CRITIC_INVOCATIONS,
  MAX_UNKNOWN_UNKNOWN_PASSES,
} from "./config.js";
import type {
  DiscoveryPartition,
  DiscoveryResult,
  GenerationSummary,
  PageJob,
  PageResult,
  QaQuestion,
  QaResult,
  ReviewGap,
} from "./contracts.js";
import { mergePageJobs, mergePageResults, mergeStableIds } from "./jobs.js";
import type { PageGraphRunner } from "./page-graph.js";
import { PendingWorkStore } from "./pending-work-store.js";
import {
  isCancellationFailure,
  type GenerationSpecialists,
} from "./specialists.js";
import { inventoryRepository, type RepositoryInventory } from "./inventory.js";
import { OpenWikiIgnore } from "../openwiki-ignore.js";

/**
 * InitGraph construction dependencies.
 */
export interface InitGraphDependencies {
  /**
   * Absolute repository root.
   */
  rootDir: string;

  /**
   * Active repository read boundary.
   */
  openWikiIgnore: OpenWikiIgnore;

  /**
   * Optional user-authored wiki brief.
   *
   * @default undefined.
   */
  brief?: string;

  /**
   * Durable pending work.
   */
  pending: PendingWorkStore;

  /**
   * Shared page runner.
   */
  pages: PageGraphRunner;

  /**
   * Narrow discovery/review/QA specialists.
   */
  specialists: GenerationSpecialists;
}

/**
 * Init parent state; large page-local content never enters it.
 */
const InitState = Annotation.Root({
  inventory: Annotation<RepositoryInventory | null>,
  partitions: Annotation<DiscoveryPartition[]>,
  activePartition: Annotation<DiscoveryPartition | null>,
  discoveries: Annotation<DiscoveryResult[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
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
  criticPass: Annotation<number>,
  criticGaps: Annotation<ReviewGap[]>,
  unknownPass: Annotation<number>,
  qaWave: Annotation<number>,
  questions: Annotation<QaQuestion[]>,
  activeQuestions: Annotation<QaQuestion[]>,
  qaBatch: Annotation<QaQuestion[]>,
  qaResults: Annotation<QaResult[]>({
    reducer: mergeQaResults,
    default: () => [],
  }),
  summary: Annotation<GenerationSummary | null>,
});

/**
 * Complete custom state sent to one parallel QA verifier task.
 */
interface QaBatchTaskState {
  /**
   * Questions assigned to this verifier task.
   */
  qaBatch: QaQuestion[];

  /**
   * Prior results needed for targeted re-verification context.
   */
  qaResults: QaResult[];

  /**
   * Current verification wave stamped onto returned results.
   */
  qaWave: number;
}

/**
 * Complete initial state supplied to InitGraph.
 */
export interface InitGraphInitialState {
  /**
   * Repository inventory before deterministic discovery.
   */
  inventory: null;

  /**
   * Deterministic discovery partitions before inventory.
   */
  partitions: DiscoveryPartition[];

  /**
   * Per-task discovery partition populated only by `Send`.
   */
  activePartition: null;

  /**
   * Aggregated partition discovery results.
   */
  discoveries: DiscoveryResult[];

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
   * Skeleton critic calls already completed.
   */
  criticPass: number;

  /**
   * Gaps returned by the preceding critic pass.
   */
  criticGaps: ReviewGap[];

  /**
   * Unknown-unknown passes already completed.
   */
  unknownPass: number;

  /**
   * QA repair waves already completed.
   */
  qaWave: number;

  /**
   * Immutable questions created by the finder.
   */
  questions: QaQuestion[];

  /**
   * Questions selected for the next verification wave.
   */
  activeQuestions: QaQuestion[];

  /**
   * Per-task verifier batch populated only by `Send`.
   */
  qaBatch: QaQuestion[];

  /**
   * Aggregated verifier outcomes.
   */
  qaResults: QaResult[];

  /**
   * Terminal summary before finalization.
   */
  summary: null;
}

/**
 * Public invocation surface of the compiled InitGraph.
 */
export interface CompiledInitGraph {
  /**
   * Invokes the graph from complete compact parent state.
   *
   * @param input - Complete initial init state.
   * @param config - Optional runnable configuration.
   * @returns State containing the terminal summary.
   */
  invoke(
    input: InitGraphInitialState,
    config?: RunnableConfig,
  ): Promise<{ summary: GenerationSummary | null }>;
}

/**
 * Creates the explicit repository initialization workflow.
 */
export function createInitGraph(
  dependencies: InitGraphDependencies,
): CompiledInitGraph {
  return new StateGraph(InitState)
    .addNode("inventory_repository", async () => {
      const inventory = await inventoryRepository(
        dependencies.rootDir,
        dependencies.openWikiIgnore,
      );
      return { inventory, partitions: inventory.partitions };
    })
    .addNode("discover_partition", async (state, config) => {
      if (!state.activePartition) {
        throw new Error("Missing discovery partition.");
      }
      const partition = state.activePartition;
      try {
        const discovery = await dependencies.specialists.discover(
          partition,
          dependencies.brief,
          config,
        );
        if (discovery.partitionId !== partition.id) {
          throw new Error(
            `Discovery returned partition ${discovery.partitionId}; expected ${partition.id}.`,
          );
        }
        for (const [index, reason] of discovery.deferrals.entries()) {
          await dependencies.pending.add({
            id: `discovery:${partition.id}:defer:${index}`,
            kind: "review-gap",
            reason,
            sourceHints: partition.roots,
          });
        }
        return { discoveries: [discovery] };
      } catch (error) {
        if (isCancellationFailure(error)) throw error;
        await dependencies.pending.add({
          id: `discovery:${partition.id}:failed`,
          kind: "review-gap",
          reason: `Repository discovery partition failed: ${messageOf(error)}`,
          sourceHints: [...partition.roots, ...partition.manifests],
        });
        return {
          discoveries: [
            {
              partitionId: partition.id,
              jobs: [],
              deferrals: [],
            },
          ],
        };
      }
    })
    .addNode("merge_coverage_plan", (state) => ({
      jobs: mergePageJobs(
        state.discoveries.flatMap((result) =>
          result.jobs
            .filter((job) => job.page !== "/openwiki/quickstart.md")
            .map((job) => ({
              ...job,
              operation: job.operation === "delete" ? "create" : job.operation,
              wave: 0,
            })),
        ),
      ),
    }))
    .addNode("critic", async (state, config) => {
      const nextPass = state.criticPass + 1;
      try {
        const output = await dependencies.specialists.review(
          `Skeleton critic pass ${nextPass} of ${MAX_SKELETON_CRITIC_INVOCATIONS}. Check repository-wide breadth, canonical ownership, cross-system workflows, and whether every major package/service/domain has a substantive home.`,
          {
            inventory: state.inventory,
            plannedJobs: state.jobs,
            priorGaps: state.criticGaps,
            priorPass: state.criticPass,
          },
          config,
        );
        if (nextPass === MAX_SKELETON_CRITIC_INVOCATIONS) {
          for (const gap of output.gaps) {
            await dependencies.pending.addReviewGap(gap);
          }
        }
        return {
          jobs: mergePageJobs([
            ...state.jobs,
            ...output.jobs
              .filter((job) => job.page !== "/openwiki/quickstart.md")
              .map((job) => ({
                ...job,
                operation:
                  job.operation === "delete" ? "repair" : job.operation,
                wave: 0,
              })),
          ]),
          criticGaps: output.gaps,
          criticPass: nextPass,
        };
      } catch (error) {
        if (isCancellationFailure(error)) throw error;
        await dependencies.pending.add({
          id: `review:init:critic:${nextPass}`,
          kind: "review-gap",
          reason: `Skeleton critic pass ${nextPass} unavailable: ${messageOf(error)}`,
          sourceHints: state.inventory?.topLevelEntries ?? [],
        });
        return {
          criticGaps: [],
          criticPass: nextPass,
        };
      }
    })
    .addNode("seed_initial_jobs", async (state) => {
      if (state.jobs.length === 0) {
        throw new Error("Init discovery produced no substantive page jobs.");
      }
      await dependencies.pending.seedJobs(state.jobs);
      return { plannedJobIds: state.jobs.map((job) => job.id) };
    })
    .addNode("run_initial_page", runActivePage(dependencies.pages))
    .addNode("unknown_review", async (state, config) => {
      if (state.unknownPass >= MAX_UNKNOWN_UNKNOWN_PASSES) {
        return { jobs: [] };
      }
      try {
        const output = await dependencies.specialists.review(
          "Perform the single unknown-unknown pass over uncovered high-ranked clusters, one-hop dependencies, and cross-system workflows. Return only real missing canonical page work.",
          { inventory: state.inventory, results: state.results },
          config,
        );
        for (const gap of output.gaps) {
          await dependencies.pending.addReviewGap(gap);
        }
        const jobs = mergePageJobs(
          output.jobs
            .filter((job) => job.page !== "/openwiki/quickstart.md")
            .map((job) => ({
              ...job,
              operation: job.operation === "delete" ? "repair" : job.operation,
              wave: 1,
            })),
        );
        await dependencies.pending.seedJobs(jobs);
        return {
          jobs,
          plannedJobIds: jobs.map((job) => job.id),
          unknownPass: state.unknownPass + 1,
        };
      } catch (error) {
        if (isCancellationFailure(error)) throw error;
        await dependencies.pending.add({
          id: "review:init:unknown-unknown",
          kind: "review-gap",
          reason: `Unknown-unknown review unavailable: ${messageOf(error)}`,
          sourceHints: state.inventory?.topLevelEntries ?? [],
        });
        return {
          jobs: [],
          unknownPass: state.unknownPass + 1,
        };
      }
    })
    .addNode("run_unknown_page", runActivePage(dependencies.pages))
    .addNode("write_quickstart", async (state, config) => {
      const [job] = mergePageJobs([
        {
          page: "/openwiki/quickstart.md",
          operation: "quickstart",
          reasons: ["init:quickstart"],
          sourceHints: state.results
            .filter(
              (result) =>
                result.status === "committed" || result.status === "unchanged",
            )
            .map((result) => result.page),
          wave: 2,
          priority: 1_000,
        },
      ]);
      await dependencies.pending.seedJobs([job]);
      return {
        plannedJobIds: [job.id],
        results: [await dependencies.pages.run(job, config)],
      };
    })
    .addNode("find_questions", async (state, config) => {
      try {
        const questionSet = await dependencies.specialists.findQuestions(
          state.results
            .filter(
              (result) =>
                result.status === "committed" || result.status === "unchanged",
            )
            .map((result) => result.page),
          config,
        );
        assertUniqueQuestionIds(questionSet.questions);
        for (const question of questionSet.questions) {
          await dependencies.pending.add({
            id: `qa:${question.id}`,
            kind: "review-gap",
            reason: question.question,
            sourceHints: [],
          });
        }
        return {
          questions: questionSet.questions,
          activeQuestions: questionSet.questions,
        };
      } catch (error) {
        if (isCancellationFailure(error)) throw error;
        await dependencies.pending.add({
          id: "review:init:question-finder",
          kind: "review-gap",
          reason: `Wiki question finder unavailable: ${messageOf(error)}`,
          sourceHints: [],
        });
        return { questions: [], activeQuestions: [] };
      }
    })
    .addNode("verify_questions", async (state, config) => {
      const previous = state.qaResults
        .filter((result) =>
          state.qaBatch.some((question) => question.id === result.id),
        )
        .map(({ wave: _wave, ...result }) => result);
      try {
        const output = await dependencies.specialists.verifyQuestions(
          state.qaBatch,
          previous,
          config,
        );
        assertExactQaBatch(state.qaBatch, output.results);
        return {
          qaResults: output.results.map((result) => ({
            ...result,
            wave: state.qaWave,
          })),
        };
      } catch (error) {
        if (isCancellationFailure(error)) throw error;
        return {
          qaResults: state.qaBatch.map((question) => ({
            id: question.id,
            status: "fail" as const,
            reason: `Question verification unavailable: ${messageOf(error)}`,
            sourceHints: [],
            wave: state.qaWave,
          })),
        };
      }
    })
    .addNode("plan_qa_repairs", async (state) => {
      const current = state.qaResults.filter(
        (result) => result.wave === state.qaWave,
      );
      const failed = current.filter((result) => result.status !== "pass");
      for (const passed of current.filter(
        (result) => result.status === "pass",
      )) {
        await dependencies.pending.complete(`qa:${passed.id}`);
      }
      if (failed.length === 0 || state.qaWave >= MAX_INIT_QA_REPAIR_WAVES) {
        return { jobs: [], activeQuestions: [] };
      }
      const questionById = new Map(
        state.questions.map((item) => [item.id, item]),
      );
      const jobs = mergePageJobs(
        failed.flatMap((result) =>
          result.page
            ? [
                {
                  page: result.page,
                  operation: "repair" as const,
                  reasons: [`qa:${result.id}`],
                  sourceHints: result.sourceHints,
                  wave: 3 + state.qaWave,
                  priority: 1_000,
                },
              ]
            : [],
        ),
      );
      await dependencies.pending.seedJobs(jobs);
      return {
        jobs,
        plannedJobIds: jobs.map((job) => job.id),
        activeQuestions: failed
          .map((result) => questionById.get(result.id))
          .filter((item): item is QaQuestion => Boolean(item)),
        qaWave: state.qaWave + 1,
      };
    })
    .addNode("run_qa_page", runActivePage(dependencies.pages))
    .addNode("join_qa_repairs", () => ({}))
    .addNode("finalize_init", async (state) => {
      const substantive = state.results.filter(
        (result) =>
          result.page !== "/openwiki/quickstart.md" &&
          (result.status === "committed" || result.status === "unchanged"),
      );
      if (substantive.length === 0) {
        throw new Error("Init produced no safely committed substantive page.");
      }
      const pending = await dependencies.pending.list();
      const count = (status: PageResult["status"]) =>
        state.results.filter((result) => result.status === status).length;
      return {
        summary: {
          status: pending.length === 0 ? "complete" : "partial",
          planned: state.plannedJobIds.length,
          committed: count("committed"),
          unchanged: count("unchanged"),
          deleted: count("deleted"),
          failed: count("failed"),
          deferred: count("deferred"),
          pending: pending.length,
        },
      };
    })
    .addEdge(START, "inventory_repository")
    .addConditionalEdges("inventory_repository", (state) =>
      state.partitions.map(
        (partition) =>
          new Send("discover_partition", { activePartition: partition }),
      ),
    )
    .addEdge("discover_partition", "merge_coverage_plan")
    .addEdge("merge_coverage_plan", "critic")
    .addConditionalEdges("critic", (state) =>
      state.criticPass < MAX_SKELETON_CRITIC_INVOCATIONS
        ? "critic"
        : "seed_initial_jobs",
    )
    .addConditionalEdges("seed_initial_jobs", (state) =>
      state.jobs.map((job) => new Send("run_initial_page", { activeJob: job })),
    )
    .addEdge("run_initial_page", "unknown_review")
    .addConditionalEdges("unknown_review", (state) =>
      state.jobs.length === 0
        ? "write_quickstart"
        : state.jobs.map(
            (job) => new Send("run_unknown_page", { activeJob: job }),
          ),
    )
    .addEdge("run_unknown_page", "write_quickstart")
    .addEdge("write_quickstart", "find_questions")
    .addConditionalEdges("find_questions", routeQaBatches)
    .addEdge("verify_questions", "plan_qa_repairs")
    .addConditionalEdges("plan_qa_repairs", (state) =>
      state.jobs.length === 0
        ? "finalize_init"
        : state.jobs.map((job) => new Send("run_qa_page", { activeJob: job })),
    )
    .addEdge("run_qa_page", "join_qa_repairs")
    .addConditionalEdges("join_qa_repairs", routeQaBatches)
    .addEdge("finalize_init", END)
    .compile()
    .withConfig({
      recursionLimit: GENERATION_RECURSION_LIMIT,
      runName: "InitGraph",
    });
}

/**
 * Creates one parent node that invokes the shared PageGraph.
 *
 * @param pages - Shared page runner.
 * @returns LangGraph node for the current active job.
 */
function runActivePage(pages: PageGraphRunner) {
  return async (state: typeof InitState.State, config?: RunnableConfig) => {
    if (!state.activeJob) {
      throw new Error("InitGraph page node has no active job.");
    }
    return { results: [await pages.run(state.activeJob, config)] };
  };
}

/**
 * Splits stable questions into parallel batches of two or three.
 *
 * @param state - Current compact init state.
 * @returns Finalization or typed verifier sends.
 */
function routeQaBatches(
  state: typeof InitState.State,
): "finalize_init" | Send<"verify_questions", QaBatchTaskState>[] {
  if (state.activeQuestions.length === 0) return "finalize_init";
  const batches: QaQuestion[][] = [];
  for (let index = 0; index < state.activeQuestions.length; index += 3) {
    batches.push(state.activeQuestions.slice(index, index + 3));
  }
  if (batches.length > 1 && batches.at(-1)?.length === 1) {
    const [lastQuestion] = batches.pop()!;
    batches.at(-1)!.push(lastQuestion);
  }
  return batches.map(
    (batch) =>
      new Send("verify_questions", {
        qaBatch: batch,
        qaResults: state.qaResults,
        qaWave: state.qaWave,
      }),
  );
}

/**
 * Rejects duplicate question identities before pending work is seeded.
 *
 * @param questions - Question-finder output.
 */
function assertUniqueQuestionIds(questions: readonly QaQuestion[]): void {
  const ids = questions.map((question) => question.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Question finder returned duplicate question ids.");
  }
}

/**
 * Requires a verifier response for every and only requested question.
 *
 * @param questions - Stable requested batch.
 * @param results - Untrusted verifier result batch.
 */
function assertExactQaBatch(
  questions: readonly QaQuestion[],
  results: readonly Omit<QaResult, "wave">[],
): void {
  const expected = questions.map((question) => question.id).sort();
  const actual = results.map((result) => result.id).sort();
  if (
    new Set(actual).size !== actual.length ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `Verifier ids must exactly match the requested batch. Expected ${expected.join(", ")}; received ${actual.join(", ")}.`,
    );
  }
}

/**
 * Keeps only the newest QA result per stable question ID.
 *
 * @param current - Results already present in parent state.
 * @param update - Parallel verifier results.
 * @returns Stable newest result per question.
 */
function mergeQaResults(
  current: readonly QaResult[],
  update: readonly QaResult[],
): QaResult[] {
  const byId = new Map(current.map((result) => [result.id, result]));
  for (const result of update) {
    const existing = byId.get(result.id);
    if (existing?.wave === result.wave) {
      throw new Error(
        `Question ${result.id} produced duplicate wave ${result.wave}.`,
      );
    }
    if (!existing || result.wave > existing.wave) byId.set(result.id, result);
  }
  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

/**
 * Converts an unknown failure to bounded diagnostic text.
 *
 * @param error - Unknown failure.
 * @returns At most 1,000 diagnostic characters.
 */
function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1_000,
  );
}
