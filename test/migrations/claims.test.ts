import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ClaimsStore } from "../../src/claims/brains/code/store.ts";
import {
  inspectClaimsMigration,
  runClaimsMigration,
  type ClaimsMigrationEvent,
} from "../../src/migrations/claims.ts";

describe("Claims migration", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function createWiki(pages: string[]): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "openwiki-migrate-"));
    roots.push(root);
    await mkdir(path.join(root, "openwiki"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Repository\n", "utf8");
    for (const page of pages) {
      const pagePath = path.join(root, "openwiki", page);
      await mkdir(path.dirname(pagePath), { recursive: true });
      await writeFile(pagePath, `# ${page}\n`, "utf8");
    }
    return root;
  }

  async function persistEmptyReview(root: string, page: string): Promise<void> {
    const store = new ClaimsStore(root);
    await store.writePage(page, {
      schemaVersion: 1,
      pageVersion: await store.hashPage(page),
      claims: [],
    });
  }

  test("detects only eligible pages without sidecars", async () => {
    const root = await createWiki(["alpha.md", "beta.md", "index.md"]);
    await persistEmptyReview(root, "/openwiki/alpha.md");

    await expect(inspectClaimsMigration(root)).resolves.toEqual({
      completedPages: ["/openwiki/alpha.md"],
      pendingPages: ["/openwiki/beta.md"],
      totalPages: 2,
    });
  });

  test("commits successful pages and stops with resumable remaining work", async () => {
    const root = await createWiki(["alpha.md", "beta.md"]);
    const events: ClaimsMigrationEvent[] = [];

    const result = await runClaimsMigration(root, {
      onEvent: (event) => events.push(event),
      runPage: async (cwd, page) => {
        if (page.endsWith("beta.md")) throw new Error("provider unavailable");
        await persistEmptyReview(cwd, page);
        return { claimCount: 0, page, pageUpdated: false };
      },
    });

    expect(result.completed.map(({ page }) => page)).toEqual([
      "/openwiki/alpha.md",
    ]);
    expect(result.failed?.page).toBe("/openwiki/beta.md");
    expect(result.failed?.error.message).toBe("provider unavailable");
    expect(result.remainingPages).toEqual(["/openwiki/beta.md"]);
    expect(events.map(({ type }) => type)).toEqual([
      "page_start",
      "page_complete",
      "page_start",
      "page_error",
    ]);
    await expect(inspectClaimsMigration(root)).resolves.toMatchObject({
      completedPages: ["/openwiki/alpha.md"],
      pendingPages: ["/openwiki/beta.md"],
    });
  });

  test("emits only concrete tool phases as page activity", async () => {
    const root = await createWiki(["alpha.md"]);
    const events: ClaimsMigrationEvent[] = [];

    await runClaimsMigration(root, {
      onEvent: (event) => events.push(event),
      runPage: async (cwd, page, onAgentEvent) => {
        onAgentEvent?.({
          type: "tool_start",
          call: "read_file",
          id: "read-1",
          input: {},
          name: "read_file",
        });
        onAgentEvent?.({ type: "text", text: "I found relevant evidence." });
        onAgentEvent?.({
          type: "tool_end",
          id: "read-1",
          name: "read_file",
          status: "finished",
        });
        onAgentEvent?.({ type: "debug", message: "stream heartbeat" });
        onAgentEvent?.({
          type: "tool_start",
          call: "complete_claims_review",
          id: "review-1",
          input: {},
          name: "complete_claims_review",
        });
        await persistEmptyReview(cwd, page);
        return { claimCount: 0, page, pageUpdated: false };
      },
    });

    expect(
      events
        .filter((event) => event.type === "activity")
        .map(({ message }) => message),
    ).toEqual(["Reading source evidence", "Verifying and saving claims"]);
  });
});
