import { describe, expect, test } from "vitest";
import type { PageResult } from "../../../src/agent/generation/contracts.ts";
import {
  createPageJobId,
  mergePageJobs,
  mergePageResults,
  mergeStableIds,
  type ProposedPageJob,
} from "../../../src/agent/generation/jobs.ts";

const page = "/openwiki/architecture/runtime.md";

/**
 * Builds a valid unassigned page job with focused overrides.
 *
 * @param overrides - Job fields to replace.
 * @returns Valid proposed page job.
 */
function proposedJob(
  overrides: Partial<ProposedPageJob> = {},
): ProposedPageJob {
  return {
    page,
    operation: "reconcile",
    reasons: ["source-changed"],
    sourceHints: ["src/agent/index.ts"],
    wave: 0,
    priority: 500,
    ...overrides,
  };
}

/**
 * Builds a compact valid page result with focused overrides.
 *
 * @param overrides - Result fields to replace.
 * @returns Valid page result.
 */
function pageResult(overrides: Partial<PageResult> = {}): PageResult {
  return {
    page,
    wave: 0,
    status: "unchanged",
    reconcilerInvocations: 1,
    authorInvocations: 0,
    changedLinks: [],
    durationMs: 10,
    ...overrides,
  };
}

describe("deterministic page jobs", () => {
  test("creates a stable ID independent of reason order and non-identity hints", () => {
    const first = proposedJob({
      reasons: ["git-change", "claim-stale"],
      sourceHints: ["src/a.ts"],
      priority: 100,
    });
    const equivalent = proposedJob({
      reasons: ["claim-stale", "git-change"],
      sourceHints: ["src/b.ts"],
      priority: 900,
    });

    expect(createPageJobId(first)).toBe(createPageJobId(equivalent));
    expect(createPageJobId({ ...first, wave: 1 })).not.toBe(
      createPageJobId(first),
    );
    expect(createPageJobId({ ...first, operation: "repair" })).not.toBe(
      createPageJobId(first),
    );
  });

  test("canonicalizes and merges same-page work deterministically", () => {
    const jobs = mergePageJobs([
      proposedJob({
        page: "openwiki\\architecture\\runtime.md",
        operation: "reconcile",
        reasons: [" source-changed ", "claim-stale"],
        sourceHints: ["src/b.ts", "src/a.ts"],
        priority: 900,
      }),
      proposedJob({
        operation: "repair",
        reasons: ["claim-stale", "qa-failed"],
        sourceHints: ["src/a.ts", "test/a.test.ts"],
        wave: 2,
        priority: 100,
      }),
    ]);

    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(jobs[0]).toMatchObject({
      page,
      operation: "repair",
      reasons: ["claim-stale", "qa-failed", "source-changed"],
      sourceHints: ["src/a.ts", "src/b.ts", "test/a.test.ts"],
      wave: 2,
      priority: 900,
    });
    const { id, ...jobWithoutId } = job;
    expect(id).toBe(createPageJobId(jobWithoutId));
  });

  test("sorts merged jobs by descending priority then page", () => {
    const jobs = mergePageJobs([
      proposedJob({ page: "/openwiki/z.md", priority: 10 }),
      proposedJob({ page: "/openwiki/b.md", priority: 20 }),
      proposedJob({ page: "/openwiki/a.md", priority: 20 }),
    ]);

    expect(jobs.map((job) => job.page)).toEqual([
      "/openwiki/a.md",
      "/openwiki/b.md",
      "/openwiki/z.md",
    ]);
  });

  test("rejects mixed deletion and retained-page work", () => {
    expect(() =>
      mergePageJobs([
        proposedJob({ operation: "delete" }),
        proposedJob({ operation: "reconcile" }),
      ]),
    ).toThrow(`Conflicting delete and write jobs for ${page}.`);
  });

  test("merges independently proven deletion jobs", () => {
    const jobs = mergePageJobs([
      proposedJob({ operation: "delete", reasons: ["source-deleted"] }),
      proposedJob({
        operation: "delete",
        reasons: ["evidence-deleted"],
        wave: 1,
      }),
    ]);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      operation: "delete",
      reasons: ["evidence-deleted", "source-deleted"],
      wave: 1,
    });
  });
});

describe("parallel generation reducers", () => {
  test("rejects two results for the same page and wave", () => {
    expect(() =>
      mergePageResults([pageResult()], [pageResult({ status: "committed" })]),
    ).toThrow(`Page ${page} produced multiple results for wave 0.`);
    expect(() =>
      mergePageResults([], [pageResult(), pageResult({ status: "failed" })]),
    ).toThrow(`Page ${page} produced multiple results for wave 0.`);
  });

  test("keeps only the latest result for each page", () => {
    const current = pageResult({ wave: 1, status: "committed" });
    const stale = pageResult({ wave: 0, status: "failed" });
    const latest = pageResult({ wave: 2, status: "unchanged" });
    const sibling = pageResult({
      page: "/openwiki/quickstart.md",
      status: "committed",
    });

    expect(mergePageResults([current], [stale, latest, sibling])).toEqual([
      latest,
      sibling,
    ]);
  });

  test("merges stable identifiers in lexical order", () => {
    expect(
      mergeStableIds(["review_b", "review_a"], ["review_c", "review_a"]),
    ).toEqual(["review_a", "review_b", "review_c"]);
  });
});
