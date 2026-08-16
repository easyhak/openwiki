import type {
  OpenWikiCommand,
  OpenWikiOutputMode,
} from "../../../agent/types.js";
import { OpenWikiIgnore } from "../../../agent/openwiki-ignore.js";
import { runClaimsPreflight } from "./preflight.js";
import { RepositoryEvidenceResolver } from "../../evidence/repository/resolver.js";
import { ClaimSession } from "./session.js";
import { ClaimsStore } from "./store.js";
import type { GroundingContext, ReconciliationObligation } from "./types.js";

/**
 * Prepared repository Claims state for one init or update run.
 */
export interface ClaimsRuntime {
  /**
   * Run-scoped working state used by tools and finalization.
   */
  session: ClaimSession;

  /**
   * Compact deterministic reconciliation worklist.
   */
  context: GroundingContext;

  /**
   * Whether grounding issues or orphan cleanup prevent an update no-op.
   */
  requiresAttention: boolean;

  /**
   * Finalizes synchronized pages and reports unfinished reconciliation.
   */
  finalize(): Promise<ReconciliationObligation[]>;
}

/**
 * Prepares Claims only for repository init and update runs.
 *
 * @param command - Current OpenWiki command.
 * @param outputMode - Current output target.
 * @param cwd - Absolute repository root.
 * @param openWikiIgnore - Repository read-boundary rules.
 * @returns Prepared Claims runtime, or `undefined` outside code generation.
 */
export async function prepareClaimsRuntime(
  command: OpenWikiCommand,
  outputMode: OpenWikiOutputMode,
  cwd: string,
  openWikiIgnore: OpenWikiIgnore,
): Promise<ClaimsRuntime | undefined> {
  if (outputMode !== "repository" || command === "chat") {
    return undefined;
  }

  const store = new ClaimsStore(cwd);
  const resolver = new RepositoryEvidenceResolver({
    rootDir: cwd,
    openWikiIgnore,
  });

  if (command === "init") {
    const session = new ClaimSession({
      resolver,
      persisted: new Map(),
      issues: [],
      orphanPages: await store.discoverSidecarPages(),
    });
    return {
      session,
      context: { issues: [] },
      requiresAttention: true,
      finalize: () => session.finalize(store),
    };
  }

  const preflight = await runClaimsPreflight(store, resolver);
  const session = new ClaimSession({
    resolver,
    persisted: preflight.persisted,
    issues: preflight.context.issues,
    orphanPages: preflight.orphanPages,
  });
  return {
    session,
    context: preflight.context,
    requiresAttention:
      preflight.context.issues.length > 0 || preflight.orphanPages.length > 0,
    finalize: () => session.finalize(store),
  };
}
