import { describe, expect, test } from "vitest";
import {
  createOpenWikiPlanLedgerMiddleware,
  parseSurvey,
  renderPlanMarkdown,
  validatePlan,
} from "../../src/agent/plan-ledger.ts";
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
    expect(
      validatePlan([{ directory: "/", pages: ["openwiki/a.md"] }], TARGETS).join(
        " ",
      ),
    ).toContain("2 directory(ies) have no plan entry");
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
    expect(problems).toContain("not a survey target: /invented");
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

  test("reads a surveyor's proposed pages out of its text block", () => {
    expect(
      parseSurvey(
        `<survey directory="/smith-go">
           <page path="openwiki/go/api.md"><responsibility>x</responsibility></page>
           <page path="/openwiki/go/worker.md"></page>
           <excluded path="testdata">fixtures</excluded>
         </survey>`,
      ),
    ).toEqual(["openwiki/go/api.md", "openwiki/go/worker.md"]);
    expect(parseSurvey("I could not survey this directory.")).toEqual([]);
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

function wire(backend: ReturnType<typeof stubBackend>, gate?: ReturnType<typeof createQaGate>, respond?: (d: string) => Promise<string>) {
  const middleware = createOpenWikiPlanLedgerMiddleware(backend, gate);
  const tools = Object.fromEntries(
    (middleware as { tools: { name: string; invoke: (i: unknown) => Promise<unknown> }[] }).tools.map(
      (t) => [t.name, t],
    ),
  );
  if (respond) {
    const task = {
      name: "task",
      invoke: (input: unknown) =>
        respond((input as { description: string }).description),
    };
    (middleware as { wrapModelCall: (r: unknown, h: (r: unknown) => unknown) => unknown })
      .wrapModelCall({ tools: [task] }, (r) => r);
  }
  const call = async (name: string, args: unknown = {}) =>
    JSON.parse(String(await tools[name].invoke(args))) as Record<string, unknown>;
  return { call };
}

describe("survey_repository", () => {
  test("surveys every non-test top-level directory and builds the plan", async () => {
    const backend = stubBackend([]);
    const { call } = wire(backend, undefined, (description) =>
      Promise.resolve(
        description.includes("/smith-go")
          ? `<survey><page path="openwiki/go/api.md"/></survey>`
          : `<survey><page path="openwiki/workspace.md"/></survey>`,
      ),
    );
    const out = await call("survey_repository");
    // "/" for the root's own files and "/smith-go"; tests and node_modules are
    // excluded as subjects, not as evidence.
    expect(out.directoriesSurveyed).toBe(2);
    expect(out.plannedPages).toBe(2);
    expect(backend.written["/openwiki/_plan.md"]).toContain("| Directory |");
  });

  test("records a directory whose surveyor proposed nothing", async () => {
    const { call } = wire(stubBackend([]), undefined, () =>
      Promise.resolve("<survey></survey>"),
    );
    const out = await call("survey_repository");
    expect(out.emptyDirectories).toEqual(["/", "/smith-go"]);
  });
});

describe("finalize_wiki", () => {
  test("refuses while a planned page is missing, and passes once written", async () => {
    // The 0.290 trial: 62 planned pages, 33 on disk, reported success.
    const missing = wire(stubBackend([]), undefined, () =>
      Promise.resolve(`<survey><page path="openwiki/a.md"/></survey>`),
    );
    await missing.call("survey_repository");
    const blocked = await missing.call("finalize_wiki");
    expect(blocked.complete).toBe(false);
    expect(String(blocked.problems)).toContain("never written");

    const present = wire(stubBackend(["openwiki/a.md"]), undefined, () =>
      Promise.resolve(`<survey><page path="openwiki/a.md"/></survey>`),
    );
    await present.call("survey_repository");
    expect((await present.call("finalize_wiki")).complete).toBe(true);
  });

  test("refuses completion when no plan exists", async () => {
    const { call } = wire(stubBackend([]));
    const out = await call("finalize_wiki");
    expect(out.complete).toBe(false);
    expect(String(out.problems)).toContain("survey_repository");
  });

  test("blocks on QA only in full mode, never on infrastructure or a spent budget", async () => {
    const finalize = async (gate: ReturnType<typeof createQaGate>) => {
      const { call } = wire(stubBackend(["openwiki/a.md"]), gate, () =>
        Promise.resolve(`<survey><page path="openwiki/a.md"/></survey>`),
      );
      await call("survey_repository");
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
