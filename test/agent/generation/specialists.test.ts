import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { BackendProtocolV2 } from "deepagents";
import { beforeEach, describe, expect, test, vi, type Mock } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  createFilesystemMiddleware: vi.fn((options: unknown) => ({ options })),
}));

vi.mock("langchain", () => ({ createAgent: mocks.createAgent }));
vi.mock("deepagents", () => ({
  createFilesystemMiddleware: mocks.createFilesystemMiddleware,
}));

import {
  createGenerationSpecialists,
  isCircuitBreakingSpecialistFailure,
  isRetryableSpecialistFailure,
} from "../../../src/agent/generation/specialists.ts";

interface ScriptedAgent {
  invoke: Mock<
    (
      input: unknown,
      config?: RunnableConfig,
    ) => Promise<{ structuredResponse?: unknown }>
  >;
  withConfig: Mock<(config: RunnableConfig) => ScriptedAgent>;
}

const model = {} as BaseChatModel;
const backend = {} as BackendProtocolV2;

/**
 * Creates one mocked structured agent that preserves `withConfig` chaining.
 *
 * @returns Agent invocation and configuration spies.
 */
function scriptedAgent(): ScriptedAgent {
  const agent = {} as ScriptedAgent;
  agent.invoke = vi.fn();
  agent.withConfig = vi.fn();
  agent.withConfig.mockReturnValue(agent);
  return agent;
}

describe("generation specialists", () => {
  let agents: ScriptedAgent[];

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.createAgent.mockReset();
    mocks.createFilesystemMiddleware.mockClear();
    agents = Array.from({ length: 4 }, () => scriptedAgent());
    mocks.createAgent.mockImplementation(() => agents.shift());
  });

  test("gives research specialists only read-only filesystem tools", () => {
    createGenerationSpecialists(model, backend);

    expect(mocks.createFilesystemMiddleware).toHaveBeenCalledTimes(3);
    for (const [options] of mocks.createFilesystemMiddleware.mock.calls) {
      expect(options).toMatchObject({
        backend,
        tools: ["read_file", "ls", "glob", "grep"],
      });
      expect(options.tools).not.toContain("write_file");
      expect(options.tools).not.toContain("edit_file");
      expect(options.tools).not.toContain("execute");
    }

    const createOptions = mocks.createAgent.mock.calls.map(
      ([options]) => options as { middleware?: unknown[]; tools: unknown[] },
    );
    expect(createOptions).toHaveLength(4);
    expect(createOptions[1].middleware).toBeUndefined();
    expect(createOptions.every(({ tools }) => tools.length === 0)).toBe(true);
  });

  test("applies five-minute research and three-minute author timeouts", async () => {
    const timeoutMs: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      timeoutMs.push(milliseconds);
      return new AbortController().signal;
    });
    const [reconciler, author, discovery, reviewer] = agents;
    reconciler.invoke.mockResolvedValue({
      structuredResponse: {
        disposition: "defer",
        claims: [],
        reason: "No safe evidence.",
      },
    });
    author.invoke.mockResolvedValue({
      structuredResponse: {
        markdown: "---\ntype: Reference\n---\n",
        representedClaimIds: [],
      },
    });
    discovery.invoke.mockResolvedValue({
      structuredResponse: {
        partitionId: "partition",
        jobs: [],
        deferrals: [],
      },
    });
    reviewer.invoke.mockResolvedValue({
      structuredResponse: { jobs: [], gaps: [], resolvedPendingIds: [] },
    });
    const specialists = createGenerationSpecialists(model, backend);

    await specialists.reconcilePage({
      job: pageJob(),
      existingMarkdown: null,
      existingClaims: [],
    });
    await specialists.authorPage({
      job: pageJob(),
      existingMarkdown: null,
      claims: [],
    });
    await specialists.discover(
      { id: "partition", roots: ["src"], manifests: [] },
      undefined,
    );
    await specialists.review("Review one thing", {});

    expect(timeoutMs).toEqual([300_000, 180_000, 300_000, 300_000]);
  });

  test("composes a parent cancellation signal with the specialist timeout", async () => {
    const parent = new AbortController();
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const reconciler = agents[0];
    let invocationConfig: RunnableConfig | undefined;
    reconciler.invoke.mockImplementation(
      (_input: unknown, config?: RunnableConfig) => {
        invocationConfig = config;
        return Promise.resolve({
          structuredResponse: {
            disposition: "defer",
            claims: [],
            reason: "No safe evidence.",
          },
        });
      },
    );
    const specialists = createGenerationSpecialists(model, backend);

    await specialists.reconcilePage(
      {
        job: pageJob(),
        existingMarkdown: null,
        existingClaims: [],
      },
      { signal: parent.signal },
    );

    expect(invocationConfig?.signal).not.toBe(parent.signal);
    expect(invocationConfig?.signal?.aborted).toBe(false);
    parent.abort();
    expect(invocationConfig?.signal?.aborted).toBe(true);
  });

  test.each([
    Object.assign(new Error("invalid API key"), { status: 401 }),
    Object.assign(new Error("quota exhausted"), {
      status: 429,
      error: { code: "insufficient_quota" },
    }),
  ])("opens the shared circuit for auth or quota failure", async (failure) => {
    const reconciler = agents[0];
    const author = agents[1];
    reconciler.invoke.mockRejectedValue(failure);
    author.invoke.mockResolvedValue({
      structuredResponse: {
        markdown: "---\ntype: Reference\n---\n",
        representedClaimIds: [],
      },
    });
    const specialists = createGenerationSpecialists(model, backend);

    await expect(
      specialists.reconcilePage({
        job: pageJob(),
        existingMarkdown: null,
        existingClaims: [],
      }),
    ).rejects.toBe(failure);
    await expect(
      specialists.authorPage({
        job: pageJob(),
        existingMarkdown: null,
        claims: [],
      }),
    ).rejects.toBe(failure);
    expect(author.invoke).not.toHaveBeenCalled();
  });

  test("aborts an in-flight sibling when the shared circuit opens", async () => {
    const failure = Object.assign(new Error("invalid API key"), {
      status: 401,
    });
    const reconciler = agents[0];
    const author = agents[1];
    let authorSignal: AbortSignal | undefined;
    reconciler.invoke.mockRejectedValue(failure);
    author.invoke.mockImplementation(
      (_input: unknown, config?: RunnableConfig) =>
        new Promise((_resolve, reject) => {
          authorSignal = config?.signal;
          config?.signal?.addEventListener(
            "abort",
            () => {
              const reason: unknown = config.signal?.reason;
              reject(
                reason instanceof Error
                  ? reason
                  : new Error("Specialist circuit opened."),
              );
            },
            { once: true },
          );
        }),
    );
    const specialists = createGenerationSpecialists(model, backend);

    const reconciliation = specialists.reconcilePage({
      job: pageJob(),
      existingMarkdown: null,
      existingClaims: [],
    });
    const authoring = specialists.authorPage({
      job: pageJob(),
      existingMarkdown: null,
      claims: [],
    });

    await expect(reconciliation).rejects.toBe(failure);
    await expect(authoring).rejects.toBe(failure);
    expect(author.invoke).toHaveBeenCalledOnce();
    expect(authorSignal?.aborted).toBe(true);
  });

  test("does not open the circuit for retryable provider failure", async () => {
    const failure = Object.assign(new Error("temporarily unavailable"), {
      status: 503,
    });
    const reconciler = agents[0];
    const author = agents[1];
    reconciler.invoke.mockRejectedValue(failure);
    author.invoke.mockResolvedValue({
      structuredResponse: {
        markdown: "---\ntype: Reference\n---\n",
        representedClaimIds: [],
      },
    });
    const specialists = createGenerationSpecialists(model, backend);

    await expect(
      specialists.reconcilePage({
        job: pageJob(),
        existingMarkdown: null,
        existingClaims: [],
      }),
    ).rejects.toBe(failure);
    await expect(
      specialists.authorPage({
        job: pageJob(),
        existingMarkdown: null,
        claims: [],
      }),
    ).resolves.toMatchObject({ representedClaimIds: [] });
    expect(author.invoke).toHaveBeenCalledOnce();
  });

  test("keeps cancellation local to its caller instead of opening the circuit", async () => {
    const cancellation = new DOMException("cancelled", "AbortError");
    agents[0].invoke.mockRejectedValue(cancellation);
    agents[1].invoke.mockResolvedValue({
      structuredResponse: {
        markdown: "---\ntype: Reference\n---\n",
        representedClaimIds: [],
      },
    });
    const specialists = createGenerationSpecialists(model, backend);

    await expect(
      specialists.reconcilePage({
        job: pageJob(),
        existingMarkdown: null,
        existingClaims: [],
      }),
    ).rejects.toBe(cancellation);
    await expect(
      specialists.authorPage({
        job: pageJob(),
        existingMarkdown: null,
        claims: [],
      }),
    ).resolves.toMatchObject({ representedClaimIds: [] });
  });

  test("distinguishes transient rate limiting from quota exhaustion", () => {
    expect(isRetryableSpecialistFailure({ status: 429 })).toBe(true);
    expect(
      isRetryableSpecialistFailure({
        status: 429,
        error: { code: "insufficient_quota" },
      }),
    ).toBe(false);
    expect(isCircuitBreakingSpecialistFailure({ status: 429 })).toBe(false);
  });
});

/**
 * Creates the normalized page job used in specialist payloads.
 *
 * @returns Valid page job.
 */
function pageJob() {
  return {
    id: "job_runtime",
    page: "/openwiki/architecture/runtime.md",
    operation: "reconcile" as const,
    reasons: ["source-changed"],
    sourceHints: ["src/runtime.ts"],
    wave: 0,
    priority: 500,
  };
}
