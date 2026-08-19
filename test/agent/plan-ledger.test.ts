import { describe, expect, test } from "vitest";
import {
  createOpenWikiPlanLedgerMiddleware,
  renderPlanMarkdown,
  validatePlan,
} from "../../src/agent/plan-ledger.ts";
import { uncoveredDirectories } from "../../src/agent/repo-inventory.ts";
import { createQaGate } from "../../src/agent/wiki-verification.ts";

const TARGETS = ["/", "/smith-go", "/smith-backend"];

describe("validatePlan", () => {
  test("accepts a ledger covering every surveyed directory", () => {
    expect(
      validatePlan(
        [
          { directory: "/", pages: ["openwiki/workspace.md"] },
          { directory: "/smith-go", pages: ["openwiki/go.md"] },
          {
            directory: "/smith-backend",
            pages: [],
            reason: "Covered by the API pages owned by /smith-go",
          },
        ],
        TARGETS,
      ),
    ).toEqual([]);
  });

  test("rejects a directory nobody planned", () => {
    // A subtree nobody mentions is indistinguishable from one nobody read.
    // "/" is not used here because an entry on the root legitimately covers the
    // whole tree - that is a coarse plan, not an incomplete one.
    expect(
      validatePlan(
        [{ directory: "/smith-go", pages: ["openwiki/go.md"] }],
        TARGETS,
      ).join(" "),
    ).toContain("covered by no entry");
  });

  test("rejects an empty directory with no reason, and an unknown one", () => {
    const problems = validatePlan(
      [
        { directory: "/", pages: [] },
        { directory: "/smith-go", pages: ["openwiki/go.md"] },
        { directory: "/smith-backend", pages: ["openwiki/be.md"] },
        { directory: "/invented", pages: ["openwiki/x.md"] },
      ],
      TARGETS,
    ).join(" ");
    expect(problems).toContain("plans no pages and gives no reason");
    expect(problems).toContain("does not exist: /invented");
  });

  test("rejects two directories claiming one page", () => {
    // Two authors on one page race on write_file and the loser's evidence is
    // gone, so the collision has to fail at plan time.
    expect(
      validatePlan(
        [
          { directory: "/", pages: ["openwiki/shared.md"] },
          { directory: "/smith-go", pages: ["openwiki/shared.md"] },
          { directory: "/smith-backend", pages: [], reason: "none needed" },
        ],
        TARGETS,
      ).join(" "),
    ).toContain("claimed by both");
  });

  test("renders the plan from the ledger rather than the other way round", () => {
    expect(
      renderPlanMarkdown({
        entries: [{ directory: "/smith-go", pages: ["openwiki/go.md"] }],
        plannedPages: ["openwiki/go.md"],
      }),
    ).toContain("| Directory | Pages | Note |");
  });

});

/** Repository with one real directory, a test directory, and a wiki tree. */
function stubBackend(wikiFiles: string[]) {
  const written: Record<string, string> = {};
  return {
    written,
    ls: (dirPath: string) => {
      const clean = dirPath.replace(/\/+$/u, "") || "/";
      if (clean === "/") {
        return Promise.resolve({
          files: [
            { path: "smith-go", is_dir: true },
            { path: "tests", is_dir: true },
            { path: "node_modules", is_dir: true },
            { path: "README.md", is_dir: false },
          ],
        });
      }
      if (clean === "/smith-go") {
        return Promise.resolve({ files: [{ path: "api", is_dir: true }] });
      }
      if (clean === "/openwiki") {
        return Promise.resolve({
          files: wikiFiles.map((path) => ({ path, is_dir: false })),
        });
      }
      return Promise.resolve({ files: [] });
    },
    write: (filePath: string, content: string) => {
      written[filePath] = content;
      return Promise.resolve({});
    },
  };
}

function wire(
  backend: ReturnType<typeof stubBackend>,
  gate?: ReturnType<typeof createQaGate>,
) {
  const middleware = createOpenWikiPlanLedgerMiddleware(backend, gate);
  const tools = Object.fromEntries(
    (
      middleware as {
        tools: { name: string; invoke: (i: unknown) => Promise<unknown> }[];
      }
    ).tools.map((t) => [t.name, t]),
  );
  const call = async (name: string, args: unknown = {}) =>
    JSON.parse(String(await tools[name].invoke(args))) as Record<
      string,
      unknown
    >;
  return { call };
}

describe("partition coverage", () => {
  const TREE = ["/", "/smith-go", "/smith-go/api", "/smith-backend"];

  test("accepts a partition that covers the tree, at any granularity", () => {
    // Whichever granularity fits the repository is fine; only coverage is
    // checked, because granularity is a fact about how it is organised.
    expect(uncoveredDirectories(TREE, ["/"])).toEqual([]);
    expect(
      uncoveredDirectories(TREE, ["/smith-go", "/smith-backend", "/"]),
    ).toEqual([]);
    // Roots may nest: a directory belongs to its deepest covering root.
    expect(
      uncoveredDirectories(TREE, [
        "/",
        "/smith-go",
        "/smith-go/api",
        "/smith-backend",
      ]),
    ).toEqual([]);
  });

  test("names the directories a partition would leave unlooked-at", () => {
    // A subtree nobody surveys is invisible, so an omission has to be a
    // rejection carrying its path rather than a silent gap.
    expect(uncoveredDirectories(TREE, ["/smith-go"])).toEqual([
      "/",
      "/smith-backend",
    ]);
  });

});

describe("submit_plan", () => {
  test("accepts a plan covering every directory and renders the plan file", async () => {
    const backend = stubBackend([]);
    const { call } = wire(backend);
    const out = await call("submit_plan", {
      entries: [
        { directory: "/", pages: ["openwiki/workspace.md"] },
        { directory: "/smith-go", pages: ["openwiki/go/api.md"] },
      ],
    });
    expect(out.accepted).toBe(true);
    expect(out.plannedPages).toBe(2);
    expect(backend.written["/openwiki/_plan.md"]).toContain("| Directory |");
  });

  test("refuses a plan that leaves a directory uncovered", async () => {
    const { call } = wire(stubBackend([]));
    const out = await call("submit_plan", {
      entries: [{ directory: "/smith-go", pages: ["openwiki/go.md"] }],
    });
    expect(out.accepted).toBe(false);
    expect(String(out.problems)).toContain("covered by no entry");
  });

  test("lists the directories a plan must cover", async () => {
    const { call } = wire(stubBackend([]));
    const out = await call("list_repository_directories");
    // tests/ and node_modules/ are excluded as subjects, not as evidence.
    expect(out.tree).toEqual(["/", "/smith-go", "/smith-go/api"]);
  });
});

describe("finalize_wiki", () => {
  test("refuses while a planned page is missing, and passes once written", async () => {
    // The 0.290 trial: 62 planned pages, 33 on disk, reported success.
    const missing = wire(stubBackend([]));
    await missing.call("submit_plan", {
      entries: [{ directory: "/", pages: ["openwiki/a.md"] }],
    });
    const blocked = await missing.call("finalize_wiki");
    expect(blocked.complete).toBe(false);
    expect(String(blocked.problems)).toContain("never written");

    const present = wire(stubBackend(["openwiki/a.md"]));
    await present.call("submit_plan", {
      entries: [{ directory: "/", pages: ["openwiki/a.md"] }],
    });
    expect((await present.call("finalize_wiki")).complete).toBe(true);
  });

  test("refuses completion when no plan exists", async () => {
    const { call } = wire(stubBackend([]));
    const out = await call("finalize_wiki");
    expect(out.complete).toBe(false);
    expect(String(out.problems)).toContain("submit_plan");
  });

  test("blocks on QA only in full mode, never on infrastructure or a spent budget", async () => {
    const finalize = async (gate: ReturnType<typeof createQaGate>) => {
      const { call } = wire(stubBackend(["openwiki/a.md"]), gate);
      await call("submit_plan", {
        entries: [{ directory: "/", pages: ["openwiki/a.md"] }],
      });
      return call("finalize_wiki");
    };

    expect(String((await finalize(createQaGate("full"))).problems)).toContain(
      "verify_wiki",
    );

    const failed = createQaGate("full");
    failed.status = "failed";
    failed.unresolved = ["Q-02"];
    expect(String((await finalize(failed)).problems)).toContain("Q-02");

    const passed = createQaGate("full");
    passed.status = "passed";
    expect((await finalize(passed)).complete).toBe(true);

    // off is a supported control arm, not a mode that cannot finish.
    expect((await finalize(createQaGate("off"))).complete).toBe(true);

    // A run that authored its pages is not thrown away because QA plumbing
    // broke, nor deadlocked by its own spent wave budget.
    const broken = createQaGate("full");
    broken.status = "infrastructure_error";
    expect((await finalize(broken)).complete).toBe(true);

    const spent = createQaGate("full");
    spent.status = "failed";
    spent.unresolved = ["Q-02"];
    spent.wavesRun = 2;
    expect((await finalize(spent)).complete).toBe(true);
  });
});
