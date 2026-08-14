import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ClaimsStore } from "../../../src/claims/brains/code/store.ts";
import type { PageClaims } from "../../../src/claims/brains/code/types.ts";
import type { Claim } from "../../../src/claims/core/types.ts";
import type { PageJob } from "../../../src/agent/generation/contracts.ts";
import { PageCommitter } from "../../../src/agent/generation/page-commit.ts";
import { PendingWorkStore } from "../../../src/agent/generation/pending-work-store.ts";

const page = "/openwiki/architecture/runtime.md";
const relativePage = "openwiki/architecture/runtime.md";
const oldMarkdown = "# Old runtime\n";
const newMarkdown = "# Current runtime\n";
const oldClaims: Claim[] = [
  {
    id: "claim_runtime",
    statement: "The old runtime is active.",
    evidence: [{ resource: "repo://src/old.ts", version: "version:1" }],
  },
];
const newClaims: Claim[] = [
  {
    id: "claim_runtime",
    statement: "The current runtime is active.",
    evidence: [{ resource: "repo://src/runtime.ts", version: "version:2" }],
  },
];

/**
 * Creates one normalized page job.
 *
 * @param operation - Page operation under test.
 * @returns Valid page job.
 */
function pageJob(operation: PageJob["operation"] = "reconcile"): PageJob {
  return {
    id: `job_${operation}`,
    page,
    operation,
    reasons: ["source-changed"],
    sourceHints: ["src/agent/index.ts"],
    wave: 0,
    priority: 500,
  };
}

describe("PageCommitter", () => {
  let rootDir: string;
  let claims: ClaimsStore;
  let pending: PendingWorkStore;
  let committer: PageCommitter;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-page-commit-"));
    claims = new ClaimsStore(rootDir);
    pending = new PendingWorkStore(
      rootDir,
      () => new Date("2026-08-14T01:00:00Z"),
    );
    committer = new PageCommitter(rootDir, claims, pending);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { force: true, recursive: true });
  });

  /**
   * Writes one Markdown fixture.
   *
   * @param markdown - Complete page contents.
   */
  async function writeMarkdown(markdown: string): Promise<void> {
    const absolute = path.join(rootDir, relativePage);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, markdown, "utf8");
  }

  /**
   * Seeds a synchronized old page, sidecar, and pending job.
   *
   * @param job - Job to seed in pending work.
   * @returns Persisted old sidecar state.
   */
  async function seedOldState(job: PageJob): Promise<PageClaims> {
    await writeMarkdown(oldMarkdown);
    const state: PageClaims = {
      schemaVersion: 1,
      pageVersion: await claims.hashPage(page),
      claims: structuredClone(oldClaims),
    };
    await claims.writePage(page, state);
    await pending.seedJobs([job]);
    return state;
  }

  test("commits Markdown, sidecar, and pending completion in order", async () => {
    const job = pageJob();
    await seedOldState(job);

    const result = await committer.commit(job, newMarkdown, newClaims);

    expect(result).toMatchObject({ status: "committed" });
    await expect(
      readFile(path.join(rootDir, relativePage), "utf8"),
    ).resolves.toBe(newMarkdown);
    await expect(claims.loadPage(page)).resolves.toEqual({
      schemaVersion: 1,
      pageVersion: result.pageVersion,
      claims: newClaims,
    });
    await expect(pending.list()).resolves.toEqual([]);

    await pending.seedJobs([job]);
    await expect(
      committer.commit(job, newMarkdown, newClaims),
    ).resolves.toMatchObject({ status: "unchanged" });
  });

  test("restores the old pair when sidecar publication fails", async () => {
    const job = pageJob();
    const previous = await seedOldState(job);
    const failure = new Error("sidecar publication failed");
    vi.spyOn(claims, "writePage").mockRejectedValueOnce(failure);

    await expect(committer.commit(job, newMarkdown, newClaims)).rejects.toBe(
      failure,
    );

    await expect(
      readFile(path.join(rootDir, relativePage), "utf8"),
    ).resolves.toBe(oldMarkdown);
    await expect(claims.loadPage(page)).resolves.toEqual(previous);
    await expect(pending.list()).resolves.toMatchObject([{ id: job.id }]);
  });

  test("restores the old pair when pending completion fails", async () => {
    const job = pageJob();
    const previous = await seedOldState(job);
    const failure = new Error("pending completion failed");
    vi.spyOn(pending, "complete").mockRejectedValueOnce(failure);

    await expect(committer.commit(job, newMarkdown, newClaims)).rejects.toBe(
      failure,
    );

    await expect(
      readFile(path.join(rootDir, relativePage), "utf8"),
    ).resolves.toBe(oldMarkdown);
    await expect(claims.loadPage(page)).resolves.toEqual(previous);
    await expect(pending.list()).resolves.toMatchObject([{ id: job.id }]);
  });

  test("preserves publication and rollback failures in AggregateError", async () => {
    const job = pageJob();
    await seedOldState(job);
    const publicationFailure = new Error("publication failed");
    const rollbackFailure = new Error("rollback failed");
    vi.spyOn(claims, "writePage")
      .mockRejectedValueOnce(publicationFailure)
      .mockRejectedValueOnce(rollbackFailure);

    const thrown = await committer
      .commit(job, newMarkdown, newClaims)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors[0]).toBe(publicationFailure);
    expect(aggregate.errors[1]).toBeInstanceOf(AggregateError);
    expect((aggregate.errors[1] as AggregateError).errors).toContain(
      rollbackFailure,
    );
  });

  test("deletes a proven page and rolls back a sidecar deletion failure", async () => {
    const job = pageJob("delete");
    const previous = await seedOldState(job);
    const failure = new Error("sidecar deletion failed");
    vi.spyOn(claims, "deletePage").mockRejectedValueOnce(failure);

    await expect(committer.delete(job)).rejects.toBe(failure);
    await expect(
      readFile(path.join(rootDir, relativePage), "utf8"),
    ).resolves.toBe(oldMarkdown);
    await expect(claims.loadPage(page)).resolves.toEqual(previous);
    await expect(pending.list()).resolves.toMatchObject([{ id: job.id }]);

    await expect(committer.delete(job)).resolves.toEqual({ status: "deleted" });
    await expect(claims.loadPage(page)).resolves.toBeNull();
    await expect(pending.list()).resolves.toEqual([]);
  });

  test("rejects mismatched commit and delete operations", async () => {
    await expect(
      committer.commit(pageJob("delete"), newMarkdown, newClaims),
    ).rejects.toThrow("Delete job cannot commit Markdown");
    await expect(committer.delete(pageJob("reconcile"))).rejects.toThrow(
      "Non-delete job cannot delete",
    );
  });
});
