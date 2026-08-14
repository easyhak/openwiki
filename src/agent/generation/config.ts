/**
 * Emergency graph-step fuse inherited from the current DeepAgents runtime.
 */
export const GENERATION_RECURSION_LIMIT = 10_000;

/**
 * Default number of LangGraph tasks allowed to execute concurrently.
 */
export const DEFAULT_GENERATION_CONCURRENCY = 4;

/**
 * Maximum accepted generation concurrency.
 */
export const MAX_GENERATION_CONCURRENCY = 8;

/**
 * Maximum impact-planner invocations including the initial attempt.
 */
export const MAX_PLANNER_INVOCATIONS = 2;

/**
 * Maximum Claims-reconciler invocations including targeted repairs.
 */
export const MAX_CLAIM_RECONCILER_INVOCATIONS = 3;

/**
 * Maximum page-author invocations including targeted repairs.
 */
export const MAX_PAGE_AUTHOR_INVOCATIONS = 3;

/**
 * Maximum skeleton-critic invocations for one init.
 */
export const MAX_SKELETON_CRITIC_INVOCATIONS = 2;

/**
 * Maximum repository-wide unknown-unknown review passes.
 */
export const MAX_UNKNOWN_UNKNOWN_PASSES = 1;

/**
 * Maximum init QA repair waves after initial verification.
 */
export const MAX_INIT_QA_REPAIR_WAVES = 2;

/**
 * Maximum update repair waves after changed-surface review.
 */
export const MAX_UPDATE_REPAIR_WAVES = 1;

/**
 * Maximum wall time for one source-research specialist invocation.
 */
export const SOURCE_RESEARCH_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * Maximum wall time for one tool-free author invocation.
 */
export const TOOL_FREE_AUTHOR_TIMEOUT_MS = 3 * 60 * 1_000;

/**
 * Maximum elapsed time across all attempts for one PageGraph.
 */
export const MAX_PAGE_ELAPSED_MS = 12 * 60 * 1_000;

/**
 * Environment key temporarily selecting the migration arm.
 */
export const GENERATION_ARCHITECTURE_ENV_KEY =
  "OPENWIKI_GENERATION_ARCHITECTURE";

/**
 * Environment key overriding bounded generation concurrency.
 */
export const GENERATION_CONCURRENCY_ENV_KEY = "OPENWIKI_GENERATION_CONCURRENCY";

/**
 * Repository-generation implementation selected for one run.
 */
export type GenerationArchitecture = "legacy" | "langgraph";

/**
 * Resolves the temporary migration selector.
 *
 * @param explicit - Optional caller override.
 * @returns Valid architecture, defaulting to the legacy control arm.
 */
export function resolveGenerationArchitecture(
  explicit?: GenerationArchitecture,
): GenerationArchitecture {
  if (explicit) {
    return explicit;
  }
  const configured = process.env[GENERATION_ARCHITECTURE_ENV_KEY]?.trim();
  if (!configured) {
    return "legacy";
  }
  if (configured === "legacy" || configured === "langgraph") {
    return configured;
  }
  throw new Error(
    `${GENERATION_ARCHITECTURE_ENV_KEY} must be "legacy" or "langgraph".`,
  );
}

/**
 * Resolves validated generation concurrency.
 *
 * @param explicit - Optional caller override.
 * @returns Integer concurrency in the inclusive range 1–8.
 */
export function resolveGenerationConcurrency(explicit?: number): number {
  const configured = process.env[GENERATION_CONCURRENCY_ENV_KEY]?.trim();
  const candidate =
    explicit ??
    (configured ? Number(configured) : DEFAULT_GENERATION_CONCURRENCY);
  if (
    !Number.isInteger(candidate) ||
    candidate < 1 ||
    candidate > MAX_GENERATION_CONCURRENCY
  ) {
    throw new Error(
      `${GENERATION_CONCURRENCY_ENV_KEY} must be an integer from 1 through ${MAX_GENERATION_CONCURRENCY}.`,
    );
  }
  return candidate;
}
