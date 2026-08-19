import { describe, expect, test } from "vitest";
import {
  createOpenWikiPlanLedgerMiddleware,
  renderPlanMarkdown,
  validatePlan,
} from "../../src/agent/plan-ledger.ts";
import { createQaGate } from "../../src/agent/wiki-verification.ts";

const UNITS = ["python-package:/svc-a", "go-module:/svc-b", "ci-workflow:/ci"];

describe("validatePlan", () => {
  test("accepts a ledger that dispositions every unit", () => {
    expect(
      validatePlan(
        [
          { unitId: UNITS[0], disposition: "page", page: "a.md" },
          { unitId: UNITS[1], disposition: "page", page: "b.md" },
          {
            unitId: UNITS[2],
            disposition: "excluded",
            reason: "CI config, documented in operations",
          },
        ],
        UNITS,
      ),
    ).toEqual([]);
  });

  test("rejects a unit left without a disposition", () => {
    // The failure this exists for: a plan that silently covers part of the
    // repository reads exactly like one that covers all of it.
    const problems = validatePlan(
      [{ unitId: UNITS[0], disposition: "page", page: "a.md" }],
      UNITS,
    );
    expect(problems.join(" ")).toContain("2 unit(s) have no disposition");
  });

  test("rejects unknown, duplicated, and unexplained entries", () => {
    const problems = validatePlan(
      [
        { unitId: UNITS[0], disposition: "page", page: "a.md" },
        { unitId: UNITS[0], disposition: "page", page: "a.md" },
        { unitId: "invented:/nowhere", disposition: "page", page: "x.md" },
        { unitId: UNITS[1], disposition: "grouped", page: "a.md" },
        { unitId: UNITS[2], disposition: "excluded" },
      ],
      UNITS,
    ).join(" ");
    expect(problems).toContain("Duplicate disposition");
    expect(problems).toContain("Unknown unit");
    expect(problems).toContain("grouped with no reason");
    expect(problems).toContain("excluded with no reason");
  });

  test("renders the plan from the ledger rather than the other way round", () => {
    const markdown = renderPlanMarkdown({
      entries: [{ unitId: UNITS[0], disposition: "page", page: "a.md" }],
      plannedPages: ["a.md"],
    });
    expect(markdown).toContain("| Unit | Disposition | Page | Reason |");
    expect(markdown).toContain(UNITS[0]);
  });
});

/** Backend stub: a repository with two manifests and a wiki tree we control. */
function stubBackend(wikiFiles: string[]) {
  const written: Record<string, string> = {};
  return {
    written,
    ls: (dirPath: string) => {
      const clean = dirPath.replace(/\/+$/u, "") || "/";
      if (clean === "/") {
        return Promise.resolve({
          files: [
            { path: "svc-a", is_dir: true },
            { path: "openwiki", is_dir: true },
          ],
        });
      }
      if (clean === "/svc-a") {
        return Promise.resolve({
          files: [{ path: "svc-a/pyproject.toml", is_dir: false }],
        });
      }
      if (clean === "/openwiki" || clean === "openwiki") {
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

function toolsOf(middleware: unknown) {
  const list = (middleware as { tools: { name: string; invoke: (i: unknown) => Promise<unknown> }[] })
    .tools;
  return Object.fromEntries(list.map((t) => [t.name, t]));
}

describe("finalize_wiki", () => {
  test("refuses to complete while a planned page is missing", async () => {
    // The 0.290 trial: 62 planned pages, 33 on disk, reported success.
    const backend = stubBackend(["openwiki/present.md"]);
    const tools = toolsOf(createOpenWikiPlanLedgerMiddleware(backend));
    const submitted = JSON.parse(
      String(
        await tools.submit_plan.invoke({
          entries: [
            {
              unitId: "python-package:/svc-a",
              disposition: "page",
              page: "openwiki/present.md",
            },
          ],
        }),
      ),
    ) as { accepted: boolean };
    expect(submitted.accepted).toBe(true);
    expect(backend.written["/openwiki/_plan.md"]).toContain("| Unit |");

    const ok = JSON.parse(
      String(await tools.finalize_wiki.invoke({})),
    ) as { complete: boolean };
    expect(ok.complete).toBe(true);

    // Same ledger, a page that never landed.
    const missing = stubBackend([]);
    const tools2 = toolsOf(createOpenWikiPlanLedgerMiddleware(missing));
    await tools2.submit_plan.invoke({
      entries: [
        {
          unitId: "python-package:/svc-a",
          disposition: "page",
          page: "openwiki/present.md",
        },
      ],
    });
    const gated = JSON.parse(
      String(await tools2.finalize_wiki.invoke({})),
    ) as { complete: boolean; problems: string[] };
    expect(gated.complete).toBe(false);
    expect(gated.problems.join(" ")).toContain("never written");
  });

  test("blocks on QA only in full mode, and never on an infrastructure failure", async () => {
    const plan = {
      entries: [
        {
          unitId: "python-package:/svc-a",
          disposition: "page" as const,
          page: "openwiki/present.md",
        },
      ],
    };
    const finalize = async (gate: ReturnType<typeof createQaGate> | undefined) => {
      const tools = toolsOf(
        createOpenWikiPlanLedgerMiddleware(stubBackend(["openwiki/present.md"]), gate),
      );
      await tools.submit_plan.invoke(plan);
      return JSON.parse(String(await tools.finalize_wiki.invoke({}))) as {
        complete: boolean;
        problems: string[];
      };
    };

    const notRun = createQaGate("full");
    expect((await finalize(notRun)).problems.join(" ")).toContain("verify_wiki");

    const failed = createQaGate("full");
    failed.status = "failed";
    failed.unresolved = ["Q-02"];
    expect((await finalize(failed)).problems.join(" ")).toContain("Q-02");

    const passed = createQaGate("full");
    passed.status = "passed";
    expect((await finalize(passed)).complete).toBe(true);

    // off is a supported control arm, not a mode that cannot finish.
    expect((await finalize(createQaGate("off"))).complete).toBe(true);

    // A run that authored its pages is not thrown away because QA plumbing
    // broke: that would burn every token that produced them to learn nothing.
    const broken = createQaGate("full");
    broken.status = "infrastructure_error";
    expect((await finalize(broken)).complete).toBe(true);
  });

  test("refuses completion when no plan was ever accepted", async () => {
    const tools = toolsOf(createOpenWikiPlanLedgerMiddleware(stubBackend([])));
    const result = JSON.parse(
      String(await tools.finalize_wiki.invoke({})),
    ) as { complete: boolean; problems: string[] };
    expect(result.complete).toBe(false);
    expect(result.problems.join(" ")).toContain("submit_plan");
  });
});
