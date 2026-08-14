import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createFilesystemMiddleware, type BackendProtocolV2 } from "deepagents";
import { createAgent } from "langchain";
import type { z } from "zod";
import type { Claim } from "../../claims/core/types.js";
import {
  ClaimProposalSchema,
  DiscoveryResultSchema,
  PageAuthorOutputSchema,
  ReviewOutputSchema,
  type ClaimProposal,
  type DiscoveryPartition,
  type DiscoveryResult,
  type PageAuthorOutput,
  type PageJob,
  type ReviewOutput,
} from "./contracts.js";
import {
  GENERATION_RECURSION_LIMIT,
  SOURCE_RESEARCH_TIMEOUT_MS,
  TOOL_FREE_AUTHOR_TIMEOUT_MS,
} from "./config.js";

/**
 * Inputs for one page Claims reconciliation invocation.
 */
export interface ReconcilePageInput {
  /**
   * Normalized page job.
   */
  job: PageJob;

  /**
   * Existing Markdown, or null for a new page.
   */
  existingMarkdown: string | null;

  /**
   * Existing complete Claims.
   */
  existingClaims: readonly Claim[];

  /**
   * Targeted validation errors from the previous proposal.
   *
   * @default empty on the initial invocation.
   */
  repairErrors?: readonly string[];
}

/**
 * Inputs for one tool-free page-author invocation.
 */
export interface AuthorPageInput {
  /**
   * Normalized page job.
   */
  job: PageJob;

  /**
   * Existing Markdown, or null for a new page.
   */
  existingMarkdown: string | null;

  /**
   * Complete authoritative resolved Claims.
   */
  claims: readonly Claim[];

  /**
   * Targeted validation errors from the previous draft.
   *
   * @default empty on the initial invocation.
   */
  repairErrors?: readonly string[];
}

/**
 * Narrow reasoning capabilities invoked by explicit graph nodes.
 */
export interface GenerationSpecialists {
  /**
   * Researches source and proposes a complete page Claim set.
   */
  reconcilePage(
    input: ReconcilePageInput,
    config?: RunnableConfig,
  ): Promise<ClaimProposal>;

  /**
   * Writes Markdown from complete authoritative Claims without tools.
   */
  authorPage(
    input: AuthorPageInput,
    config?: RunnableConfig,
  ): Promise<PageAuthorOutput>;

  /**
   * Discovers page work for one deterministic repository partition.
   */
  discover(
    partition: DiscoveryPartition,
    brief: string | undefined,
    config?: RunnableConfig,
  ): Promise<DiscoveryResult>;

  /**
   * Plans or reviews bounded work and returns structured jobs/gaps.
   */
  review(
    task: string,
    evidence: unknown,
    config?: RunnableConfig,
  ): Promise<ReviewOutput>;
}

/**
 * Shared read-only filesystem tools for source-research specialists.
 */
const READ_ONLY_FILESYSTEM_TOOLS = ["read_file", "ls", "glob", "grep"] as const;

/**
 * Creates the production specialist set over one sandboxed backend.
 *
 * @param model - Configured run model.
 * @param backend - Repository backend enforcing ignore and Claims boundaries.
 * @returns Narrow structured specialists.
 */
export function createGenerationSpecialists(
  model: BaseChatModel,
  backend: BackendProtocolV2,
): GenerationSpecialists {
  let circuitFailure: Error | undefined;
  const circuitController = new AbortController();
  const filesystem = () =>
    createFilesystemMiddleware({
      backend,
      tools: READ_ONLY_FILESYSTEM_TOOLS,
      toolTokenLimitBeforeEvict: null,
      humanMessageTokenLimitBeforeEvict: null,
      systemPrompt:
        "Filesystem / is the repository root. Read source and tests only. Never attempt to mutate files, inspect .git, read .env files, or access /openwiki/.claims.",
    });

  /**
   * Invokes one specialist while sharing terminal provider failure state.
   *
   * @param agent - Structured specialist graph.
   * @param schema - Authoritative response schema.
   * @param prompt - JSON task payload.
   * @param timeoutMs - Specialist-specific elapsed-time budget.
   * @param config - Optional parent runnable configuration.
   * @returns Parsed specialist output.
   */
  async function invoke<Schema extends z.ZodType>(
    agent: StructuredAgent,
    schema: Schema,
    prompt: string,
    timeoutMs: number,
    config?: RunnableConfig,
  ): Promise<z.output<Schema>> {
    if (circuitFailure !== undefined) {
      throw circuitFailure;
    }
    try {
      return await invokeStructured(
        agent,
        schema,
        prompt,
        withTimeout(config, timeoutMs, circuitController.signal),
      );
    } catch (error) {
      if (isCircuitBreakingSpecialistFailure(error)) {
        circuitFailure =
          error instanceof Error ? error : new Error(String(error));
        circuitController.abort(circuitFailure);
      }
      throw error;
    }
  }

  const reconciler = createAgent({
    model,
    tools: [],
    middleware: [filesystem()],
    responseFormat: ClaimProposalSchema,
    systemPrompt: `You reconcile the complete material factual Claim set for one OpenWiki page.
Inspect the supplied source hints, then follow owning entrypoints, implementations, callers, dependencies, and focused tests far enough to establish current behavior.
Return every material repository fact the page should state, not a mutation list. Preserve an existing Claim id only when the same proposition remains. Omit ids for new Claims. Evidence resources use repo://path#symbol when a unique supported symbol exists and repo://path otherwise. Never invent evidence versions.
Return delete only when the job itself is a delete job and inspected current source proves the page no longer has a canonical subject. Return defer only when safe evidence is unavailable.`,
  }).withConfig({
    recursionLimit: GENERATION_RECURSION_LIMIT,
    runName: "claims_reconciler",
  }) as unknown as StructuredAgent;

  const author = createAgent({
    model,
    tools: [],
    responseFormat: PageAuthorOutputSchema,
    systemPrompt: `Write one dense OpenWiki Markdown concept page from the complete authoritative Claims supplied by the caller.
The Claims are the only allowed source of material repository facts. Explain relationships and ordering without adding unsupported APIs, files, behavior, or negative-existential claims. Preserve accurate useful structure from existing Markdown when present.
Every concept page starts with valid OKF YAML front matter including type, title, and a search-oriented description. Use stable paths/symbols rather than line numbers. Include focused tests and narrow validation only when Claims establish them. Return every Claim id exactly once in representedClaimIds. Do not include Claim ids in Markdown.`,
  }).withConfig({
    recursionLimit: GENERATION_RECURSION_LIMIT,
    runName: "page_author",
  }) as unknown as StructuredAgent;

  const discovery = createAgent({
    model,
    tools: [],
    middleware: [filesystem()],
    responseFormat: DiscoveryResultSchema,
    systemPrompt: `Discover substantive documentation work for one repository partition.
Inspect runtime entrypoints, composition/registration, primary implementation, public types/schemas/configuration, persistence/state, upstream and downstream boundaries, and representative focused tests. Propose canonical pages rather than copying the directory tree. A major service, package, independent domain, or cross-system workflow needs a canonical home. Return evidence-backed source hints; do not write Markdown.`,
  }).withConfig({
    recursionLimit: GENERATION_RECURSION_LIMIT,
    runName: "repository_discovery",
  }) as unknown as StructuredAgent;

  const reviewer = createAgent({
    model,
    tools: [],
    middleware: [filesystem()],
    responseFormat: ReviewOutputSchema,
    systemPrompt: `Perform exactly the bounded OpenWiki planning or review task supplied by the caller.
Inspect source and tests read-only. Return concrete canonical page jobs for repairable documentation work and stable gaps for evidence-blocked or unresolved work. When the task supplies prior pending items, include an id in resolvedPendingIds only after current evidence proves that exact obligation is satisfied or obsolete. Never write files, mutate Claims, create TODOs, or decide graph control flow.`,
  }).withConfig({
    recursionLimit: GENERATION_RECURSION_LIMIT,
    runName: "generation_reviewer",
  }) as unknown as StructuredAgent;

  return {
    async reconcilePage(input, config) {
      return invoke(
        reconciler,
        ClaimProposalSchema,
        JSON.stringify(input),
        SOURCE_RESEARCH_TIMEOUT_MS,
        config,
      );
    },
    async authorPage(input, config) {
      return invoke(
        author,
        PageAuthorOutputSchema,
        JSON.stringify(input),
        TOOL_FREE_AUTHOR_TIMEOUT_MS,
        config,
      );
    },
    async discover(partition, brief, config) {
      return invoke(
        discovery,
        DiscoveryResultSchema,
        JSON.stringify({ partition, brief }),
        SOURCE_RESEARCH_TIMEOUT_MS,
        config,
      );
    },
    async review(task, evidence, config) {
      return invoke(
        reviewer,
        ReviewOutputSchema,
        JSON.stringify({ task, evidence }),
        SOURCE_RESEARCH_TIMEOUT_MS,
        config,
      );
    },
  };
}

/**
 * Minimal structured-agent invocation surface.
 */
interface StructuredAgent {
  /**
   * Invokes an agent and returns its graph state.
   */
  invoke(
    input: { messages: Array<{ role: "user"; content: string }> },
    config?: RunnableConfig,
  ): Promise<{ structuredResponse?: unknown }>;
}

/**
 * Invokes and independently validates one structured specialist response.
 *
 * @param agent - Structured agent graph.
 * @param schema - Authoritative response schema.
 * @param prompt - JSON task payload.
 * @param config - Optional parent runnable configuration.
 * @returns Parsed structured output.
 */
async function invokeStructured<Schema extends z.ZodType>(
  agent: StructuredAgent,
  schema: Schema,
  prompt: string,
  config?: RunnableConfig,
): Promise<z.output<Schema>> {
  const result = await agent.invoke(
    { messages: [{ role: "user", content: prompt }] },
    config,
  );
  return schema.parse(result.structuredResponse);
}

/**
 * Adds a specialist timeout without discarding a caller cancellation signal.
 *
 * @param config - Optional parent runnable configuration.
 * @param timeoutMs - Positive timeout budget in milliseconds.
 * @param circuitSignal - Shared provider circuit cancellation signal.
 * @returns Runnable configuration with a composed abort signal.
 */
function withTimeout(
  config: RunnableConfig | undefined,
  timeoutMs: number,
  circuitSignal: AbortSignal,
): RunnableConfig {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    ...config,
    signal: AbortSignal.any(
      config?.signal
        ? [config.signal, timeout, circuitSignal]
        : [timeout, circuitSignal],
    ),
  };
}

/**
 * Classifies failures safe for one bounded specialist retry.
 *
 * Authentication, authorization, quota, invalid request, and cancellation are
 * terminal because repeating them cannot repair the request.
 *
 * @param error - Unknown specialist invocation failure.
 * @returns Whether retrying the same bounded operation can plausibly succeed.
 */
export function isRetryableSpecialistFailure(error: unknown): boolean {
  const candidate = specialistFailureDetails(error);
  const status = candidate.status;
  if ([400, 401, 402, 403, 404, 405, 406, 407, 409].includes(status ?? 0)) {
    return false;
  }
  if (isCircuitBreakingSpecialistFailure(error)) return false;
  return !isCancellationFailure(error);
}

/**
 * Identifies provider-wide failures that should suppress sibling specialists.
 *
 * Request-specific validation errors and caller cancellation are deliberately
 * excluded: neither proves that another specialist is unable to make progress.
 * A plain HTTP 429 is also excluded because transient rate limiting is
 * retryable; quota exhaustion must carry a provider quota or billing code.
 *
 * @param error - Unknown specialist invocation failure.
 * @returns Whether the shared specialist circuit should open.
 */
export function isCircuitBreakingSpecialistFailure(error: unknown): boolean {
  const { status, code, type } = specialistFailureDetails(error);
  if ([401, 402, 403, 407].includes(status ?? 0)) return true;
  return [code, type].some((value) =>
    /(?:auth(?:entication|orization)?|api[_-]?key|billing|credit|quota)/iu.test(
      value ?? "",
    ),
  );
}

/**
 * Identifies an abort-shaped failure, excluding elapsed-time timeout signals.
 *
 * @param error - Unknown specialist failure.
 * @returns Whether the failure has the platform AbortError shape.
 */
export function isCancellationFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Normalized provider failure fields used by retry and circuit decisions.
 */
interface SpecialistFailureDetails {
  /**
   * HTTP-like response status, when supplied by the provider SDK.
   */
  status?: number;

  /**
   * Provider error code, when supplied.
   */
  code?: string;

  /**
   * Provider error type, when supplied.
   */
  type?: string;
}

/**
 * Extracts common provider failure fields without depending on one SDK.
 *
 * @param error - Unknown provider failure.
 * @returns Normalized status, code, and type fields.
 */
function specialistFailureDetails(error: unknown): SpecialistFailureDetails {
  if (typeof error !== "object" || error === null) return {};
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    type?: unknown;
    response?: { status?: unknown };
    error?: { code?: unknown; type?: unknown };
  };
  const status = candidate.response?.status ?? candidate.status;
  const code = candidate.error?.code ?? candidate.code;
  const type = candidate.error?.type ?? candidate.type;
  return {
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof type === "string" ? { type } : {}),
  };
}
