import { runOpenWikiAgent } from "../agent/index.js";
import type { OpenWikiRunEvent } from "../agent/types.js";
import { ClaimsStore } from "../claims/brains/code/store.js";

/**
 * Current repository readiness for the Claims backfill migration.
 */
export interface ClaimsMigrationStatus {
  completedPages: string[];
  pendingPages: string[];
  totalPages: number;
}

/**
 * Durable result for one migrated page.
 */
export interface ClaimsMigrationPageResult {
  claimCount: number;
  page: string;
  pageUpdated: boolean;
}

/**
 * Events emitted by the page-transaction migration runner.
 */
export type ClaimsMigrationEvent =
  | { type: "page_start"; index: number; page: string; total: number }
  | { type: "activity"; page: string; message: string }
  | ({ type: "page_complete" } & ClaimsMigrationPageResult)
  | { type: "page_error"; page: string; error: Error };

/**
 * Aggregate result from one migration attempt.
 */
export interface ClaimsMigrationResult {
  completed: ClaimsMigrationPageResult[];
  failed?: { page: string; error: Error };
  remainingPages: string[];
}

export interface RunClaimsMigrationOptions {
  onEvent?: (event: ClaimsMigrationEvent) => void;
  runPage?: typeof runClaimsMigrationPage;
}

/**
 * Detects Claims migration work from current page and sidecar state.
 *
 * Sidecar presence is the durable completion signal. Invalid sidecars fail
 * closed through ClaimsStore validation rather than looking merely present.
 */
export async function inspectClaimsMigration(
  cwd: string,
): Promise<ClaimsMigrationStatus> {
  const store = new ClaimsStore(cwd);
  const pages = await store.discoverPages();
  const persisted = await store.loadPages(pages);
  const completedPages = pages.filter((page) => persisted.has(page));
  const pendingPages = pages.filter((page) => !persisted.has(page));
  return { completedPages, pendingPages, totalPages: pages.length };
}

/**
 * Migrates pending pages sequentially, committing each page before continuing.
 *
 * A failed page stops the attempt. Already committed pages remain durable and
 * the next invocation rediscovers only the remaining work.
 */
export async function runClaimsMigration(
  cwd: string,
  options: RunClaimsMigrationOptions = {},
): Promise<ClaimsMigrationResult> {
  const initial = await inspectClaimsMigration(cwd);
  const completed: ClaimsMigrationPageResult[] = [];
  const runPage = options.runPage ?? runClaimsMigrationPage;

  for (const [index, page] of initial.pendingPages.entries()) {
    options.onEvent?.({
      type: "page_start",
      index: index + 1,
      page,
      total: initial.pendingPages.length,
    });

    try {
      const result = await runPage(cwd, page, (event) => {
        const message = formatAgentActivity(event);
        if (message) {
          options.onEvent?.({ type: "activity", page, message });
        }
      });
      completed.push(result);
      options.onEvent?.({ type: "page_complete", ...result });
    } catch (error) {
      const normalized = toError(error);
      options.onEvent?.({ type: "page_error", page, error: normalized });
      const remaining = await inspectClaimsMigration(cwd);
      return {
        completed,
        failed: { page, error: normalized },
        remainingPages: remaining.pendingPages,
      };
    }
  }

  const final = await inspectClaimsMigration(cwd);
  return { completed, remainingPages: final.pendingPages };
}

/**
 * Runs one focused migration agent and verifies its sidecar was committed.
 */
export async function runClaimsMigrationPage(
  cwd: string,
  page: string,
  onAgentEvent?: (event: OpenWikiRunEvent) => void,
): Promise<ClaimsMigrationPageResult> {
  const store = new ClaimsStore(cwd);
  const beforeHash = await store.hashPage(page);

  await runOpenWikiAgent("update", cwd, {
    migration: { kind: "claims", page },
    onEvent: onAgentEvent,
    outputMode: "repository",
  });

  const persisted = await store.loadPage(page);
  if (!persisted) {
    throw new Error(
      `Claims migration did not complete its review for ${page}. Re-run the migration to retry it.`,
    );
  }

  return {
    claimCount: persisted.claims.length,
    page,
    pageUpdated: beforeHash !== (await store.hashPage(page)),
  };
}

/**
 * Converts a low-level agent event into one stable progress label.
 */
function formatAgentActivity(event: OpenWikiRunEvent): string | null {
  if (event.type === "tool_start") {
    if (event.name === "resolve_claims") return "Grounding claims in evidence";
    if (event.name === "complete_claims_review") {
      return "Verifying and saving claims";
    }
    if (event.name === "read_file") return "Reading source evidence";
    if (event.name === "edit_file" || event.name === "write_file") {
      return "Updating unsupported wiki prose";
    }
    return `Running ${event.name}`;
  }

  // Text, debug, and tool-end events are frequent but do not identify a new
  // phase. Ignoring them keeps the last concrete tool activity on screen
  // instead of flickering between vague "Working"/"Finalizing" labels.
  return null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
