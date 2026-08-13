import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Hoisted DeepAgents graph factory spy.
 */
const createDeepAgent = vi.hoisted(() => vi.fn());

/**
 * Isolated persistent checkpoint root used by chat graph tests.
 */
const checkpointRoot = vi.hoisted(
  () =>
    `${process.env.TMPDIR ?? "/tmp"}/openwiki-claims-agent-checkpoint-${process.pid}`,
);

vi.mock("deepagents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("deepagents")>()),
  createDeepAgent,
}));

vi.mock("../../src/agent/skills.js", () => ({
  syncBundledSkills: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/config/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/env.js")>()),
  openWikiEnvDir: checkpointRoot,
}));

vi.mock("../../src/setup/onboarding.js", () => ({
  readOpenWikiOnboardingConfig: vi.fn(() => Promise.resolve({})),
  readRepositoryWikiInstructions: vi.fn(() => Promise.resolve(undefined)),
}));

import { createOpenWikiAgent } from "../../src/agent/index.ts";
import { ClaimsStore } from "../../src/claims/brains/code/store.ts";

/**
 * Captured subset of the DeepAgents graph configuration.
 */
interface CapturedGraphOptions {
  /**
   * Middleware registered on the graph.
   */
  middleware: Array<{ name?: string }>;

  /**
   * Configured subagent definitions.
   */
  subagents: unknown[];

  /**
   * Explicit tools registered alongside filesystem tools.
   */
  tools: Array<{
    name: string;
    invoke(input: unknown): Promise<unknown>;
  }>;
}

/**
 * Returns the latest graph configuration captured by the factory spy.
 *
 * @returns Captured graph options.
 */
function latestGraphOptions(): CapturedGraphOptions {
  const options: unknown = (createDeepAgent.mock.calls as unknown[][]).at(
    -1,
  )?.[0];
  if (!options) {
    throw new Error("Expected createDeepAgent to be called.");
  }
  return options as CapturedGraphOptions;
}

describe("Claims agent graph integration", () => {
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    createDeepAgent.mockReset();
    createDeepAgent.mockReturnValue({
      invoke: vi.fn(),
      streamEvents: vi.fn(),
    });
  });

  afterEach(async () => {
    await Promise.all(
      [checkpointRoot, ...temporaryDirectories.splice(0)].map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  test.each(["init", "update"] as const)(
    "registers Claims tools and middleware for repository %s",
    async (command) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-claims-agent-"));
      temporaryDirectories.push(cwd);

      await createOpenWikiAgent({
        command,
        cwd,
        model: new FakeListChatModel({ responses: ["done"] }),
        outputMode: "repository",
      });

      const options = latestGraphOptions();
      expect(options.tools.map((tool) => tool.name)).toEqual([
        "delete_file",
        "update_claims",
        "fetch_claims",
      ]);
      expect(options.middleware.map((middleware) => middleware.name)).toContain(
        "OpenWikiClaimsAuthoringMiddleware",
      );
      expect(
        options.middleware.map((middleware) => middleware.name),
      ).not.toContain("OpenWikiClaimsCompletionMiddleware");
      expect(options.subagents).toEqual([]);
    },
  );

  test("reconciles stale persisted claims before creating the agent graph", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-claims-agent-"));
    temporaryDirectories.push(cwd);
    await mkdir(path.join(cwd, "openwiki"), { recursive: true });
    await writeFile(path.join(cwd, "README.md"), "# Current repository\n");
    await writeFile(path.join(cwd, "openwiki/page.md"), "# Page\n");
    const page = "/openwiki/page.md";
    const resource = "repo://README.md";
    const store = new ClaimsStore(cwd);
    await store.writePage(page, {
      schemaVersion: 1,
      pageVersion: await store.hashPage(page),
      claims: [
        {
          id: "claim_readme",
          statement: "The repository has a README.",
          evidence: [{ resource, version: "repo-file-v1:sha256:old" }],
        },
      ],
    });
    const invoke = vi.fn(() =>
      Promise.resolve({
        reconciliations: [
          {
            page,
            claimId: "claim_readme",
            disposition: "reaffirm",
            statement: "The repository has a README.",
            evidence: [{ resource }],
          },
        ],
      }),
    );
    const model = {
      withStructuredOutput: () => ({ invoke }),
    } as unknown as BaseChatModel;

    await createOpenWikiAgent({
      command: "update",
      cwd,
      model,
      outputMode: "repository",
    });

    expect(invoke).toHaveBeenCalledOnce();
    const fetchClaims = latestGraphOptions().tools.find(
      (tool) => tool.name === "fetch_claims",
    );
    if (!fetchClaims) {
      throw new Error("Missing fetch_claims tool.");
    }
    const fetched = JSON.parse(
      String(await fetchClaims.invoke({ pages: [page] })),
    ) as {
      pages: Array<{
        revision: number;
        claims: Array<{ evidence: Array<{ version: string }> }>;
      }>;
    };
    expect(fetched.pages[0]?.revision).toBe(1);
    expect(fetched.pages[0]?.claims[0]?.evidence[0]?.version).not.toContain(
      "old",
    );
  });

  test.each([
    ["chat", "repository"],
    ["init", "local-wiki"],
    ["update", "local-wiki"],
  ] as const)(
    "does not expose Claims for %s in %s mode",
    async (command, outputMode) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "openwiki-claims-agent-"));
      temporaryDirectories.push(cwd);

      await createOpenWikiAgent({
        command,
        cwd,
        model: new FakeListChatModel({ responses: ["done"] }),
        outputMode,
      });

      const options = latestGraphOptions();
      expect(options.tools.map((tool) => tool.name)).not.toContain(
        "update_claims",
      );
      expect(options.tools.map((tool) => tool.name)).not.toContain(
        "fetch_claims",
      );
      expect(options.tools.map((tool) => tool.name)).not.toContain(
        "delete_file",
      );
      expect(
        options.middleware.map((middleware) => middleware.name),
      ).not.toContain("OpenWikiClaimsAuthoringMiddleware");
      expect(
        options.middleware.map((middleware) => middleware.name),
      ).not.toContain("OpenWikiClaimsCompletionMiddleware");
      expect(options.subagents).toEqual([]);
    },
  );
});
