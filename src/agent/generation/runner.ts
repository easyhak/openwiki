import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { GraphRecursionError } from "@langchain/langgraph";
import { runClaimsPreflight } from "../../claims/brains/code/preflight.js";
import { ClaimsStore } from "../../claims/brains/code/store.js";
import { RepositoryEvidenceResolver } from "../../claims/evidence/repository/resolver.js";
import {
  resolveConceptTypeLabel,
  resolveIndexLabels,
} from "../../okf/index-labels.js";
import { migrateWikiToOkf } from "../../okf/index-sync.js";
import { OpenWikiLocalShellBackend } from "../docs-only-backend.js";
import { OpenWikiIgnore } from "../openwiki-ignore.js";
import { resolveTranslationPlan } from "../translation-middleware.js";
import type {
  OpenWikiCommand,
  OpenWikiRunOptions,
  RunContext,
} from "../types.js";
import {
  GENERATION_RECURSION_LIMIT,
  resolveGenerationConcurrency,
} from "./config.js";
import type { GenerationSummary } from "./contracts.js";
import { runGenerationFinalizers } from "./finalizers.js";
import { runInitGraph } from "./init-graph.js";
import { PageCommitter } from "./page-commit.js";
import { createPageGraphRunner } from "./page-graph.js";
import { PendingWorkStore } from "./pending-work-store.js";
import { createGenerationSpecialists } from "./specialists.js";
import { runUpdateGraph } from "./update-graph.js";

/**
 * Inputs for one repository LangGraph generation run.
 */
export interface GenerationRunnerInput {
  /**
   * Init or update command.
   */
  command: Exclude<OpenWikiCommand, "chat">;

  /**
   * Absolute repository root.
   */
  cwd: string;

  /**
   * Configured run model.
   */
  model: BaseChatModel;

  /**
   * Persisted run context.
   */
  context: RunContext;

  /**
   * Active repository read boundary.
   */
  openWikiIgnore: OpenWikiIgnore;

  /**
   * Public run options and event sinks.
   */
  options: OpenWikiRunOptions;

  /**
   * LangSmith trace/thread identifier.
   */
  threadId: string;
}

/**
 * Checks deterministic Claims state without constructing the legacy session.
 *
 * @param cwd - Absolute repository root.
 * @param openWikiIgnore - Active repository read boundary.
 * @returns Whether stale, ungrounded, mismatched, or orphan state blocks no-op.
 */
export async function generationClaimsRequireAttention(
  cwd: string,
  openWikiIgnore: OpenWikiIgnore,
): Promise<boolean> {
  const claimsStore = new ClaimsStore(cwd);
  const resolver = new RepositoryEvidenceResolver({
    rootDir: cwd,
    openWikiIgnore,
  });
  const preflight = await runClaimsPreflight(claimsStore, resolver);
  return (
    preflight.context.issues.length > 0 || preflight.orphanPages.length > 0
  );
}

/**
 * Runs one explicit init or update graph and its shared finalizers.
 *
 * @param input - Prepared repository generation runtime.
 * @returns Terminal summary including finalizer/pending state.
 */
export async function runGenerationWorkflow(
  input: GenerationRunnerInput,
): Promise<GenerationSummary> {
  const backend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    openWikiIgnore: input.openWikiIgnore,
    maxOutputBytes: 100_000,
    outputMode: "repository",
    rootDir: input.cwd,
    timeout: 120,
    virtualMode: true,
  });
  const claimsStore = new ClaimsStore(input.cwd);
  const resolver = new RepositoryEvidenceResolver({
    rootDir: input.cwd,
    openWikiIgnore: input.openWikiIgnore,
  });
  const pending = new PendingWorkStore(input.cwd);
  const specialists = createGenerationSpecialists(input.model, backend);
  const committer = new PageCommitter(input.cwd, claimsStore, pending);
  const pages = createPageGraphRunner({
    rootDir: input.cwd,
    claimsStore,
    resolver,
    specialists,
    committer,
  });
  const concurrency = resolveGenerationConcurrency(
    input.options.generationConcurrency,
  );
  input.options.onEvent?.({
    type: "text",
    text: `OpenWiki ${input.command} graph started (concurrency ${concurrency}).\n\n`,
  });
  await migrateWikiToOkf(
    backend,
    "repository",
    resolveConceptTypeLabel(input.context.language),
  );
  const config = {
    configurable: { thread_id: input.threadId },
    maxConcurrency: concurrency,
    recursionLimit: GENERATION_RECURSION_LIMIT,
    tags: ["openwiki", "architecture:langgraph", `command:${input.command}`],
  };
  let summary: GenerationSummary;
  try {
    summary =
      input.command === "init"
        ? await runInitGraph(
            {
              rootDir: input.cwd,
              openWikiIgnore: input.openWikiIgnore,
              brief:
                input.options.userMessage?.trim() || input.context.wikiGoal,
              pending,
              pages,
              specialists,
            },
            config,
          )
        : await runUpdateGraph(
            {
              rootDir: input.cwd,
              context: input.context,
              openWikiIgnore: input.openWikiIgnore,
              claimsStore,
              resolver,
              pending,
              pages,
              specialists,
              userMessage: input.options.userMessage ?? undefined,
            },
            config,
          );
  } catch (error) {
    if (error instanceof GraphRecursionError) {
      throw new Error(
        "OpenWiki generation reached its 10,000-step emergency recursion fuse; committed pages were preserved and unfinished jobs remain pending.",
        { cause: error },
      );
    }
    throw error;
  }
  const translation = resolveTranslationPlan(
    input.command,
    input.context.language,
    input.context.lastUpdate?.language,
  );
  await runGenerationFinalizers({
    backend,
    model: input.model,
    indexLabels: resolveIndexLabels(input.context.language),
    conceptType: resolveConceptTypeLabel(input.context.language),
    claimsStore,
    resolver,
    pending,
    translation,
    onWarning: (message) => {
      input.options.onEvent?.({ type: "text", text: `${message}\n\n` });
      process.stderr.write(`${message}\n`);
    },
    onStatus: (message) =>
      input.options.onEvent?.({ type: "text", text: `${message}\n\n` }),
  });
  const pendingCount = (await pending.list()).length;
  summary = {
    ...summary,
    status: pendingCount === 0 ? "complete" : "partial",
    pending: pendingCount,
  };
  input.options.onEvent?.({
    type: "text",
    text:
      summary.status === "complete"
        ? `OpenWiki ${input.command} graph completed.\n`
        : `OpenWiki ${input.command} saved partial progress; ${pendingCount} item(s) will be retried.\n`,
  });
  return summary;
}
