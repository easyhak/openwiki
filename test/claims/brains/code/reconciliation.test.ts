import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiIgnore } from "../../../../src/agent/openwiki-ignore.ts";
import {
  reconcileClaimsBeforeAgent,
  type ClaimsReconciliationInput,
} from "../../../../src/claims/brains/code/reconciliation.ts";
import { ClaimSession } from "../../../../src/claims/brains/code/session.ts";
import { RepositoryEvidenceResolver } from "../../../../src/claims/evidence/repository/resolver.ts";
import type {
  GroundingContext,
  PageClaims,
} from "../../../../src/claims/brains/code/types.ts";
import type {
  EvidenceResolver,
  ResolvedEvidence,
} from "../../../../src/claims/core/types.ts";

const PAGE_VERSION = `sha256:${"a".repeat(64)}`;

/**
 * Creates one current evidence result.
 */
function resolved(resource: string): ResolvedEvidence {
  return {
    evidence: { resource, version: "revision:2" },
    content: `current content for ${resource}`,
  };
}

/**
 * Creates persisted state and a session sharing one deterministic resolver.
 */
function createInput(): ClaimsReconciliationInput {
  const sharedResource = "memory://shared";
  const missingResource = "memory://missing";
  const secondResource = "memory://second";
  const persisted = new Map<string, PageClaims>([
    [
      "/openwiki/overview.md",
      {
        schemaVersion: 1,
        pageVersion: PAGE_VERSION,
        claims: [
          {
            id: "claim_shared",
            statement: "The shared feature exists.",
            evidence: [{ resource: sharedResource, version: "revision:1" }],
          },
          {
            id: "claim_missing",
            statement: "The removed feature exists.",
            evidence: [{ resource: missingResource, version: "revision:1" }],
          },
        ],
      },
    ],
    [
      "/openwiki/second.md",
      {
        schemaVersion: 1,
        pageVersion: PAGE_VERSION,
        claims: [
          {
            id: "claim_second",
            statement: "The second feature exists.",
            evidence: [{ resource: secondResource, version: "revision:1" }],
          },
        ],
      },
    ],
  ]);
  const context: GroundingContext = {
    issues: [
      {
        page: "/openwiki/overview.md",
        kind: "stale",
        claimId: "claim_shared",
        resources: [sharedResource],
      },
      {
        page: "/openwiki/overview.md",
        kind: "unresolved",
        claimId: "claim_missing",
        resources: [missingResource],
      },
      {
        page: "/openwiki/second.md",
        kind: "stale",
        claimId: "claim_second",
        resources: [secondResource],
      },
    ],
  };
  const outcomes = new Map<string, ResolvedEvidence | null>([
    [sharedResource, resolved(sharedResource)],
    [missingResource, null],
    [secondResource, resolved(secondResource)],
  ]);
  const resolver: EvidenceResolver = {
    resolve: (resource) => Promise.resolve(outcomes.get(resource) ?? null),
  };
  const session = new ClaimSession({
    resolver,
    persisted,
    issues: context.issues,
    orphanPages: [],
  });
  return { context, persisted, resolver, session };
}

/**
 * Extracts the JSON reconciliation task from a structured-output invocation.
 */
function parseTask(messages: unknown): {
  claims: Array<{
    page: string;
    claimId: string;
    statement: string;
    evidence: string[];
    issue: { kind: string; candidates: string[] };
  }>;
  currentEvidence: Array<{
    resource: string;
    status: string;
    content?: string;
  }>;
} {
  const list = messages as Array<{ role: string; content: string }>;
  const prompt = list.find((message) => message.role === "user")?.content;
  if (!prompt) {
    throw new Error("Missing reconciliation task prompt.");
  }
  return JSON.parse(prompt) as ReturnType<typeof parseTask>;
}

describe("reconcileClaimsBeforeAgent", () => {
  test("consolidates pages, runs issue batches concurrently, and commits once per page", async () => {
    const input = createInput();
    let active = 0;
    let maximumActive = 0;
    const calls: Array<ReturnType<typeof parseTask>> = [];
    const invoke = vi.fn(async (messages: unknown) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const task = parseTask(messages);
      calls.push(task);
      await Promise.resolve();
      active -= 1;
      return {
        reconciliations: task.claims.map((claim) =>
          claim.issue.kind === "unresolved"
            ? {
                page: claim.page,
                claimId: claim.claimId,
                disposition: "delete",
              }
            : {
                page: claim.page,
                claimId: claim.claimId,
                disposition: "reaffirm",
                statement: claim.statement,
                evidence: claim.evidence.map((resource) => ({ resource })),
              },
        ),
      };
    });
    const model = {
      withStructuredOutput: () => ({ invoke }),
    } as unknown as BaseChatModel;
    const updateClaims = vi.spyOn(input.session, "updateClaims");

    const result = await reconcileClaimsBeforeAgent(model, input);

    expect(result).toEqual({ batchCount: 2, claimCount: 3, pageCount: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.claims.map((claim) => claim.claimId)).toEqual([
      "claim_shared",
      "claim_second",
    ]);
    expect(calls[1]?.claims.map((claim) => claim.claimId)).toEqual([
      "claim_missing",
    ]);
    expect(maximumActive).toBe(2);
    expect(updateClaims).toHaveBeenCalledTimes(2);
    expect(input.session.fetchClaims("/openwiki/overview.md")).toEqual({
      revision: 1,
      claims: [
        expect.objectContaining({
          id: "claim_shared",
          evidence: [expect.objectContaining({ version: "revision:2" })],
        }),
      ],
    });
    expect(input.context.issues).toEqual([
      { page: "/openwiki/overview.md", kind: "out-of-sync-page" },
      { page: "/openwiki/second.md", kind: "out-of-sync-page" },
    ]);
  });

  test("retries incomplete structured output without mutating working state", async () => {
    const input = createInput();
    const invoke = vi.fn(() => Promise.resolve({ reconciliations: [] }));
    const model = {
      withStructuredOutput: () => ({ invoke }),
    } as unknown as BaseChatModel;
    const updateClaims = vi.spyOn(input.session, "updateClaims");

    await expect(reconcileClaimsBeforeAgent(model, input)).rejects.toThrow(
      "failed after 2 attempts",
    );

    expect(invoke).toHaveBeenCalledTimes(4);
    expect(updateClaims).not.toHaveBeenCalled();
    expect(input.context.issues).toHaveLength(3);
    expect(input.session.fetchClaims("/openwiki/overview.md").revision).toBe(0);
  });

  test("does not invoke the model without claim-level issues", async () => {
    const input = createInput();
    input.context.issues = [
      { page: "/openwiki/overview.md", kind: "out-of-sync-page" },
    ];
    const withStructuredOutput = vi.fn();
    const model = { withStructuredOutput } as unknown as BaseChatModel;

    await expect(reconcileClaimsBeforeAgent(model, input)).resolves.toEqual({
      batchCount: 0,
      claimCount: 0,
      pageCount: 0,
    });
    expect(withStructuredOutput).not.toHaveBeenCalled();
  });

  test("supplies bounded current-source candidates for unresolved repository evidence", async () => {
    const rootDir = await mkdtemp(
      path.join(tmpdir(), "openwiki-reconciliation-candidates-"),
    );
    try {
      await mkdir(path.join(rootDir, "src/store"), { recursive: true });
      await writeFile(
        path.join(rootDir, "src/store/memory-store.ts"),
        "export class MemoryStore {}\n",
        "utf8",
      );
      const page = "/openwiki/store.md";
      const missing = "repo://src/store/redis-store.ts";
      const replacement = "repo://src/store/memory-store.ts";
      const persisted = new Map<string, PageClaims>([
        [
          page,
          {
            schemaVersion: 1,
            pageVersion: PAGE_VERSION,
            claims: [
              {
                id: "claim_store",
                statement: "A repository store exists.",
                evidence: [{ resource: missing, version: "revision:1" }],
              },
            ],
          },
        ],
      ]);
      const context: GroundingContext = {
        issues: [
          {
            page,
            kind: "unresolved",
            claimId: "claim_store",
            resources: [missing],
          },
        ],
      };
      const resolver = new RepositoryEvidenceResolver({ rootDir });
      const session = new ClaimSession({
        resolver,
        persisted,
        issues: context.issues,
        orphanPages: [],
      });
      const invoke = vi.fn((messages: unknown) => {
        const task = parseTask(messages);
        expect(task.claims[0]?.issue.candidates).toContain(replacement);
        expect(
          task.currentEvidence.find((item) => item.resource === replacement)
            ?.content,
        ).toContain("MemoryStore");
        return Promise.resolve({
          reconciliations: [
            {
              page,
              claimId: "claim_store",
              disposition: "revise",
              statement: "A memory-backed repository store exists.",
              evidence: [{ resource: replacement }],
            },
          ],
        });
      });
      const model = {
        withStructuredOutput: () => ({ invoke }),
      } as unknown as BaseChatModel;

      await reconcileClaimsBeforeAgent(model, {
        context,
        openWikiIgnore: new OpenWikiIgnore([]),
        persisted,
        resolver,
        rootDir,
        session,
      });

      expect(session.fetchClaims(page).claims).toEqual([
        expect.objectContaining({
          statement: "A memory-backed repository store exists.",
          evidence: [expect.objectContaining({ resource: replacement })],
        }),
      ]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});
