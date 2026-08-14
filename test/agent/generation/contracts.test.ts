import { describe, expect, test } from "vitest";
import {
  CanonicalPageSchema,
  ClaimDraftSchema,
  ClaimEvidenceDraftSchema,
  ClaimProposalSchema,
  DiscoveryPartitionSchema,
  DiscoveryResultSchema,
  GenerationSummarySchema,
  PageAuthorOutputSchema,
  PageFailureSchema,
  PageJobSchema,
  PageResultSchema,
  PendingWorkDocumentSchema,
  PendingWorkItemSchema,
  ReviewGapSchema,
  ReviewOutputSchema,
} from "../../../src/agent/generation/contracts.ts";

const page = "/openwiki/architecture/runtime.md";
const proposedJob = {
  page,
  operation: "reconcile" as const,
  reasons: ["source-changed"],
  sourceHints: ["src/agent/index.ts"],
  priority: 500,
};
const pageJob = {
  ...proposedJob,
  id: "job_runtime",
  wave: 0,
};
const pendingItem = {
  id: "pending_runtime",
  kind: "page" as const,
  page,
  reason: "The page still needs reconciliation.",
  sourceHints: ["src/agent/index.ts"],
  attempts: 1,
  firstSeenAt: "2026-08-14T01:00:00.000Z",
  lastSeenAt: "2026-08-14T02:00:00.000Z",
};

describe("generation contracts", () => {
  test.each([
    "/openwiki/quickstart.md",
    "/openwiki/architecture/runtime.md",
    "/openwiki/_internal.md",
  ])("accepts canonical factual page %s", (candidate) => {
    expect(CanonicalPageSchema.parse(candidate)).toBe(candidate);
  });

  test.each([
    "openwiki/page.md",
    "/openwiki//page.md",
    "/openwiki/../page.md",
    "/openwiki/guides/./page.md",
    "/openwiki/.claims/page.md",
    "/openwiki/nested/.CLAIMS/page.md",
    "/openwiki/index.md",
    "/openwiki/nested/INSTRUCTIONS.md",
    "/outside/page.md",
    "/openwiki/page.txt",
  ])("rejects non-canonical or structural page %s", (candidate) => {
    expect(CanonicalPageSchema.safeParse(candidate).success).toBe(false);
  });

  test("validates a page job and rejects unknown fields", () => {
    expect(PageJobSchema.parse(pageJob)).toEqual(pageJob);
    expect(
      PageJobSchema.safeParse({ ...pageJob, unexpected: true }).success,
    ).toBe(false);
  });

  test("validates a Claim evidence draft", () => {
    expect(
      ClaimEvidenceDraftSchema.parse({ resource: "repo://src/agent/index.ts" }),
    ).toEqual({ resource: "repo://src/agent/index.ts" });
    expect(ClaimEvidenceDraftSchema.safeParse({ resource: "" }).success).toBe(
      false,
    );
  });

  test("validates a complete Claim draft", () => {
    const claim = {
      id: "claim_runtime",
      statement: "The runtime exposes one public runner.",
      evidence: [{ resource: "repo://src/agent/index.ts" }],
    };

    expect(ClaimDraftSchema.parse(claim)).toEqual(claim);
    expect(ClaimDraftSchema.safeParse({ ...claim, evidence: [] }).success).toBe(
      false,
    );
  });

  test("enforces Claim proposal disposition invariants", () => {
    const claim = {
      statement: "The runtime exposes one public runner.",
      evidence: [{ resource: "repo://src/agent/index.ts" }],
    };

    expect(
      ClaimProposalSchema.parse({
        disposition: "write",
        claims: [claim],
        reason: "Current evidence supports the page.",
      }).claims,
    ).toEqual([claim]);
    expect(
      ClaimProposalSchema.safeParse({
        disposition: "write",
        claims: [],
        reason: "No claims.",
      }).success,
    ).toBe(false);
    expect(
      ClaimProposalSchema.safeParse({
        disposition: "delete",
        claims: [claim],
        reason: "Conflicting output.",
      }).success,
    ).toBe(false);
  });

  test("validates tool-free page author output", () => {
    const output = {
      markdown: "# Runtime\n",
      representedClaimIds: ["claim_runtime"],
    };

    expect(PageAuthorOutputSchema.parse(output)).toEqual(output);
    expect(
      PageAuthorOutputSchema.safeParse({ ...output, markdown: "" }).success,
    ).toBe(false);
  });

  test("validates compact page failures", () => {
    const failure = { code: "author_failed", message: "Author timed out." };

    expect(PageFailureSchema.parse(failure)).toEqual(failure);
    expect(
      PageFailureSchema.safeParse({ code: "unknown", message: "No." }).success,
    ).toBe(false);
  });

  test("validates compact page results", () => {
    const result = {
      page,
      wave: 0,
      status: "committed",
      pageVersion: `sha256:${"a".repeat(64)}`,
      claimRevision: `sha256:${"b".repeat(64)}`,
      reconcilerInvocations: 1,
      authorInvocations: 1,
      changedLinks: ["/openwiki/quickstart.md"],
      durationMs: 100,
    };

    expect(PageResultSchema.parse(result)).toEqual(result);
    expect(
      PageResultSchema.safeParse({ ...result, pageVersion: "sha256:short" })
        .success,
    ).toBe(false);
  });

  test("validates pending work items and their versioned document", () => {
    expect(PendingWorkItemSchema.parse(pendingItem)).toEqual(pendingItem);
    expect(
      PendingWorkItemSchema.safeParse({
        ...pendingItem,
        firstSeenAt: "not-a-date",
      }).success,
    ).toBe(false);
    expect(
      PendingWorkDocumentSchema.parse({
        schemaVersion: 1,
        items: [pendingItem],
      }).items,
    ).toEqual([pendingItem]);
    expect(
      PendingWorkDocumentSchema.safeParse({
        schemaVersion: 2,
        items: [pendingItem],
      }).success,
    ).toBe(false);
  });

  test("validates deterministic discovery partitions", () => {
    const partition = {
      id: "partition_root",
      roots: ["src"],
      manifests: ["package.json"],
    };

    expect(DiscoveryPartitionSchema.parse(partition)).toEqual(partition);
    expect(
      DiscoveryPartitionSchema.safeParse({ ...partition, roots: [] }).success,
    ).toBe(false);
  });

  test("validates discovery results with unassigned jobs", () => {
    const result = {
      partitionId: "partition_root",
      jobs: [proposedJob],
      deferrals: [],
    };

    expect(DiscoveryResultSchema.parse(result)).toEqual(result);
    expect(
      DiscoveryResultSchema.safeParse({
        ...result,
        jobs: [{ ...proposedJob, id: "too_early" }],
      }).success,
    ).toBe(false);
  });

  test("validates reviewer gaps", () => {
    const gap = {
      id: "gap_runtime",
      page,
      reason: "Evidence is unavailable.",
      sourceHints: ["src/agent/index.ts"],
    };

    expect(ReviewGapSchema.parse(gap)).toEqual(gap);
    expect(ReviewGapSchema.safeParse({ ...gap, id: " gap " }).success).toBe(
      false,
    );
  });

  test("validates bounded review output", () => {
    const output = {
      jobs: [proposedJob],
      gaps: [],
      resolvedPendingIds: ["pending_runtime"],
    };

    expect(ReviewOutputSchema.parse(output)).toEqual(output);
    expect(
      ReviewOutputSchema.safeParse({
        ...output,
        resolvedPendingIds: [" pending_runtime "],
      }).success,
    ).toBe(false);
  });

  test("validates terminal generation summaries", () => {
    const summary = {
      status: "partial",
      planned: 2,
      committed: 1,
      unchanged: 0,
      deleted: 0,
      failed: 1,
      deferred: 0,
      pending: 1,
    };

    expect(GenerationSummarySchema.parse(summary)).toEqual(summary);
    expect(
      GenerationSummarySchema.safeParse({ ...summary, pending: -1 }).success,
    ).toBe(false);
  });
});
