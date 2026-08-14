import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocolV2 } from "deepagents";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  synchronizeWikiIndexes: vi.fn(),
  translateWikiForGeneration: vi.fn(),
  validateWikiInternalLinks: vi.fn(),
  validateWikiMermaid: vi.fn(),
}));

vi.mock(
  "../../../src/agent/translation-middleware.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../src/agent/translation-middleware.js")
    >()),
    translateWikiForGeneration: mocks.translateWikiForGeneration,
  }),
);
vi.mock("../../../src/mermaid/wiki.js", () => ({
  validateWikiMermaid: mocks.validateWikiMermaid,
}));
vi.mock("../../../src/okf/index-sync.js", () => ({
  synchronizeWikiIndexes: mocks.synchronizeWikiIndexes,
}));
vi.mock("../../../src/agent/wiki-link-validator.js", () => ({
  validateWikiInternalLinks: mocks.validateWikiInternalLinks,
}));

import { runGenerationFinalizers } from "../../../src/agent/generation/finalizers.ts";
import type { ClaimsStore } from "../../../src/claims/brains/code/store.ts";
import type { EvidenceResolver } from "../../../src/claims/core/types.ts";
import type { PendingWorkStore } from "../../../src/agent/generation/pending-work-store.ts";

/**
 * Creates mocked finalizer services with successful empty deterministic passes.
 *
 * @returns Finalizer input and service spies.
 */
function fixture() {
  const claimsStore = {
    deletePage: vi.fn(() => Promise.resolve()),
    discoverPages: vi.fn(() => Promise.resolve<string[]>([])),
    discoverSidecarPages: vi.fn(() => Promise.resolve<string[]>([])),
    hashPage: vi.fn(() => Promise.resolve(`sha256:${"a".repeat(64)}`)),
    loadPage: vi.fn(() => Promise.resolve(null)),
    writePage: vi.fn(() => Promise.resolve()),
  };
  const pending = {
    add: vi.fn(() => Promise.resolve()),
    complete: vi.fn(() => Promise.resolve()),
    completeMany: vi.fn(() => Promise.resolve()),
  };
  const resolver = {
    resolve: vi.fn(() => Promise.resolve(null)),
  };
  const warnings: string[] = [];
  return {
    claimsStore,
    pending,
    resolver,
    warnings,
    input: {
      backend: {} as BackendProtocolV2,
      model: {} as BaseChatModel,
      indexLabels: {
        files: "Files",
        directories: "Directories",
      },
      conceptType: "Concept",
      claimsStore: claimsStore as unknown as ClaimsStore,
      resolver: resolver as unknown as EvidenceResolver,
      pending: pending as unknown as PendingWorkStore,
      onWarning: (message: string) => warnings.push(message),
      onStatus: () => {},
    },
  };
}

describe("runGenerationFinalizers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.synchronizeWikiIndexes.mockResolvedValue(undefined);
    mocks.translateWikiForGeneration.mockResolvedValue({
      mutatedPages: [],
      settledPages: [],
      pendingPages: [],
    });
    mocks.validateWikiInternalLinks.mockResolvedValue({
      filesScanned: 0,
      linksChecked: 0,
      issuesFound: 0,
      stampedFiles: [],
    });
    mocks.validateWikiMermaid.mockResolvedValue({
      filesScanned: 0,
      fencesChecked: 0,
      fencesDegraded: 0,
      repairedFiles: [],
    });
  });

  test("re-seals only exact pages reported as mutated", async () => {
    const { input, claimsStore, resolver } = fixture();
    const changedPage = "/openwiki/changed.md";
    const unrelatedPage = "/openwiki/unrelated.md";
    const evidence = {
      resource: "repo://src/runtime.ts",
      version: "sha256:source",
    };
    input.translation = { target: "fr", source: "en", translateAll: true };
    mocks.translateWikiForGeneration.mockResolvedValue({
      mutatedPages: [changedPage],
      settledPages: [changedPage, unrelatedPage],
      pendingPages: [],
    });
    claimsStore.loadPage.mockImplementation((page: string) =>
      Promise.resolve(
        page === changedPage
          ? {
              schemaVersion: 1 as const,
              pageVersion: `sha256:${"b".repeat(64)}`,
              claims: [
                {
                  id: "claim_runtime",
                  statement: "The runtime owns generation.",
                  evidence: [evidence],
                },
              ],
            }
          : null,
      ),
    );
    resolver.resolve.mockResolvedValue({ evidence, content: "source" });

    await runGenerationFinalizers(input);

    expect(claimsStore.loadPage).toHaveBeenCalledOnce();
    expect(claimsStore.loadPage).toHaveBeenCalledWith(changedPage);
    expect(claimsStore.loadPage).not.toHaveBeenCalledWith(unrelatedPage);
    expect(claimsStore.writePage).toHaveBeenCalledWith(
      changedPage,
      expect.objectContaining({
        pageVersion: `sha256:${"a".repeat(64)}`,
      }),
    );
  });

  test("persists ordinary finalizer failure and continues sibling passes", async () => {
    const { input, pending, warnings } = fixture();
    mocks.validateWikiMermaid.mockRejectedValue(
      new Error("renderer unavailable"),
    );

    await runGenerationFinalizers(input);

    expect(pending.add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "finalizer:mermaid",
        kind: "finalizer",
        reason: "Mermaid validation failed: renderer unavailable",
      }),
    );
    expect(mocks.synchronizeWikiIndexes).toHaveBeenCalledOnce();
    expect(mocks.validateWikiInternalLinks).toHaveBeenCalledOnce();
    expect(warnings).toEqual([
      "OpenWiki Mermaid validation is pending: renderer unavailable",
    ]);
  });

  test("deletes orphan sidecars without touching live pages", async () => {
    const { input, claimsStore } = fixture();
    claimsStore.discoverPages.mockResolvedValue([
      "/openwiki/architecture/runtime.md",
    ]);
    claimsStore.discoverSidecarPages.mockResolvedValue([
      "/openwiki/architecture/runtime.md",
      "/openwiki/removed.md",
    ]);

    await runGenerationFinalizers(input);

    expect(claimsStore.deletePage).toHaveBeenCalledOnce();
    expect(claimsStore.deletePage).toHaveBeenCalledWith("/openwiki/removed.md");
  });
});
