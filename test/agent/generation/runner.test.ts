import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { GraphRecursionError } from "@langchain/langgraph";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backendConstructor: vi.fn(),
  claimsStore: {},
  claimsStoreConstructor: vi.fn(),
  committer: {},
  committerConstructor: vi.fn(),
  createGenerationSpecialists: vi.fn(),
  createPageGraphRunner: vi.fn(),
  migrateWikiToOkf: vi.fn(),
  pending: { list: vi.fn() },
  pendingConstructor: vi.fn(),
  resolver: {},
  resolverConstructor: vi.fn(),
  resolveTranslationPlan: vi.fn(),
  runClaimsPreflight: vi.fn(),
  runGenerationFinalizers: vi.fn(),
  runInitGraph: vi.fn(),
  runUpdateGraph: vi.fn(),
  specialists: {},
  pages: {},
}));

vi.mock("../../../src/claims/brains/code/preflight.js", () => ({
  runClaimsPreflight: mocks.runClaimsPreflight,
}));
vi.mock("../../../src/claims/brains/code/store.js", () => ({
  ClaimsStore: class {
    constructor(rootDir: string) {
      mocks.claimsStoreConstructor(rootDir);
      return mocks.claimsStore;
    }
  },
}));
vi.mock("../../../src/claims/evidence/repository/resolver.js", () => ({
  RepositoryEvidenceResolver: class {
    constructor(options: unknown) {
      mocks.resolverConstructor(options);
      return mocks.resolver;
    }
  },
}));
vi.mock("../../../src/okf/index-sync.js", () => ({
  migrateWikiToOkf: mocks.migrateWikiToOkf,
}));
vi.mock("../../../src/agent/docs-only-backend.js", () => ({
  OpenWikiLocalShellBackend: class {
    constructor(options: unknown) {
      mocks.backendConstructor(options);
    }
  },
}));
vi.mock("../../../src/agent/translation-middleware.js", () => ({
  resolveTranslationPlan: mocks.resolveTranslationPlan,
}));
vi.mock("../../../src/agent/generation/finalizers.js", () => ({
  runGenerationFinalizers: mocks.runGenerationFinalizers,
}));
vi.mock("../../../src/agent/generation/init-graph.js", () => ({
  runInitGraph: mocks.runInitGraph,
}));
vi.mock("../../../src/agent/generation/page-commit.js", () => ({
  PageCommitter: class {
    constructor(...args: unknown[]) {
      mocks.committerConstructor(...args);
      return mocks.committer;
    }
  },
}));
vi.mock("../../../src/agent/generation/page-graph.js", () => ({
  createPageGraphRunner: mocks.createPageGraphRunner,
}));
vi.mock("../../../src/agent/generation/pending-work-store.js", () => ({
  PendingWorkStore: class {
    constructor(rootDir: string) {
      mocks.pendingConstructor(rootDir);
      return mocks.pending;
    }
  },
}));
vi.mock("../../../src/agent/generation/specialists.js", () => ({
  createGenerationSpecialists: mocks.createGenerationSpecialists,
}));
vi.mock("../../../src/agent/generation/update-graph.js", () => ({
  runUpdateGraph: mocks.runUpdateGraph,
}));

import { OpenWikiIgnore } from "../../../src/agent/openwiki-ignore.ts";
import {
  generationClaimsRequireAttention,
  runGenerationWorkflow,
} from "../../../src/agent/generation/runner.ts";
import type { GenerationRunnerInput } from "../../../src/agent/generation/runner.ts";

const COMPLETE_SUMMARY = {
  status: "complete" as const,
  planned: 0,
  committed: 0,
  unchanged: 0,
  deleted: 0,
  failed: 0,
  deferred: 0,
  pending: 0,
};

/**
 * Creates one prepared runner input and captures emitted events.
 *
 * @param command - Graph command under test.
 * @returns Runner input and emitted text.
 */
function input(command: "init" | "update" = "update") {
  const events: string[] = [];
  const value: GenerationRunnerInput = {
    command,
    cwd: "/tmp/openwiki-runner",
    model: {} as BaseChatModel,
    context: {
      lastUpdate: null,
      language: "en",
      wikiGoal: "Document the runtime.",
    },
    openWikiIgnore: new OpenWikiIgnore([]),
    options: {
      generationConcurrency: 3,
      onEvent: (event) => {
        if (event.type === "text") events.push(event.text);
      },
    },
    threadId: "thread-123",
  };
  return { events, value };
}

describe("generation runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createGenerationSpecialists.mockReturnValue(mocks.specialists);
    mocks.createPageGraphRunner.mockReturnValue(mocks.pages);
    mocks.migrateWikiToOkf.mockResolvedValue(undefined);
    mocks.pending.list.mockResolvedValue([]);
    mocks.resolveTranslationPlan.mockReturnValue(undefined);
    mocks.runClaimsPreflight.mockResolvedValue({
      context: { issues: [] },
      orphanPages: [],
    });
    mocks.runGenerationFinalizers.mockResolvedValue(undefined);
    mocks.runInitGraph.mockResolvedValue(COMPLETE_SUMMARY);
    mocks.runUpdateGraph.mockResolvedValue(COMPLETE_SUMMARY);
  });

  test("runs update with bounded concurrency, tracing, and finalizers", async () => {
    const { events, value } = input();

    await expect(runGenerationWorkflow(value)).resolves.toEqual(
      COMPLETE_SUMMARY,
    );

    expect(mocks.runUpdateGraph).toHaveBeenCalledOnce();
    expect(mocks.runUpdateGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: value.cwd,
        context: value.context,
        pending: mocks.pending,
        pages: mocks.pages,
        specialists: mocks.specialists,
      }),
      {
        configurable: { thread_id: "thread-123" },
        maxConcurrency: 3,
        recursionLimit: 10_000,
        tags: ["openwiki", "architecture:langgraph", "command:update"],
      },
    );
    expect(mocks.runGenerationFinalizers).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "OpenWiki update graph started (concurrency 3).\n\n",
      "OpenWiki update graph completed.\n",
    ]);
  });

  test("reports partial after finalizers leave durable work", async () => {
    const { events, value } = input("init");
    mocks.pending.list.mockResolvedValue([{ id: "finalizer:links" }]);

    await expect(runGenerationWorkflow(value)).resolves.toEqual({
      ...COMPLETE_SUMMARY,
      status: "partial",
      pending: 1,
    });

    expect(events.at(-1)).toBe(
      "OpenWiki init saved partial progress; 1 item(s) will be retried.\n",
    );
  });

  test("wraps the emergency recursion fuse without running finalizers", async () => {
    const { value } = input("init");
    const recursion = new GraphRecursionError();
    mocks.runInitGraph.mockRejectedValue(recursion);

    const failure = await runGenerationWorkflow(value).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("10,000-step emergency");
    expect((failure as Error).cause).toBe(recursion);
    expect(mocks.runGenerationFinalizers).not.toHaveBeenCalled();
  });

  test("preserves caller cancellation", async () => {
    const { value } = input();
    const cancellation = new DOMException("cancelled", "AbortError");
    mocks.runUpdateGraph.mockRejectedValue(cancellation);

    await expect(runGenerationWorkflow(value)).rejects.toBe(cancellation);
  });

  test("checks both Claims issues and orphan sidecars for attention", async () => {
    const ignore = new OpenWikiIgnore([]);
    mocks.runClaimsPreflight.mockResolvedValueOnce({
      context: { issues: [{ page: "/openwiki/page.md" }] },
      orphanPages: [],
    });
    await expect(
      generationClaimsRequireAttention("/tmp/openwiki-runner", ignore),
    ).resolves.toBe(true);

    mocks.runClaimsPreflight.mockResolvedValueOnce({
      context: { issues: [] },
      orphanPages: ["/openwiki/orphan.md"],
    });
    await expect(
      generationClaimsRequireAttention("/tmp/openwiki-runner", ignore),
    ).resolves.toBe(true);
  });
});
