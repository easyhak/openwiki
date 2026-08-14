import { describe, expect, test } from "vitest";
import {
  hashClaimSet,
  reconcileCompleteClaimSet,
} from "../../../../src/claims/brains/code/reconcile.ts";
import type {
  Claim,
  EvidenceResolver,
  ResolvedEvidence,
} from "../../../../src/claims/core/types.ts";

/**
 * Creates deterministic resolved evidence.
 *
 * @param resource - Canonical resolved resource.
 * @param version - Resolver-owned version.
 * @returns Resolved evidence fixture.
 */
function resolved(resource: string, version: string): ResolvedEvidence {
  return {
    evidence: { resource, version },
    content: `content for ${resource}`,
  };
}

/**
 * Creates a resolver backed by exact resource outcomes.
 *
 * @param outcomes - Resolution outcome by proposed resource.
 * @param calls - Optional ordered call log.
 * @returns Deterministic evidence resolver.
 */
function createResolver(
  outcomes: ReadonlyMap<string, ResolvedEvidence | null | Error>,
  calls?: string[],
): EvidenceResolver {
  return {
    resolve(resource: string): Promise<ResolvedEvidence | null> {
      calls?.push(resource);
      const outcome = outcomes.get(resource);
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(outcome ?? null);
    },
  };
}

const existing: Claim[] = [
  {
    id: "claim_keep",
    statement: "The old runtime is active.",
    evidence: [{ resource: "repo://src/old.ts", version: "old" }],
  },
  {
    id: "claim_remove",
    statement: "The removed runtime is active.",
    evidence: [{ resource: "repo://src/remove.ts", version: "old" }],
  },
];

describe("reconcileCompleteClaimSet", () => {
  test("updates retained IDs, adds new Claims, and deletes omitted Claims", async () => {
    const calls: string[] = [];
    const result = await reconcileCompleteClaimSet({
      existing,
      proposal: {
        disposition: "write",
        reason: "Current source supports the complete set.",
        claims: [
          {
            id: "claim_keep",
            statement: "The current runtime is active.",
            evidence: [{ resource: "repo://src/runtime.ts" }],
          },
          {
            statement: "The runtime is tested.",
            evidence: [{ resource: "repo://test/runtime.test.ts" }],
          },
        ],
      },
      resolver: createResolver(
        new Map([
          [
            "repo://src/runtime.ts",
            resolved("repo://src/runtime.ts#runtime", "version:2"),
          ],
          [
            "repo://test/runtime.test.ts",
            resolved("repo://test/runtime.test.ts", "version:1"),
          ],
        ]),
        calls,
      ),
      createClaimId: () => "claim_added",
    });

    expect(result).toEqual([
      {
        id: "claim_keep",
        statement: "The current runtime is active.",
        evidence: [
          { resource: "repo://src/runtime.ts#runtime", version: "version:2" },
        ],
      },
      {
        id: "claim_added",
        statement: "The runtime is tested.",
        evidence: [
          { resource: "repo://test/runtime.test.ts", version: "version:1" },
        ],
      },
    ]);
    expect(calls).toEqual([
      "repo://src/runtime.ts",
      "repo://test/runtime.test.ts",
    ]);
    expect(existing[0].statement).toBe("The old runtime is active.");
  });

  test("deletes the complete existing set without resolving evidence", async () => {
    const calls: string[] = [];

    await expect(
      reconcileCompleteClaimSet({
        existing,
        proposal: {
          disposition: "delete",
          claims: [],
          reason: "The canonical subject was removed.",
        },
        resolver: createResolver(new Map(), calls),
      }),
    ).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  test("rejects unknown and repeated retained IDs", async () => {
    const resolver = createResolver(new Map());

    await expect(
      reconcileCompleteClaimSet({
        existing,
        proposal: {
          disposition: "write",
          reason: "Unknown ID.",
          claims: [
            {
              id: "claim_unknown",
              statement: "Unknown.",
              evidence: [{ resource: "repo://src/runtime.ts" }],
            },
          ],
        },
        resolver,
      }),
    ).rejects.toThrow("unknown id claim_unknown");
    await expect(
      reconcileCompleteClaimSet({
        existing,
        proposal: {
          disposition: "write",
          reason: "Repeated ID.",
          claims: [
            {
              id: "claim_keep",
              statement: "First.",
              evidence: [{ resource: "repo://src/runtime.ts" }],
            },
            {
              id: "claim_keep",
              statement: "Second.",
              evidence: [{ resource: "repo://src/runtime.ts" }],
            },
          ],
        },
        resolver,
      }),
    ).rejects.toThrow("repeats id claim_keep");
  });

  test("rejects deferred and empty write proposals", async () => {
    const resolver = createResolver(new Map());

    await expect(
      reconcileCompleteClaimSet({
        existing,
        proposal: {
          disposition: "defer",
          claims: [],
          reason: "Evidence is unavailable.",
        },
        resolver,
      }),
    ).rejects.toThrow("Deferred Claim proposal");
    await expect(
      reconcileCompleteClaimSet({
        existing,
        proposal: {
          disposition: "write",
          claims: [],
          reason: "Invalid empty page.",
        },
        resolver,
      }),
    ).rejects.toThrow("requires at least one Claim");
  });

  test("propagates resolution failure without mutating existing Claims", async () => {
    const snapshot = structuredClone(existing);
    const failure = new Error("resolver unavailable");

    await expect(
      reconcileCompleteClaimSet({
        existing,
        proposal: {
          disposition: "write",
          reason: "Attempted update.",
          claims: [
            {
              id: "claim_keep",
              statement: "Changed.",
              evidence: [{ resource: "repo://src/runtime.ts" }],
            },
          ],
        },
        resolver: createResolver(new Map([["repo://src/runtime.ts", failure]])),
      }),
    ).rejects.toBe(failure);
    expect(existing).toEqual(snapshot);
  });
});

describe("hashClaimSet", () => {
  test("is stable across Claim and evidence ordering", () => {
    const claims: Claim[] = [
      {
        id: "claim_b",
        statement: "B.",
        evidence: [
          { resource: "repo://z", version: "2" },
          { resource: "repo://a", version: "1" },
        ],
      },
      {
        id: "claim_a",
        statement: "A.",
        evidence: [{ resource: "repo://m", version: "1" }],
      },
    ];
    const reordered = [
      claims[1],
      {
        ...claims[0],
        evidence: [...claims[0].evidence].reverse(),
      },
    ];

    expect(hashClaimSet(claims)).toBe(hashClaimSet(reordered));
    expect(hashClaimSet(claims)).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  test("changes when factual content or evidence versions change", () => {
    const claims: Claim[] = [
      {
        id: "claim_a",
        statement: "A.",
        evidence: [{ resource: "repo://a", version: "1" }],
      },
    ];

    expect(hashClaimSet([{ ...claims[0], statement: "Changed." }])).not.toBe(
      hashClaimSet(claims),
    );
    expect(
      hashClaimSet([
        {
          ...claims[0],
          evidence: [{ resource: "repo://a", version: "2" }],
        },
      ]),
    ).not.toBe(hashClaimSet(claims));
  });
});
