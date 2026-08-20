import { describe, expect, test } from "vitest";
import {
  createOpenWikiPlanLedgerMiddleware,
  normalizeWikiPage,
  renderPlanMarkdown,
  advisoryProblems,
  blockingProblems,
  boundaryLedgerProblems,
  boundaryProblems,
  sourceBelongsToArea,
  validateBoundaryDisposition,
  validateEntry,
  validatePlanShape,
} from "../../src/agent/plan-ledger.ts";
import {
  canonicalWikiPage,
  createPlanStore,
  missingEvidence,
} from "../../src/agent/plan-store.ts";
import { findUncoveredDirectories } from "../../src/agent/repo-inventory.ts";
import { createQaGate } from "../../src/agent/wiki-verification.ts";

const TREE = ["/", "/smith-go", "/smith-backend"];

/** A page carrying every piece of evidence an author needs. */
// The default edge points at the page itself: these tests are not about edge
// semantics, and a self-reference always resolves against the same plan.
const page = (
  path: string,
  edges: { page: string; relationship: string }[] = [
    { page: path, relationship: "self" },
  ],
) => ({
  path,
  responsibility: "Owns the thing",
  entrypoint: "main.go#main",
  sources: ["smith-go/main.go#main"],
  tests: ["smith-go/main_test.go — make test-dir DIR=."],
  edges,
});

describe("plan validation", () => {
  test("rejects one bad entry without discarding the others", () => {
    // Submitting whole plans meant any single error discarded forty pages of
    // evidence, and a coordinator that hit five rejections stopped trying:
    // one run collapsed to a root entry, another deferred 37 of 38 areas to
    // one page and authored three.
    expect(
      validateEntry(
        { disposition: "exclude", directory: "/invented", reason: "no" },
        TREE,
      ).join(" "),
    ).toContain("not a directory list_repository_directories returned");
    expect(
      validateEntry(
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [{ ...page("openwiki/a.md"), tests: [] }],
        },
        TREE,
      ).join(" "),
    ).toContain("missing tests");
    expect(
      validateEntry(
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/a.md")],
        },
        TREE,
      ),
    ).toEqual([]);
  });

  test("the root entry owns its own files, not the whole repository", () => {
    // The root's descendants are every rooted path. Building its prefix by
    // concatenation gave "//", which matched nothing, so the root subtracted
    // none of its children and was told a repository's whole file count.
    const tree = ["/", "/svc", "/lib"];
    const entries = [
      {
        disposition: "document" as const,
        directory: "/",
        pages: [page("openwiki/quickstart.md")],
      },
      {
        disposition: "document" as const,
        directory: "/svc",
        pages: [page("openwiki/svc.md")],
      },
      {
        disposition: "document" as const,
        directory: "/lib",
        pages: [page("openwiki/lib.md")],
      },
    ];
    // 9000 files in the tree, all but 12 of them claimed by /svc and /lib.
    const counts = new Map([
      ["/", 9000],
      ["/svc", 6000],
      ["/lib", 2988],
    ]);
    const problems = validatePlanShape(entries, [], tree, counts).join(" ");
    expect(problems).not.toContain("/ plans");
    // The areas that do own the volume are still asked for their pages.
    expect(problems).toContain("/svc plans 1 page(s) for 6000 source files");
  });

  test("scales the page floor with documentable source, not with nesting", () => {
    const tree = ["/", "/svc", "/svc/a", "/svc/b", "/svc/c", "/svc/d"];
    const onePage = [
      {
        disposition: "document" as const,
        directory: "/svc",
        pages: [page("openwiki/svc.md")],
      },
      { disposition: "exclude" as const, directory: "/", reason: "root files" },
    ];

    // 40 files is under one page's worth, so one page satisfies it however many
    // directories that source is spread across.
    const light = new Map([["/svc", 40]]);
    expect(validatePlanShape(onePage, [], tree, light)).toEqual([]);

    // The identical directory shape holding 600 files needs six.
    const heavy = new Map([["/svc", 600]]);
    expect(validatePlanShape(onePage, [], tree, heavy).join(" ")).toContain(
      "plans 1 page(s) for 600 source files",
    );
    expect(validatePlanShape(onePage, [], tree, heavy).join(" ")).toContain(
      "needs at least 6",
    );

    // And it keeps applying past the second page - two pages is not a discharge.
    const twoPages = [
      {
        disposition: "document" as const,
        directory: "/svc",
        pages: [page("openwiki/svc.md"), page("openwiki/svc-two.md")],
      },
      { disposition: "exclude" as const, directory: "/", reason: "root files" },
    ];
    expect(validatePlanShape(twoPages, [], tree, heavy).join(" ")).toContain(
      "needs at least 6",
    );

    // Volume a deeper entry claims is that entry's problem, not this one's.
    const split = [
      ...twoPages,
      {
        disposition: "document" as const,
        directory: "/svc/a",
        pages: [page("openwiki/svc-a.md")],
      },
    ];
    const owned = new Map([
      ["/svc", 600],
      ["/svc/a", 550],
    ]);
    expect(validatePlanShape(split, [], tree, owned).join(" ")).not.toContain(
      "/svc plans",
    );
  });

  test("refuses one page standing in for a whole subtree", () => {
    // Breadth is what moves the score: 37 pages scored 0.263, 49 scored 0.331,
    // 71 scored 0.404 at identical page density. It collapses when an area
    // holding many directories plans a single page.
    const tree = [
      "/",
      "/big",
      "/big/a",
      "/big/b",
      "/big/c",
      "/big/d",
      "/small",
    ];
    const problems = validatePlanShape(
      [
        {
          disposition: "document",
          directory: "/big",
          pages: [page("openwiki/big.md")],
        },
        { disposition: "exclude", directory: "/small", reason: "fixtures" },
        { disposition: "exclude", directory: "/", reason: "root files" },
      ],
      [],
      tree,
      new Map([["/big", 400]]),
    ).join(" ");
    expect(problems).toContain("plans 1 page(s) for 400 source files");

    // A deeper entry claiming them is the other way to satisfy it.
    expect(
      validatePlanShape(
        [
          {
            disposition: "document",
            directory: "/big",
            pages: [page("openwiki/big.md")],
          },
          {
            disposition: "document",
            directory: "/big/a",
            pages: [page("openwiki/big-a.md")],
          },
          { disposition: "exclude", directory: "/big/b", reason: "fixtures" },
          { disposition: "exclude", directory: "/big/c", reason: "fixtures" },
          { disposition: "exclude", directory: "/big/d", reason: "fixtures" },
          { disposition: "exclude", directory: "/small", reason: "fixtures" },
          { disposition: "exclude", directory: "/", reason: "root files" },
        ],
        [],
        tree,
      ).join(" "),
    ).not.toContain("needs at least 2");
  });

  test("refuses a plan that defers most of the repository", () => {
    // Every cheap legal shape got used in turn; naming an area is not
    // documenting it.
    const many = Array.from({ length: 12 }, (_, i) => ({
      disposition: "covered_by" as const,
      directory: `/d${i}`,
      page: "openwiki/one.md",
      reason: "documented there",
    }));
    const problems = validatePlanShape(
      [
        {
          disposition: "document",
          directory: "/",
          pages: [page("openwiki/one.md")],
        },
        ...many,
      ],
      [],
    ).join(" ");
    expect(problems).toContain("of 13 areas are documented");
    expect(problems).toContain("cannot document that many");
  });

  test("accepts the three dispositions as peers", () => {
    expect(
      validatePlanShape(
        [
          {
            disposition: "document",
            directory: "/",
            pages: [page("openwiki/workspace.md")],
          },
          {
            disposition: "document",
            directory: "/smith-go",
            pages: [page("openwiki/go.md")],
          },
          {
            disposition: "covered_by",
            directory: "/smith-backend",
            page: "openwiki/go.md",
            reason: "Its API is documented on the Go page",
          },
        ],
        [],
      ),
    ).toEqual([]);
  });

  test("accepts an exclusion as a normal outcome", () => {
    // Not documenting a directory is a first-class answer. Making it awkward is
    // how a run ended up planning pages for /secrets.example and /test_data.
    expect(
      validatePlanShape(
        [
          {
            disposition: "document",
            directory: "/",
            pages: [page("openwiki/a.md")],
          },
          {
            disposition: "exclude",
            directory: "/smith-go",
            reason: "Fixtures only",
          },
          {
            disposition: "exclude",
            directory: "/smith-backend",
            reason: "Generated output",
          },
        ],
        [],
      ),
    ).toEqual([]);
  });

  test("rejects covered_by pointing at a page nothing documents", () => {
    // Otherwise covered_by is an exclusion wearing a more reassuring word.
    expect(
      validatePlanShape(
        [
          {
            disposition: "document",
            directory: "/",
            pages: [page("openwiki/a.md")],
          },
          {
            disposition: "covered_by",
            directory: "/smith-go",
            page: "openwiki/ghost.md",
            reason: "documented there",
          },
          {
            disposition: "exclude",
            directory: "/smith-backend",
            reason: "fixtures",
          },
        ],
        [],
      ).join(" "),
    ).toContain("which no entry documents");
  });

  test("rejects a directory nobody planned, and one that does not exist", () => {
    const problems = validatePlanShape(
      [
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/go.md")],
        },
        {
          disposition: "exclude",
          directory: "/invented",
          reason: "nope",
        },
      ],
      ["/", "/smith-backend"],
    ).join(" ");
    // The unknown-directory check is per entry now, so it is asserted there.
    expect(problems).toContain("covered by no entry");
  });

  test("rejects two entries owning one page, normalizing the prefix", () => {
    // The two spellings are one page, and two authors on it race on write_file.
    expect(
      validatePlanShape(
        [
          {
            disposition: "document",
            directory: "/",
            pages: [page("shared.md")],
          },
          {
            disposition: "document",
            directory: "/smith-go",
            pages: [page("openwiki/shared.md")],
          },
          {
            disposition: "exclude",
            directory: "/smith-backend",
            reason: "fixtures",
          },
        ],
        [],
      ).join(" "),
    ).toContain("owned by both");
  });

  test("renders the disposition and its counts", () => {
    const markdown = renderPlanMarkdown([
      {
        disposition: "document",
        directory: "/smith-go",
        pages: [page("openwiki/go.md")],
      },
      {
        disposition: "exclude",
        directory: "/test_data",
        reason: "Test fixtures",
      },
    ]);
    expect(markdown).toContain(
      "| Page | Responsibility | Entrypoint | Tests | Relates to |",
    );
    expect(markdown).toContain("1 documented, 0 covered elsewhere, 1 excluded");
  });

  test("rejects a page with no anchor, entrypoint, or focused test", () => {
    // An author sent without these writes what it can see, and what it cannot
    // see is what the grader asks for: boundary is absent 64% of the time and
    // validation 57%, and neither is derivable from the author's own subtree.
    expect(
      missingEvidence({
        path: "openwiki/a.md",
        responsibility: "",
        entrypoint: "",
        sources: [],
        tests: [],
        edges: [],
      }),
    ).toEqual([
      "sources",
      "entrypoint",
      "tests",
      "responsibility",
      "at least one edge - what this depends on, or what depends on it",
    ]);
    expect(missingEvidence(page("openwiki/a.md"))).toEqual([]);
  });

  test("rejects an edge to a page nothing documents", () => {
    // Otherwise the author is told to link somewhere that will never exist.
    expect(
      validatePlanShape(
        [
          {
            disposition: "document",
            directory: "/",
            pages: [
              page("openwiki/a.md", [
                { page: "openwiki/ghost.md", relationship: "calls it" },
              ]),
            ],
          },
          {
            disposition: "exclude",
            directory: "/smith-go",
            reason: "fixtures",
          },
          {
            disposition: "exclude",
            directory: "/smith-backend",
            reason: "fixtures",
          },
        ],
        [],
      ).join(" "),
    ).toContain("edge to openwiki/ghost.md, which no entry documents");
  });

  test("collapses every spelling of a page to one canonical path", () => {
    // These four were all in one run, and each boundary normalized differently
    // or not at all: the plan stored the extensionless form, the brief told the
    // author to write the .md file, and a count read on the un-suffixed path
    // threw and discarded a completed pool of 57 authors.
    for (const spelling of [
      "architecture/overview",
      "architecture/overview.md",
      "openwiki/architecture/overview.md",
      "/openwiki/architecture/overview.md",
    ]) {
      expect(canonicalWikiPage(spelling)).toBe(
        "/openwiki/architecture/overview.md",
      );
    }
  });

  test("normalizes a page path to one wiki-root prefix", () => {
    // The bug this prevents: the plan said architecture/overview.md, the disk
    // walk said openwiki/architecture/overview.md, nothing matched, and a run
    // that had written 72 pages was told all 70 planned ones were missing.
    expect(normalizeWikiPage("architecture/overview.md")).toBe(
      "openwiki/architecture/overview.md",
    );
    expect(normalizeWikiPage("/openwiki/architecture/overview.md")).toBe(
      "openwiki/architecture/overview.md",
    );
    expect(normalizeWikiPage("openwiki/a.md")).toBe("openwiki/a.md");
  });
});

describe("coverage walk", () => {
  // A repository nested deeper than any display bound, to prove the check is
  // not limited by one: /deep/a/b/c/svc sits at depth 5.
  const nested = {
    ls: (dirPath: string) => {
      const clean = dirPath.replace(/\/+$/u, "") || "/";
      const tree: Record<string, string[]> = {
        "/": ["deep", "flat", "tests"],
        "/deep": ["a"],
        "/deep/a": ["b"],
        "/deep/a/b": ["c"],
        "/deep/a/b/c": ["svc"],
        "/deep/a/b/c/svc": [],
        "/flat": [],
      };
      return Promise.resolve({
        files: (tree[clean] ?? []).map((name) => ({
          path: clean === "/" ? name : `${clean}/${name}`,
          is_dir: true,
        })),
      });
    },
  };

  test("an entry covers everything beneath it, at any depth", async () => {
    // /deep covers /deep/a/b/c/svc without naming it, which is why depth costs
    // the plan nothing: coverage is inherited.
    expect(
      await findUncoveredDirectories(nested, ["/", "/deep", "/flat"]),
    ).toEqual([]);
  });

  test("an entry on the root covers only the root's own files", async () => {
    // It used to cover everything, which made the guarantee vacuous: a plan of
    // one root entry passed coverage on 964 directories and scored 0.230.
    expect(await findUncoveredDirectories(nested, ["/"])).toEqual([
      "/deep",
      "/flat",
    ]);
  });

  test("reports the highest uncovered directory, not its children", async () => {
    // One missed subtree should read as one problem.
    expect(await findUncoveredDirectories(nested, ["/flat"])).toEqual([
      "/",
      "/deep",
    ]);
  });

  test("still descends into a subtree that was partitioned", async () => {
    // /deep is covered, but a deeper entry means it was split, so something
    // inside it can still have been missed - here /deep/a/b.
    expect(
      await findUncoveredDirectories(nested, [
        "/",
        "/deep",
        "/deep/a/b/c",
        "/flat",
      ]),
    ).toEqual([]);
  });

  test("the root's own files need an entry of their own", async () => {
    // Nothing but "/" covers them, so omitting it is a real gap.
    expect(await findUncoveredDirectories(nested, ["/deep", "/flat"])).toEqual([
      "/",
    ]);
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
        return Promise.resolve({
          files: [{ path: "smith-go/api", is_dir: true }],
        });
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
  const middleware = createOpenWikiPlanLedgerMiddleware(
    backend,
    createPlanStore(),
    gate,
  );
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

describe("submit_plan", () => {
  test("accepts a plan covering every directory and renders the plan file", async () => {
    const backend = stubBackend([]);
    const { call } = wire(backend);
    const out = await call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/",
          pages: [page("openwiki/workspace.md")],
        },
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/go/api.md")],
        },
      ],
    });
    expect(out.accepted).toBe(true);
    expect(out.plannedPages).toBe(2);
    expect(backend.written["/openwiki/_plan.md"]).toContain("| Page |");
  });

  test("records a partial plan and says what still blocks authoring", async () => {
    // Coverage is no longer a rejection: the plan is built up over calls, so an
    // incomplete plan is one in progress rather than one thrown away.
    const { call } = wire(stubBackend([]));
    const out = await call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/go.md")],
        },
      ],
    });
    expect(out.accepted).toBe(true);
    expect(out.recorded).toBe(1);
    // Named for what it costs: this class stops authoring, the shortfall class does not.
    expect(String(out.blocking)).toContain("covered by no entry");
  });

  test("lists the directories a plan must cover", async () => {
    const { call } = wire(stubBackend([]));
    const out = await call("list_repository_directories");
    // tests/ and node_modules/ are excluded as subjects, not as evidence.
    expect(out.tree).toEqual(["/", "/smith-go", "/smith-go/api"]);
  });

  test("rejects a boundary disposition no survey supports, and keeps the entries", async () => {
    const { call } = wire(stubBackend([]));
    const out = await call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/go.md")],
        },
      ],
      boundaries: [
        {
          boundary: "invented",
          claims: ["/smith-go#nothing"],
          disposition: "exclude",
          reason: "No repository evidence supports this proposed relationship.",
        },
      ],
    });
    expect(out.accepted).toBe(false);
    expect(String(out.rejectedBoundaries)).toContain(
      "which no area survey claims",
    );
    // The entry in the same call is still recorded: one bad boundary is not a
    // reason to discard the evidence beside it.
    expect(out.recorded).toBe(1);
  });

  test("surveys and boundaries accumulate across calls until nothing is open", async () => {
    const { call } = wire(stubBackend([]));
    const claim = (counterparty: string, direction: string) => ({
      status: "reviewed",
      inspected: ["smith-go/store/pg.go"],
      boundaries: [
        {
          id: "sessions-write",
          direction,
          counterparty,
          relationship: "writes session rows the other side also writes",
          mechanism: "direct INSERT into public.sessions",
          sources: ["smith-go/store/pg.go#InsertSession"],
          tests: ["smith-go/store/pg_test.go - make test-dir DIR=store"],
        },
      ],
    });

    // The first call has one end of the relationship, so the ledger blocks on
    // the side nobody has surveyed yet rather than accepting a one-sided fact.
    const first = await call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/",
          pages: [page("openwiki/workspace.md")],
          survey: claim("/smith-go", "outbound"),
        },
      ],
    });
    expect(first.accepted).toBe(true);
    expect(first.boundaryClaims).toBe(1);
    // Reciprocity advises: one area cannot satisfy it alone, so it must not hold
    // up claims another entry recorded correctly.
    expect(String(first.shortfall)).toContain("records no inbound claim");

    const second = await call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/go.md")],
          survey: claim("/", "inbound"),
        },
      ],
      boundaries: [
        {
          boundary: "session-ownership",
          claims: ["/#sessions-write", "/smith-go#sessions-write"],
          disposition: "exclude",
          reason:
            "One migration run at install writes every row in this table.",
        },
      ],
    });
    expect(second.accepted).toBe(true);
    expect(second.recorded).toBe(2);
    expect(second.boundariesRecorded).toBe(1);
    expect(second.blocking).toBeUndefined();
  });

  test("a boundary page joins the plan's pages and the rendered plan", async () => {
    const backend = stubBackend([]);
    const { call } = wire(backend);
    const out = await call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/",
          pages: [page("openwiki/workspace.md")],
          survey: {
            status: "no_boundaries",
            inspected: ["README.md"],
            reason: "Root holds only the workspace manifest and this README.",
            boundaries: [],
          },
        },
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/go.md")],
          survey: {
            status: "reviewed",
            inspected: ["smith-go/store/pg.go"],
            boundaries: [
              {
                id: "stripe-webhook",
                direction: "inbound",
                counterparty: "external:stripe",
                relationship: "receives payment events from the vendor",
                mechanism: "POST /webhooks/stripe",
                sources: ["smith-go/api/webhooks.go#Stripe"],
                tests: [
                  "smith-go/api/webhooks_test.go - make test-dir DIR=api",
                ],
              },
            ],
          },
        },
      ],
      boundaries: [
        {
          boundary: "stripe-webhook",
          claims: ["/smith-go#stripe-webhook"],
          disposition: "document",
          page: {
            path: "openwiki/boundaries/stripe.md",
            responsibility: "smith-go owns verification; Stripe owns retries",
            entrypoint: "smith-go/api/webhooks.go#Stripe",
            sources: ["smith-go/api/webhooks.go#Stripe"],
            tests: ["smith-go/api/webhooks_test.go - make test-dir DIR=api"],
            edges: [{ page: "openwiki/go.md", relationship: "delivers into" }],
          },
        },
      ],
    });
    expect(out.accepted).toBe(true);
    expect(out.blocking).toBeUndefined();
    // Boundary pages are dispatched by the same pool and checked by the same
    // completion gate, so they are in the same page map.
    expect(out.plannedPages).toBe(3);
    const plan = backend.written["/openwiki/_plan.md"];
    expect(plan).toContain("## Area boundary surveys");
    expect(plan).toContain("## Boundary claims");
    expect(plan).toContain("openwiki/boundaries/stripe.md");
  });

  test("list_unresolved_boundaries reads the ledger back without recording", async () => {
    const { call } = wire(stubBackend([]));
    await call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/go.md")],
        },
      ],
    });
    const out = await call("list_unresolved_boundaries");
    expect(out.areasRecorded).toBe(1);
    expect(out.areasSurveyed).toBe(0);
    expect(String(out.problems)).toContain("has no boundary survey");
    expect((await call("list_unresolved_boundaries")).areasRecorded).toBe(1);
  });
});

describe("finalize_wiki", () => {
  test("refuses while a planned page is missing, and passes once written", async () => {
    // The 0.290 trial: 62 planned pages, 33 on disk, reported success.
    const missing = wire(stubBackend([]));
    await missing.call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/",
          pages: [page("openwiki/a.md")],
        },
        { disposition: "exclude", directory: "/smith-go", reason: "fixtures" },
      ],
    });
    const blocked = await missing.call("finalize_wiki");
    expect(blocked.complete).toBe(false);
    expect(String(blocked.problems)).toContain("never written");

    const present = wire(stubBackend(["openwiki/a.md"]));
    await present.call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/",
          pages: [page("openwiki/a.md")],
        },
        { disposition: "exclude", directory: "/smith-go", reason: "fixtures" },
      ],
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
        entries: [
          {
            disposition: "document",
            directory: "/",
            pages: [page("openwiki/a.md")],
          },
          {
            disposition: "exclude",
            directory: "/smith-go",
            reason: "fixtures",
          },
        ],
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

describe("submit_plan schema failures", () => {
  test("names the path and the nesting mistake instead of throwing", async () => {
    // The failure that froze a plan at 19 pages: an entry object nested inside
    // another entry's pages array, three times, each answered only with
    // "Error invoking tool submit_plan with kwargs {...}".
    const { call } = wire(stubBackend([]));
    const out = await call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/",
          pages: [
            {
              path: "openwiki/a.md",
              responsibility: "r",
              entrypoint: "e",
              sources: ["s"],
              tests: ["t"],
              edges: [],
            },
            { disposition: "document", directory: "/smith-go", pages: [] },
          ],
        },
      ],
    });
    expect(out.accepted).toBe(false);
    const problems = (out.problems as string[]).join(" ");
    expect(problems).toContain("entries.0.pages.1");
    expect(problems).toContain("looks like an entry rather than a page");
  });

  test("reports a missing field by its path", async () => {
    const { call } = wire(stubBackend([]));
    const out = await call("submit_plan", {
      entries: [
        {
          disposition: "document",
          directory: "/",
          pages: [{ path: "openwiki/a.md", responsibility: "r" }],
        },
      ],
    });
    expect(out.accepted).toBe(false);
    expect((out.problems as string[]).join(" ")).toContain("entries.0.pages.0");
  });
});

describe("area boundary surveys", () => {
  /** A survey with one claim pointing at another recorded area. */
  const survey = (
    counterparty: string,
    direction: "inbound" | "outbound" | "shared" = "outbound",
    id = "sessions-write",
  ) => ({
    status: "reviewed" as const,
    inspected: ["smith-go/store/pg.go"],
    boundaries: [
      {
        id,
        direction,
        counterparty,
        relationship: "writes session rows the other side also writes",
        mechanism: "direct INSERT into public.sessions",
        sources: ["smith-go/store/pg.go#InsertSession"],
        tests: ["smith-go/store/pg_test.go - make test-dir DIR=store"],
      },
    ],
  });

  /** The two ends of one internal relationship, each surveyed by its own area. */
  const twoSided = (): Parameters<typeof boundaryLedgerProblems>[0] => [
    {
      disposition: "document",
      directory: "/smith-go",
      pages: [page("openwiki/go.md")],
      survey: survey("/smith-backend", "outbound"),
    },
    {
      disposition: "document",
      directory: "/smith-backend",
      pages: [page("openwiki/backend.md")],
      survey: survey("/smith-go", "inbound"),
    },
  ];

  const both = ["/smith-go#sessions-write", "/smith-backend#sessions-write"];

  test("an area the plan keeps but never surveyed blocks", () => {
    // The survey is the evidence the area was read for what leaves it. Without
    // one, an area with no claims and an area nobody looked at are the same
    // record.
    const problems = boundaryLedgerProblems(
      [
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/go.md")],
        },
      ],
      [],
    );
    expect(problems.join(" ")).toContain("has no boundary survey");
  });

  test("an excluded area needs no survey", () => {
    expect(
      boundaryLedgerProblems(
        [
          {
            disposition: "exclude",
            directory: "/test_data",
            reason: "fixtures",
          },
        ],
        [],
      ),
    ).toEqual([]);
  });

  test("no_boundaries is a complete answer", () => {
    expect(
      boundaryLedgerProblems(
        [
          {
            disposition: "document",
            directory: "/smith-go",
            pages: [page("openwiki/go.md")],
            survey: {
              status: "no_boundaries",
              inspected: ["docs/adr/0001.md"],
              reason:
                "Prose only: nothing here is imported, called, or deployed.",
              boundaries: [],
            },
          },
        ],
        [],
      ),
    ).toEqual([]);
  });

  test("an internal claim the counterparty never reported blocks", () => {
    // One area seeing a boundary the other does not is the signature of a
    // guess, and it is the failure the heuristic discovery this replaced could
    // not distinguish from a fact.
    const oneSided: Parameters<typeof boundaryLedgerProblems>[0] = [
      twoSided()[0],
      {
        disposition: "document",
        directory: "/smith-backend",
        pages: [page("openwiki/backend.md")],
        survey: {
          status: "no_boundaries",
          inspected: ["smith-backend/app.py"],
          reason:
            "Nothing here is imported, called, or deployed by another area.",
          boundaries: [],
        },
      },
    ];
    expect(boundaryLedgerProblems(oneSided, []).join(" ")).toContain(
      "records no inbound claim back to /smith-go",
    );
  });

  test("shared pairs with shared, and a mismatched direction is one-sided", () => {
    const entries = twoSided();
    entries[0] = { ...entries[0], survey: survey("/smith-backend", "shared") };
    expect(boundaryLedgerProblems(entries, []).join(" ")).toContain(
      "no shared claim back",
    );
  });

  test("an external counterparty needs no reciprocal", () => {
    const problems = boundaryLedgerProblems(
      [
        {
          disposition: "document",
          directory: "/smith-go",
          pages: [page("openwiki/go.md")],
          survey: survey("external:stripe"),
        },
      ],
      [
        {
          boundary: "billing",
          claims: ["/smith-go#sessions-write"],
          disposition: "exclude",
          reason: "The vendor documents its own side of this webhook contract.",
        },
      ],
    );
    expect(problems).toEqual([]);
  });

  test("a counterparty no entry records, and an area claiming itself, both block", () => {
    expect(
      boundaryLedgerProblems(
        [
          {
            disposition: "document",
            directory: "/smith-go",
            pages: [page("openwiki/go.md")],
            survey: survey("/invented"),
          },
        ],
        [],
      ).join(" "),
    ).toContain("not an area the plan documents or covers");
    expect(
      boundaryLedgerProblems(
        [
          {
            disposition: "document",
            directory: "/smith-go",
            pages: [page("openwiki/go.md")],
            survey: survey("/smith-go"),
          },
        ],
        [],
      ).join(" "),
    ).toContain("names its own area as the counterparty");
  });

  test("a claim with no disposition blocks, and one disposition clears both sides", () => {
    const entries = twoSided();
    expect(boundaryLedgerProblems(entries, []).join(" ")).toContain(
      "has no disposition",
    );
    expect(
      boundaryLedgerProblems(entries, [
        {
          boundary: "session-ownership",
          claims: both,
          disposition: "exclude",
          reason: "Both writes go through one migration that runs at install.",
        },
      ]),
    ).toEqual([]);
  });

  test("the two sides of one relationship cannot sit in different boundaries", () => {
    const problems = boundaryLedgerProblems(twoSided(), [
      {
        boundary: "go-side",
        claims: ["/smith-go#sessions-write"],
        disposition: "exclude",
        reason: "A migration that runs once at install writes these rows.",
      },
      {
        boundary: "python-side",
        claims: ["/smith-backend#sessions-write"],
        disposition: "exclude",
        reason: "A migration that runs once at install writes these rows.",
      },
    ]);
    expect(problems.join(" ")).toContain("different boundaries");
  });

  test("a claim disposed of twice, and a disposition of a claim nobody made", () => {
    const twice = boundaryLedgerProblems(twoSided(), [
      {
        boundary: "one",
        claims: both,
        disposition: "exclude",
        reason: "A migration that runs once at install writes these rows.",
      },
      {
        boundary: "two",
        claims: both,
        disposition: "exclude",
        reason: "A migration that runs once at install writes these rows.",
      },
    ]);
    expect(twice.join(" ")).toContain("exactly one disposition");

    const invented = boundaryLedgerProblems(twoSided(), [
      {
        boundary: "one",
        claims: [...both, "/smith-go#invented"],
        disposition: "exclude",
        reason: "A migration that runs once at install writes these rows.",
      },
    ]);
    expect(invented.join(" ")).toContain("which no area survey claims");
  });

  test("duplicate claim ids inside one survey block", () => {
    const entries = twoSided();
    const first = entries[0];
    if (first.disposition !== "document" || !first.survey) {
      throw new Error("fixture");
    }
    entries[0] = {
      ...first,
      survey: {
        ...first.survey,
        boundaries: [first.survey.boundaries[0], first.survey.boundaries[0]],
      },
    };
    expect(boundaryLedgerProblems(entries, []).join(" ")).toContain(
      "unique within its survey",
    );
  });
});

describe("boundary dispositions", () => {
  const claims = new Map([
    [
      "/smith-go#sessions-write",
      {
        area: "/smith-go",
        claim: {
          id: "sessions-write",
          direction: "outbound" as const,
          counterparty: "/smith-backend",
          relationship: "writes session rows the Python API also writes",
          mechanism: "direct INSERT into public.sessions",
          sources: ["smith-go/store/pg.go#InsertSession"],
          tests: ["smith-go/store/pg_test.go - make test-dir DIR=store"],
        },
      },
    ],
  ]);

  const boundaryPage = (
    sources: string[],
    edges = [
      {
        page: "openwiki/boundaries/sessions.md",
        relationship: "documents both sides of this relationship",
      },
    ],
  ) => ({
    path: "openwiki/boundaries/sessions.md",
    responsibility: "smith-go is authoritative; smith-backend backfills",
    entrypoint: "smith-go/store/pg.go#InsertSession",
    sources,
    tests: ["smith-backend/tests/test_sessions.py - pytest"],
    edges,
  });

  test("rejects a disposition of a claim no survey made", () => {
    // Otherwise a plan clears its boundary report by naming relationships
    // nothing observed, which is the guessed-contract failure with a new name.
    const problems = validateBoundaryDisposition(
      {
        boundary: "sessions",
        claims: ["/smith-go#invented"],
        disposition: "document",
        page: boundaryPage(["smith-go/store/pg.go#InsertSession"]),
      },
      claims,
    );
    expect(problems.join(" ")).toContain("which no area survey claims");
  });

  test("rejects a boundary page anchored on one side", () => {
    const problems = validateBoundaryDisposition(
      {
        boundary: "sessions",
        claims: ["/smith-go#sessions-write"],
        disposition: "document",
        page: boundaryPage([
          "smith-go/store/pg.go#InsertSession",
          "smith-go/model.go#Session",
        ]),
      },
      claims,
    );
    expect(problems.join(" ")).toContain("cites no source in /smith-backend");
  });

  test("accepts a boundary page citing both participants", () => {
    expect(
      validateBoundaryDisposition(
        {
          boundary: "sessions",
          claims: ["/smith-go#sessions-write"],
          disposition: "document",
          page: boundaryPage([
            "smith-go/store/pg.go#InsertSession",
            "smith-backend/store.py#insert_session",
          ]),
        },
        claims,
      ),
    ).toEqual([]);
  });

  test("rejects a boundary page missing evidence authoring requires", () => {
    const problems = validateBoundaryDisposition(
      {
        boundary: "sessions",
        claims: ["/smith-go#sessions-write"],
        disposition: "document",
        page: boundaryPage(
          [
            "smith-go/store/pg.go#InsertSession",
            "smith-backend/store.py#insert_session",
          ],
          [],
        ),
      },
      claims,
    );
    expect(problems.join(" ")).toContain("missing at least one edge");
  });

  test("rejects a repeated claim reference", () => {
    const problems = validateBoundaryDisposition(
      {
        boundary: "sessions",
        claims: ["/smith-go#sessions-write", "/smith-go#sessions-write"],
        disposition: "exclude",
        reason: "A migration that runs once at install writes these rows.",
      },
      claims,
    );
    expect(problems.join(" ")).toContain("twice");
  });

  test("accepts an evidenced exclusion, and one page that covers it", () => {
    expect(
      validateBoundaryDisposition(
        {
          boundary: "sessions",
          claims: ["/smith-go#sessions-write"],
          disposition: "exclude",
          reason: "smith-backend writes it only in a migration run at install",
        },
        claims,
      ),
    ).toEqual([]);
    expect(
      validateBoundaryDisposition(
        {
          boundary: "sessions",
          claims: ["/smith-go#sessions-write"],
          disposition: "covered_by",
          page: "openwiki/data/postgres.md",
          reason: "The Postgres page states who owns each table it holds.",
        },
        claims,
      ),
    ).toEqual([]);
  });

  test("the root area owns its own files, not the whole tree", () => {
    // "/" as a prefix would let any source in the repository anchor the root,
    // so a boundary page could claim both participants while citing one.
    expect(sourceBelongsToArea("README.md", "/")).toBe(true);
    expect(sourceBelongsToArea("smith-go/store/pg.go#Insert", "/")).toBe(false);
    expect(sourceBelongsToArea("/smith-go/store/pg.go", "/smith-go")).toBe(
      true,
    );
    expect(sourceBelongsToArea("smith-gopher/x.go", "/smith-go")).toBe(false);
  });

  test("boundary pages are checked for duplicate ownership and dangling edges", () => {
    const entries: Parameters<typeof blockingProblems>[0] = [
      {
        disposition: "document",
        directory: "/smith-go",
        pages: [page("openwiki/boundaries/sessions.md")],
      },
    ];
    const duplicate = {
      boundary: "sessions",
      claims: ["/smith-go#sessions-write"],
      disposition: "document" as const,
      page: boundaryPage([
        "smith-go/store/pg.go#InsertSession",
        "smith-backend/store.py#insert_session",
      ]),
    };
    expect(blockingProblems(entries, [], [duplicate]).join(" ")).toContain(
      "owned by both",
    );

    const dangling = {
      ...duplicate,
      page: boundaryPage(
        ["smith-go/store/pg.go#InsertSession"],
        [{ page: "openwiki/missing.md", relationship: "calls" }],
      ),
    };
    expect(blockingProblems([], [], [dangling]).join(" ")).toContain(
      "which no entry documents",
    );
  });
});

describe("boundary pairing and missing tests", () => {
  const claim = (
    id: string,
    direction: "inbound" | "outbound",
    counterparty: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    direction,
    counterparty,
    relationship: "writes rows the other side also writes",
    mechanism: "direct SQL insert",
    sources: ["a/x.go#Insert"],
    tests: ["a/x_test.go - go test ./..."],
    ...extra,
  });

  const area = (directory: string, boundaries: unknown[]) => ({
    disposition: "document" as const,
    directory,
    pages: [],
    survey: {
      status: "reviewed" as const,
      inspected: [`${directory.slice(1)}/store`],
      boundaries,
    },
  });

  test("a second claim between one pair in one direction is matched by id", () => {
    // Keyed by (area, counterparty, direction), the second claim overwrote the
    // first: an unmirrored claim passed on another claim's mate, and two
    // unrelated relationships were told to share a boundary.
    const entries = [
      area("/api-go", [
        claim("sessions-write", "outbound", "/api-py"),
        claim("runs-write", "outbound", "/api-py"),
      ]),
      area("/api-py", [claim("sessions-write", "inbound", "/api-go")]),
    ];
    const { structural, reciprocity } = boundaryProblems(entries as never, [
      {
        boundary: "sessions",
        claims: ["/api-go#sessions-write", "/api-py#sessions-write"],
        disposition: "exclude" as const,
        reason: "already documented on the shared persistence page",
      },
      {
        boundary: "runs",
        claims: ["/api-go#runs-write"],
        disposition: "exclude" as const,
        reason: "already documented on the shared persistence page",
      },
    ]);
    // The unmirrored one is named, and nothing asks for the two to be merged.
    expect(reciprocity.join(" ")).toContain("/api-go#runs-write");
    expect(structural.join(" ")).not.toContain("two sides of one relationship");
  });

  test("both sides matched by id, in one boundary, is clean", () => {
    const entries = [
      area("/api-go", [claim("sessions-write", "outbound", "/api-py")]),
      area("/api-py", [claim("sessions-write", "inbound", "/api-go")]),
    ];
    const { structural, reciprocity } = boundaryProblems(entries as never, [
      {
        boundary: "sessions",
        claims: ["/api-go#sessions-write", "/api-py#sessions-write"],
        disposition: "exclude" as const,
        reason: "already documented on the shared persistence page",
      },
    ]);
    expect(structural).toEqual([]);
    expect(reciprocity).toEqual([]);
  });
});

describe("blocking versus advisory", () => {
  const tree = ["/", "/big", "/big/a", "/big/b", "/big/c", "/big/d"];
  const coarse: Parameters<typeof advisoryProblems>[0] = [
    {
      disposition: "document",
      directory: "/big",
      pages: [page("openwiki/big.md")],
    },
    { disposition: "exclude", directory: "/", reason: "root files" },
  ];

  test("a coarse plan is advised, not blocked", () => {
    // A nudge that can zero a run is not a nudge, so under-decomposition is
    // reported and the run proceeds.
    expect(
      advisoryProblems(coarse, tree, new Map([["/big", 300]])).join(" "),
    ).toContain("needs at least 3");
    expect(blockingProblems(coarse, [])).toEqual([]);
  });

  test("an uncovered directory still blocks", () => {
    // This one is not quality: a subtree nobody planned is invisible in the
    // result, so it has to stop authoring.
    expect(blockingProblems(coarse, ["/unplanned"]).join(" ")).toContain(
      "covered by no entry",
    );
  });
});
