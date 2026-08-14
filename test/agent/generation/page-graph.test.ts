import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnableConfig } from "@langchain/core/runnables";
import { GraphRecursionError } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ClaimsStore } from "../../../src/claims/brains/code/store.ts";
import type { PageClaims } from "../../../src/claims/brains/code/types.ts";
import {
  ClaimsPersistenceError,
  EvidenceResolutionError,
} from "../../../src/claims/core/errors.ts";
import type {
  Claim,
  EvidenceResolver,
} from "../../../src/claims/core/types.ts";
import { MAX_PAGE_ELAPSED_MS } from "../../../src/agent/generation/config.ts";
import type {
  ClaimProposal,
  PageAuthorOutput,
  PageJob,
} from "../../../src/agent/generation/contracts.ts";
import { PageCommitter } from "../../../src/agent/generation/page-commit.ts";
import { createPageGraphRunner } from "../../../src/agent/generation/page-graph.ts";
import { PendingWorkStore } from "../../../src/agent/generation/pending-work-store.ts";
import type {
  AuthorPageInput,
  GenerationSpecialists,
  ReconcilePageInput,
} from "../../../src/agent/generation/specialists.ts";

const page = "/openwiki/architecture/runtime.md";
const relativePage = "openwiki/architecture/runtime.md";
const evidenceResource = "repo://src/runtime.ts#run";

type ReconcilerStep =
  | ClaimProposal
  | Error
  | ((input: ReconcilePageInput, config?: RunnableConfig) => ClaimProposal);
type AuthorStep =
  | PageAuthorOutput
  | Error
  | ((input: AuthorPageInput, config?: RunnableConfig) => PageAuthorOutput);

/**
 * Deterministic specialist double with explicit per-call scripts.
 */
class ScriptedSpecialists implements GenerationSpecialists {
  /**
   * Inputs observed by the Claims reconciler.
   */
  readonly reconcilerInputs: ReconcilePageInput[] = [];

  /**
   * Runnable configurations observed by the Claims reconciler.
   */
  readonly reconcilerConfigs: Array<RunnableConfig | undefined> = [];

  /**
   * Inputs observed by the Markdown author.
   */
  readonly authorInputs: AuthorPageInput[] = [];

  /**
   * Runnable configurations observed by the Markdown author.
   */
  readonly authorConfigs: Array<RunnableConfig | undefined> = [];

  constructor(
    private readonly reconcilerSteps: ReconcilerStep[],
    private readonly authorSteps: AuthorStep[] = [],
  ) {}

  /**
   * Runs the next scripted reconciliation step.
   */
  async reconcilePage(
    input: ReconcilePageInput,
    config?: RunnableConfig,
  ): Promise<ClaimProposal> {
    this.reconcilerInputs.push(structuredClone(input));
    this.reconcilerConfigs.push(config);
    const step = this.reconcilerSteps.shift();
    if (!step) throw new Error("Missing scripted reconciler step.");
    if (step instanceof Error) throw step;
    return await Promise.resolve(
      typeof step === "function" ? step(input, config) : step,
    );
  }

  /**
   * Runs the next scripted author step.
   */
  async authorPage(
    input: AuthorPageInput,
    config?: RunnableConfig,
  ): Promise<PageAuthorOutput> {
    this.authorInputs.push(structuredClone(input));
    this.authorConfigs.push(config);
    const step = this.authorSteps.shift();
    if (!step) throw new Error("Missing scripted author step.");
    if (step instanceof Error) throw step;
    return await Promise.resolve(
      typeof step === "function" ? step(input, config) : step,
    );
  }

  /**
   * Discovery is outside the standalone PageGraph boundary.
   */
  discover(): Promise<never> {
    return Promise.reject(new Error("Unexpected discovery invocation."));
  }

  /**
   * Review is outside the standalone PageGraph boundary.
   */
  review(): Promise<never> {
    return Promise.reject(new Error("Unexpected review invocation."));
  }
}

describe("standalone PageGraph", () => {
  let rootDir: string;
  let claimsStore: ClaimsStore;
  let pending: PendingWorkStore;
  let committer: PageCommitter;
  let resolver: EvidenceResolver;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-page-graph-"));
    claimsStore = new ClaimsStore(rootDir);
    pending = new PendingWorkStore(
      rootDir,
      () => new Date("2026-08-14T00:00:00Z"),
    );
    committer = new PageCommitter(rootDir, claimsStore, pending);
    resolver = {
      resolve(resource) {
        return Promise.resolve({
          evidence: { resource, version: "sha256:evidence" },
          content: "export function run() {}",
        });
      },
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { force: true, recursive: true });
  });

  test("commits a valid page and returns only compact terminal state", async () => {
    const specialists = new ScriptedSpecialists(
      [writeProposal()],
      [validAuthor],
    );

    const result = await runner(specialists).run(pageJob());

    expect(result).toMatchObject({
      page,
      status: "committed",
      reconcilerInvocations: 1,
      authorInvocations: 1,
      changedLinks: ["/openwiki/workflows/update.md"],
    });
    expect(result).not.toHaveProperty("claims");
    expect(result).not.toHaveProperty("markdown");
    await expect(claimsStore.loadPage(page)).resolves.toMatchObject({
      claims: [{ statement: "Runtime runs requests." }],
    });
  });

  test("returns a structured deferral without authoring", async () => {
    const specialists = new ScriptedSpecialists([
      { disposition: "defer", claims: [], reason: "Evidence is unavailable." },
    ]);

    await expect(runner(specialists).run(pageJob())).resolves.toMatchObject({
      status: "deferred",
      reconcilerInvocations: 1,
      authorInvocations: 0,
      failure: { code: "deferred", message: "Evidence is unavailable." },
    });
    expect(specialists.authorInputs).toHaveLength(0);
  });

  test("repairs unknown Claim IDs exactly three times", async () => {
    const unknown = writeProposal({ id: "claim_unknown" });
    const specialists = new ScriptedSpecialists([unknown, unknown, unknown]);

    const result = await runner(specialists).run(pageJob());

    expect(result).toMatchObject({
      status: "failed",
      reconcilerInvocations: 3,
      authorInvocations: 0,
      failure: { code: "claims_invalid" },
    });
    expect(result.failure?.message).toContain("unknown id claim_unknown");
    expect(specialists.reconcilerInputs[1].repairErrors).toEqual([
      expect.stringContaining("unknown id claim_unknown"),
    ]);
  });

  test("requires both a delete job and reconciler deletion proof", async () => {
    const deletion: ClaimProposal = {
      disposition: "delete",
      claims: [],
      reason: "The canonical subject was removed.",
    };
    const unprovenDelete = new ScriptedSpecialists([
      deletion,
      deletion,
      deletion,
    ]);

    await expect(runner(unprovenDelete).run(pageJob())).resolves.toMatchObject({
      status: "failed",
      reconcilerInvocations: 3,
      authorInvocations: 0,
      failure: { code: "claims_invalid" },
    });

    await seedExistingPage();
    const provenDelete = new ScriptedSpecialists([deletion]);
    await expect(
      runner(provenDelete).run(pageJob({ operation: "delete" })),
    ).resolves.toMatchObject({
      status: "deleted",
      reconcilerInvocations: 1,
      authorInvocations: 0,
    });
    expect(provenDelete.authorInputs).toHaveLength(0);
    await expect(claimsStore.loadPage(page)).resolves.toBeNull();
  });

  test("does not delete when a delete job is reconciled as a write", async () => {
    const specialists = new ScriptedSpecialists(
      [writeProposal()],
      [validAuthor],
    );

    await expect(
      runner(specialists).run(pageJob({ operation: "delete" })),
    ).resolves.toMatchObject({ status: "failed" });
    expect(specialists.authorInputs).toHaveLength(1);
  });

  test("bounds retryable reconciler transport failures at three calls", async () => {
    const specialists = new ScriptedSpecialists([
      retryableFailure("first"),
      retryableFailure("second"),
      retryableFailure("third"),
    ]);

    await expect(runner(specialists).run(pageJob())).resolves.toMatchObject({
      status: "failed",
      reconcilerInvocations: 3,
      authorInvocations: 0,
      failure: { code: "reconciler_failed", message: "third" },
    });
    expect(specialists.reconcilerInputs).toHaveLength(3);
  });

  test("stops a non-retryable reconciler failure after its actual call", async () => {
    const failure = Object.assign(new Error("invalid API key"), {
      status: 401,
    });
    const specialists = new ScriptedSpecialists([failure]);

    await expect(runner(specialists).run(pageJob())).resolves.toMatchObject({
      status: "failed",
      reconcilerInvocations: 1,
      failure: { code: "reconciler_failed", message: "invalid API key" },
    });
  });

  test("bounds retryable author transport failures at three calls", async () => {
    const specialists = new ScriptedSpecialists(
      [writeProposal()],
      [
        retryableFailure("author one"),
        retryableFailure("author two"),
        retryableFailure("author three"),
      ],
    );

    await expect(runner(specialists).run(pageJob())).resolves.toMatchObject({
      status: "failed",
      reconcilerInvocations: 1,
      authorInvocations: 3,
      failure: { code: "author_failed", message: "author three" },
    });
  });

  test("repairs an invalid page with targeted errors", async () => {
    const specialists = new ScriptedSpecialists(
      [writeProposal()],
      [
        (input) => ({
          markdown: "# Missing front matter\n",
          representedClaimIds: input.claims.map(({ id }) => id),
        }),
        validAuthor,
      ],
    );

    await expect(runner(specialists).run(pageJob())).resolves.toMatchObject({
      status: "committed",
      authorInvocations: 2,
    });
    expect(specialists.authorInputs[1].repairErrors).toEqual([
      expect.stringContaining("missing_opening_delimiter"),
      expect.stringContaining("missing_title"),
      expect.stringContaining("missing_description"),
    ]);
  });

  test.each([
    ["malformed OKF", "---\ntype: [\n---\n# Runtime\n", "invalid_yaml"],
    [
      "missing title",
      "---\ntype: Reference\ndescription: Runtime.\n---\n",
      "missing_title",
    ],
    [
      "missing description",
      "---\ntype: Reference\ntitle: Runtime\n---\n",
      "missing_description",
    ],
  ])(
    "rejects %s after the exact author bound",
    async (_name, markdown, diagnostic) => {
      const invalid = (input: AuthorPageInput): PageAuthorOutput => ({
        markdown,
        representedClaimIds: input.claims.map(({ id }) => id),
      });
      const specialists = new ScriptedSpecialists(
        [writeProposal()],
        [invalid, invalid, invalid],
      );

      const result = await runner(specialists).run(pageJob());

      expect(result).toMatchObject({
        status: "failed",
        authorInvocations: 3,
        failure: { code: "page_invalid" },
      });
      expect(result.failure?.message).toContain(diagnostic);
    },
  );

  test.each([
    ["duplicate", (ids: string[]) => [ids[0], ids[0]], "duplicates"],
    ["missing", () => [], "must equal the complete Claim set"],
  ])(
    "rejects %s represented Claim IDs",
    async (_name, represented, diagnostic) => {
      const invalid = (input: AuthorPageInput): PageAuthorOutput => ({
        markdown: validMarkdown(),
        representedClaimIds: represented(input.claims.map(({ id }) => id)),
      });
      const specialists = new ScriptedSpecialists(
        [writeProposal()],
        [invalid, invalid, invalid],
      );

      const result = await runner(specialists).run(pageJob());

      expect(result).toMatchObject({
        status: "failed",
        authorInvocations: 3,
        failure: { code: "page_invalid" },
      });
      expect(result.failure?.message).toContain(diagnostic);
    },
  );

  test.each([
    "/Users/alice/dev/repo/src/runtime.ts",
    "/home/alice/repo/src/runtime.ts",
    "C:\\Users\\alice\\repo\\src\\runtime.ts",
    "file:///private/var/tmp/repo/src/runtime.ts",
  ])("rejects host-absolute path %s", async (hostPath) => {
    const invalid = (input: AuthorPageInput): PageAuthorOutput => ({
      markdown: `${validMarkdown()}\nFound at \`${hostPath}\`.\n`,
      representedClaimIds: input.claims.map(({ id }) => id),
    });
    const specialists = new ScriptedSpecialists(
      [writeProposal()],
      [invalid, invalid, invalid],
    );

    const result = await runner(specialists).run(pageJob());

    expect(result.failure?.message).toContain("host-absolute path");
    expect(result.authorInvocations).toBe(3);
  });

  test("rejects unsafe OpenWiki links before committing", async () => {
    const invalid = (input: AuthorPageInput): PageAuthorOutput => ({
      markdown: `${validMarkdown()}\n[Escape](/openwiki/../README.md)\n`,
      representedClaimIds: input.claims.map(({ id }) => id),
    });
    const commitSpy = vi.spyOn(committer, "commit");
    const specialists = new ScriptedSpecialists(
      [writeProposal()],
      [invalid, invalid, invalid],
    );

    const result = await runner(specialists).run(pageJob());

    expect(result.failure?.message).toContain("non-canonical OpenWiki link");
    expect(commitSpy).not.toHaveBeenCalled();
  });

  test("reports an unchanged transaction after a semantically identical rerun", async () => {
    const first = new ScriptedSpecialists([writeProposal()], [validAuthor]);
    await runner(first).run(pageJob());
    const persisted = await claimsStore.loadPage(page);
    expect(persisted).not.toBeNull();
    const retained = writeProposal({ id: persisted?.claims[0].id });
    const second = new ScriptedSpecialists([retained], [validAuthor]);

    await expect(runner(second).run(pageJob())).resolves.toMatchObject({
      status: "unchanged",
      reconcilerInvocations: 1,
      authorInvocations: 1,
    });
  });

  test("converts an ordinary commit failure to a structured page failure", async () => {
    const failure = new Error("disk temporarily unavailable");
    const failingCommitter = {
      commit: vi.fn().mockRejectedValue(failure),
      delete: vi.fn(),
    } as unknown as PageCommitter;
    const specialists = new ScriptedSpecialists(
      [writeProposal()],
      [validAuthor],
    );

    await expect(
      runner(specialists, { committer: failingCommitter }).run(pageJob()),
    ).resolves.toMatchObject({
      status: "failed",
      failure: { code: "commit_failed", message: failure.message },
    });
  });

  test.each([
    new AggregateError([new Error("publish"), new Error("rollback")]),
    new ClaimsPersistenceError("malformed owned sidecar"),
  ])("propagates systemic commit failure", async (failure) => {
    const failingCommitter = {
      commit: vi.fn().mockRejectedValue(failure),
      delete: vi.fn(),
    } as unknown as PageCommitter;
    const specialists = new ScriptedSpecialists(
      [writeProposal()],
      [validAuthor],
    );

    await expect(
      runner(specialists, { committer: failingCommitter }).run(pageJob()),
    ).rejects.toBe(failure);
  });

  test("propagates evidence-resolution infrastructure failure", async () => {
    const failure = new EvidenceResolutionError("repository read failed");
    resolver = { resolve: vi.fn().mockRejectedValue(failure) };
    const specialists = new ScriptedSpecialists([writeProposal()]);

    await expect(runner(specialists).run(pageJob())).rejects.toBe(failure);
  });

  test("converts specialist timeout failures to bounded partial progress", async () => {
    const timeout = new DOMException("The operation timed out", "TimeoutError");
    const specialists = new ScriptedSpecialists([timeout, timeout, timeout]);

    await expect(runner(specialists).run(pageJob())).resolves.toMatchObject({
      status: "failed",
      reconcilerInvocations: 3,
      failure: { code: "reconciler_failed" },
    });
  });

  test("caps retries at the twelve-minute page budget", async () => {
    let currentTime = 1_000;
    const timeoutBudgets: number[] = [];
    const timedFailure =
      (message: string): ReconcilerStep =>
      () => {
        currentTime += 6 * 60_000;
        throw retryableFailure(message);
      };
    const specialists = new ScriptedSpecialists([
      timedFailure("first timeout"),
      timedFailure("second timeout"),
      retryableFailure("must not run"),
    ]);

    const result = await runner(specialists, {
      now: () => currentTime,
      createTimeoutSignal: (timeoutMs) => {
        timeoutBudgets.push(timeoutMs);
        return new AbortController().signal;
      },
    }).run(pageJob());

    expect(result).toMatchObject({
      status: "failed",
      reconcilerInvocations: 2,
      durationMs: MAX_PAGE_ELAPSED_MS,
    });
    expect(timeoutBudgets).toEqual([MAX_PAGE_ELAPSED_MS, 6 * 60_000]);
  });

  test("passes the remaining page budget into the author attempt", async () => {
    let currentTime = 10_000;
    const timeoutBudgets: number[] = [];
    const specialists = new ScriptedSpecialists(
      [
        () => {
          currentTime += 11 * 60_000;
          return writeProposal();
        },
      ],
      [validAuthor],
    );

    await runner(specialists, {
      now: () => currentTime,
      createTimeoutSignal: (timeoutMs) => {
        timeoutBudgets.push(timeoutMs);
        return new AbortController().signal;
      },
    }).run(pageJob());

    expect(timeoutBudgets).toEqual([MAX_PAGE_ELAPSED_MS, 60_000]);
  });

  test("composes and propagates caller cancellation", async () => {
    const caller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const cancellationStep: ReconcilerStep = (_input, config) => {
      observedSignal = config?.signal;
      caller.abort();
      throw caller.signal.reason;
    };
    const specialists = new ScriptedSpecialists([cancellationStep]);

    await expect(
      runner(specialists).run(pageJob(), { signal: caller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal).not.toBe(caller.signal);
    expect(observedSignal?.aborted).toBe(true);
    expect(specialists.reconcilerInputs).toHaveLength(1);
  });

  test("propagates GraphRecursionError instead of converting it to a page failure", async () => {
    const specialists = new ScriptedSpecialists(
      [writeProposal()],
      [validAuthor],
    );

    await expect(
      runner(specialists).run(pageJob(), { recursionLimit: 1 }),
    ).rejects.toBeInstanceOf(GraphRecursionError);
  });

  /**
   * Builds a PageGraph runner with focused dependency overrides.
   */
  function runner(
    specialists: GenerationSpecialists,
    overrides: Partial<{
      committer: PageCommitter;
      now: () => number;
      createTimeoutSignal: (timeoutMs: number) => AbortSignal;
    }> = {},
  ) {
    return createPageGraphRunner({
      rootDir,
      claimsStore,
      resolver,
      specialists,
      committer,
      ...overrides,
    });
  }

  /**
   * Seeds a synchronized existing Markdown page and Claim sidecar.
   */
  async function seedExistingPage(): Promise<void> {
    const markdown = validMarkdown();
    await mkdir(path.join(rootDir, path.dirname(relativePage)), {
      recursive: true,
    });
    await writeFile(path.join(rootDir, relativePage), markdown, "utf8");
    const state: PageClaims = {
      schemaVersion: 1,
      pageVersion: await claimsStore.hashPage(page),
      claims: [existingClaim()],
    };
    await claimsStore.writePage(page, state);
  }
});

/**
 * Creates a valid normalized page job.
 */
function pageJob(overrides: Partial<PageJob> = {}): PageJob {
  return {
    id: "job_runtime",
    page,
    operation: "reconcile",
    reasons: ["source-changed"],
    sourceHints: ["src/runtime.ts"],
    wave: 0,
    priority: 500,
    ...overrides,
  };
}

/**
 * Creates a complete write proposal with an optional retained Claim ID.
 */
function writeProposal(overrides: { id?: string } = {}): ClaimProposal {
  return {
    disposition: "write",
    claims: [
      {
        ...overrides,
        statement: "Runtime runs requests.",
        evidence: [{ resource: evidenceResource }],
      },
    ],
    reason: "Current source establishes the runtime.",
  };
}

/**
 * Creates one persisted Claim fixture.
 */
function existingClaim(): Claim {
  return {
    id: "claim_runtime",
    statement: "Runtime runs requests.",
    evidence: [{ resource: evidenceResource, version: "sha256:evidence" }],
  };
}

/**
 * Produces valid Markdown representing every resolved Claim exactly once.
 */
function validAuthor(input: AuthorPageInput): PageAuthorOutput {
  return {
    markdown: validMarkdown(),
    representedClaimIds: input.claims.map(({ id }) => id),
  };
}

/**
 * Produces a valid canonical page body.
 */
function validMarkdown(): string {
  return `---
type: Reference
title: Runtime
description: How requests flow through the runtime.
---

# Runtime

Runtime runs requests. See [update](/openwiki/workflows/update.md).
`;
}

/**
 * Creates an HTTP-like retryable provider failure.
 */
function retryableFailure(message: string): Error {
  return Object.assign(new Error(message), { status: 503 });
}
