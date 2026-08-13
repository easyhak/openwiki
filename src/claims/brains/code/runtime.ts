import type {
  OpenWikiCommand,
  OpenWikiOutputMode,
} from "../../../agent/types.js";
import { OpenWikiIgnore } from "../../../agent/openwiki-ignore.js";
import { runClaimsPreflight } from "./preflight.js";
import { RepositoryEvidenceResolver } from "../../evidence/repository/resolver.js";
import { ClaimSession } from "./session.js";
import { ClaimsStore } from "./store.js";
import type { GroundingContext } from "./types.js";
import type { ClaimsReconciliationInput } from "./reconciliation.js";

/**
 * Prepared repository Claims state for one init or update run.
 */
export interface ClaimsRuntime {
  /**
   * OpenWiki-owned sidecar persistence.
   */
  store: ClaimsStore;

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
   * Prepared immutable inputs for pre-agent semantic reconciliation.
   *
   * @default undefined for init, which has no persisted claim issues.
   */
  reconciliation?: ClaimsReconciliationInput;
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
    return {
      store,
      session: new ClaimSession({
        resolver,
        persisted: new Map(),
        issues: [],
        orphanPages: await store.discoverSidecarPages(),
      }),
      context: { issues: [] },
      requiresAttention: true,
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
    store,
    session,
    context: preflight.context,
    reconciliation: {
      context: preflight.context,
      openWikiIgnore,
      persisted: preflight.persisted,
      resolver,
      rootDir: cwd,
      session,
    },
    requiresAttention:
      preflight.context.issues.length > 0 || preflight.orphanPages.length > 0,
  };
}
