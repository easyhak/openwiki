import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generationClaimsRequireAttention: vi.fn(),
  pendingList: vi.fn(),
  prepareClaimsRuntime: vi.fn(),
  runGenerationWorkflow: vi.fn(),
}));

vi.mock("../../src/agent/skills.js", () => ({
  syncBundledSkills: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/config/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/env.js")>()),
  loadOpenWikiEnv: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/claims/brains/code/runtime.js", () => ({
  prepareClaimsRuntime: mocks.prepareClaimsRuntime,
}));
vi.mock("../../src/agent/generation/pending-work-store.js", () => ({
  PendingWorkStore: class {
    list() {
      return mocks.pendingList() as Promise<unknown[]>;
    }
  },
}));
vi.mock("../../src/agent/generation/runner.js", () => ({
  generationClaimsRequireAttention: mocks.generationClaimsRequireAttention,
  runGenerationWorkflow: mocks.runGenerationWorkflow,
}));

import { getActiveRun } from "../../src/agent/crash-guard.ts";
import { runOpenWikiAgent } from "../../src/agent/index.ts";
import {
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
} from "../../src/config/constants.ts";

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

describe("generation architecture routing", () => {
  const originalProvider = process.env[OPENWIKI_PROVIDER_ENV_KEY];
  const originalApiKey = process.env[OPENROUTER_API_KEY_ENV_KEY];

  beforeEach(() => {
    process.env[OPENWIKI_PROVIDER_ENV_KEY] = "openrouter";
    process.env[OPENROUTER_API_KEY_ENV_KEY] = "test-key";
    vi.clearAllMocks();
    mocks.generationClaimsRequireAttention.mockResolvedValue(false);
    mocks.pendingList.mockResolvedValue([]);
    mocks.prepareClaimsRuntime.mockResolvedValue(undefined);
    mocks.runGenerationWorkflow.mockResolvedValue(COMPLETE_SUMMARY);
  });

  afterEach(() => {
    if (originalProvider === undefined) {
      delete process.env[OPENWIKI_PROVIDER_ENV_KEY];
    } else {
      process.env[OPENWIKI_PROVIDER_ENV_KEY] = originalProvider;
    }
    if (originalApiKey === undefined) {
      delete process.env[OPENROUTER_API_KEY_ENV_KEY];
    } else {
      process.env[OPENROUTER_API_KEY_ENV_KEY] = originalApiKey;
    }
  });

  test("routes opted-in repository init through the generation workflow", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-routing-"));

    await expect(
      runOpenWikiAgent("init", cwd, {
        outputMode: "repository",
        generationArchitecture: "langgraph",
        threadId: "thread-123",
      }),
    ).resolves.toMatchObject({ command: "init" });

    expect(mocks.prepareClaimsRuntime).not.toHaveBeenCalled();
    expect(mocks.runGenerationWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "init",
        cwd,
        threadId: "thread-123",
      }),
    );
  });

  test.each([false, true])(
    "persists partial graph metadata when contentChanged=%s",
    async (contentChanged) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-routing-"));
      mocks.runGenerationWorkflow.mockImplementation(async () => {
        if (contentChanged) {
          await mkdir(path.join(cwd, "openwiki"), { recursive: true });
          await writeFile(
            path.join(cwd, "openwiki/quickstart.md"),
            "# Quickstart\n",
          );
        }
        return { ...COMPLETE_SUMMARY, status: "partial", pending: 2 };
      });

      await runOpenWikiAgent("init", cwd, {
        outputMode: "repository",
        generationArchitecture: "langgraph",
      });

      const metadata = JSON.parse(
        await readFile(path.join(cwd, "openwiki/.last-update.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(metadata).toMatchObject({
        command: "init",
        status: "partial",
        pendingCount: 2,
      });
    },
  );

  test.each([
    {
      name: "repository chat",
      command: "chat" as const,
      outputMode: "repository" as const,
      architecture: "langgraph" as const,
    },
    {
      name: "personal init",
      command: "init" as const,
      outputMode: "local-wiki" as const,
      architecture: "langgraph" as const,
    },
    {
      name: "legacy repository init",
      command: "init" as const,
      outputMode: "repository" as const,
      architecture: "legacy" as const,
    },
  ])("keeps $name on the legacy preparation path", async (scenario) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-routing-"));
    const sentinel = new Error("legacy preparation reached");
    mocks.prepareClaimsRuntime.mockRejectedValue(sentinel);

    await expect(
      runOpenWikiAgent(scenario.command, cwd, {
        outputMode: scenario.outputMode,
        generationArchitecture: scenario.architecture,
      }),
    ).rejects.toBe(sentinel);

    expect(mocks.prepareClaimsRuntime).toHaveBeenCalledOnce();
    expect(mocks.runGenerationWorkflow).not.toHaveBeenCalled();
  });

  test("stamps cancellation interrupted and clears crash-guard registration", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-routing-"));
    const cancellation = new DOMException("cancelled", "AbortError");
    mocks.runGenerationWorkflow.mockImplementation(() => {
      expect(getActiveRun()).toMatchObject({
        command: "update",
        cwd,
        outputMode: "repository",
      });
      return Promise.reject(cancellation);
    });

    await expect(
      runOpenWikiAgent("update", cwd, {
        outputMode: "repository",
        generationArchitecture: "langgraph",
        userMessage: "refresh the docs",
      }),
    ).rejects.toBe(cancellation);

    expect(getActiveRun()).toBeUndefined();
    const metadata = JSON.parse(
      await readFile(path.join(cwd, "openwiki/.last-update.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      command: "update",
      status: "interrupted",
      pendingCount: 1,
    });
  });
});
