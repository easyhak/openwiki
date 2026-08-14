import { createHash } from "node:crypto";
import { ClaimsStore } from "../../claims/brains/code/store.js";
import {
  normalizeWikiPagePath,
  toRepositoryPagePath,
} from "../../claims/brains/code/paths.js";
import { CODE_CLAIMS_SCHEMA_VERSION } from "../../claims/brains/code/types.js";
import { hashClaimSet } from "../../claims/brains/code/reconcile.js";
import type { Claim } from "../../claims/core/types.js";
import { AtomicRepositoryFiles } from "./atomic-files.js";
import type { PageJob, PageResult } from "./contracts.js";
import { PendingWorkStore } from "./pending-work-store.js";

/**
 * Successful page transaction result.
 */
export type PageCommitResult = Pick<
  PageResult,
  "status" | "pageVersion" | "claimRevision"
>;

/**
 * Commits Markdown and Claims with recoverable per-file atomicity.
 */
export class PageCommitter {
  /**
   * Safe repository file operations.
   */
  private readonly files: AtomicRepositoryFiles;

  /**
   * OpenWiki-owned Claims persistence.
   */
  private readonly claims: ClaimsStore;

  /**
   * Durable generation work ledger.
   */
  private readonly pending: PendingWorkStore;

  constructor(rootDir: string, claims: ClaimsStore, pending: PendingWorkStore) {
    this.files = new AtomicRepositoryFiles(rootDir);
    this.claims = claims;
    this.pending = pending;
  }

  /**
   * Commits one synchronized page and sidecar.
   *
   * @param job - Seeded normalized page job.
   * @param markdown - Complete validated Markdown.
   * @param claimSet - Complete resolved Claims expressed by the page.
   * @returns Stable commit hashes and status.
   */
  async commit(
    job: PageJob,
    markdown: string,
    claimSet: readonly Claim[],
  ): Promise<PageCommitResult> {
    if (job.operation === "delete") {
      throw new Error(`Delete job cannot commit Markdown for ${job.page}.`);
    }
    const page = normalizeWikiPagePath(job.page);
    const relativePage = toRepositoryPagePath(page);
    const previousMarkdown = await this.files.readText(relativePage);
    const previousClaims = await this.claims.loadPage(page);
    const pageVersion = hashText(markdown);
    const claimRevision = hashClaimSet(claimSet);
    const claimStateChanged =
      previousClaims === null ||
      previousClaims.pageVersion !== pageVersion ||
      hashClaimSet(previousClaims.claims) !== claimRevision;
    try {
      await this.files.replaceText(relativePage, markdown);
      await this.claims.writePage(page, {
        schemaVersion: CODE_CLAIMS_SCHEMA_VERSION,
        pageVersion,
        claims: claimSet.map((claim) => ({
          ...claim,
          evidence: claim.evidence.map((evidence) => ({ ...evidence })),
        })),
      });
      await this.pending.complete(job.id);
    } catch (error) {
      try {
        await this.restore(
          page,
          relativePage,
          previousMarkdown,
          previousClaims,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Commit and rollback both failed for ${page}.`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return {
      status:
        previousMarkdown === markdown && !claimStateChanged
          ? "unchanged"
          : "committed",
      pageVersion,
      claimRevision,
    };
  }

  /**
   * Deletes one proven-empty page and sidecar.
   *
   * @param job - Seeded delete job.
   * @returns Deleted status.
   */
  async delete(job: PageJob): Promise<PageCommitResult> {
    if (job.operation !== "delete") {
      throw new Error(`Non-delete job cannot delete ${job.page}.`);
    }
    const page = normalizeWikiPagePath(job.page);
    const relativePage = toRepositoryPagePath(page);
    const previousMarkdown = await this.files.readText(relativePage);
    const previousClaims = await this.claims.loadPage(page);
    try {
      await this.files.remove(relativePage);
      await this.claims.deletePage(page);
      await this.pending.complete(job.id);
    } catch (error) {
      try {
        await this.restore(
          page,
          relativePage,
          previousMarkdown,
          previousClaims,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Delete and rollback both failed for ${page}.`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return { status: "deleted" };
  }

  /**
   * Restores the last synchronized pair after a handled transaction failure.
   *
   * @param page - Canonical virtual page.
   * @param relativePage - Repository-relative Markdown path.
   * @param markdown - Previous Markdown, or null when absent.
   * @param pageClaims - Previous sidecar, or null when absent.
   */
  private async restore(
    page: string,
    relativePage: string,
    markdown: string | null,
    pageClaims: Awaited<ReturnType<ClaimsStore["loadPage"]>>,
  ): Promise<void> {
    const failures: unknown[] = [];
    try {
      if (markdown === null) {
        await this.files.remove(relativePage);
      } else {
        await this.files.replaceText(relativePage, markdown);
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      if (pageClaims === null) {
        await this.claims.deletePage(page);
      } else {
        await this.claims.writePage(page, pageClaims);
      }
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Unable to restore the previous synchronized state for ${page}.`,
      );
    }
  }
}

/**
 * Hashes exact persisted Markdown bytes.
 *
 * @param content - Complete Markdown.
 * @returns Algorithm-prefixed content hash.
 */
function hashText(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
