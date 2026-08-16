import type {
  OpenWikiCommand,
  OpenWikiOutputMode,
} from "../../../agent/types.js";
import { OpenWikiIgnore } from "../../../agent/openwiki-ignore.js";
import { RepositoryEvidenceResolver } from "../../evidence/repository/resolver.js";
import { runClaimsPreflight } from "./preflight.js";
import { ClaimSession } from "./session.js";
import { ClaimsStore } from "./store.js";

/**
 * Prepared repository Claims state for one init or update run.
 */
export interface ClaimsRuntime {
  /**
   * Run-scoped working state used by tools, middleware, and finalization.
   */
  session: ClaimSession;

  /**
   * Number of lazy page-local issues, used for diagnostics only.
   */
  issueCount: number;

  /**
   * Persists dirty claim pages and removes deleted or orphaned sidecars.
   */
  finalize(): Promise<void>;
}

/**
 * Prepares Claims only for repository init and update runs.
 *
 * Update preparation detects evidence debt for page-local read notes without
 * turning it into mandatory agent work or blocking an update no-op.
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
      issueCount: 0,
      finalize: () => session.finalize(store),
    };
  }

  const preflight = await runClaimsPreflight(store, resolver);
  const session = new ClaimSession({
    resolver,
    persisted: preflight.persisted,
    issues: preflight.issues,
    orphanPages: preflight.orphanPages,
  });
  return {
    session,
    issueCount: preflight.issues.length,
    finalize: () => session.finalize(store),
  };
}
