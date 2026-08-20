/**
 * Survey fan-out, plan ledger, and completion gate.
 *
 * Three failures from graded runs meet here.
 *
 * Planning a 17,444-file monorepo in one context does not work, so the survey
 * fans out: one `repo-surveyor` per top-level directory, pooled the way authors
 * are, each owning its subtree. The ledger is assembled here from what they
 * return, so no surveyor's output passes through the coordinator's context.
 *
 * Coverage is the guarantee code can make, and the only one it should try to.
 * An earlier version enumerated units by rule and produced 213 of them for this
 * repository - every CI workflow file, every benchmark fixture's Dockerfile -
 * because no rule distinguishes a fixture from a service. Directories it can be
 * certain of. So every non-test top-level directory must appear in the ledger,
 * with pages or with a stated reason for none; a subtree nobody mentions is
 * indistinguishable from a subtree nobody read.
 *
 * And finishing is a gate rather than an instruction. A trial reconciled at 62
 * planned pages, dispatched 41 authors, wrote 33 pages, and reported success,
 * because reconciliation was step 8 of a workflow and an instruction cannot
 * refuse to finish.
 *
 * The gate is a floor, never a target. Reward correlates with page count at
 * +0.52 across ten trials and at -0.42 once the collapsed one is dropped: below
 * the floor breadth collapse destroys the score, above it more pages buy
 * nothing.
 */

import { tool } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import { z } from "zod";
import {
  collectDirectoryTree,
  findUncoveredDirectories,
  type ListingBackend,
} from "./repo-inventory.js";
import {
  missingEvidence,
  type PlanEntry,
  type PlannedPage,
  type PlanStore,
} from "./plan-store.js";
import { qaFinalizationProblem, type QaGate } from "./wiki-verification.js";

/**
 * What a directory's documentation disposition is.
 *
 * The previous shape - `pages: []` with an optional reason - made "no page" an
 * obscure edge of the schema, and a graded run took the hint: not one of 59
 * entries used it. Every directory got a page manufactured for it, including
 * /secrets.example, /test_data, and three personal scratch trees under
 * /experimental, each consuming an author that a real subsystem needed.
 *
 * Making the three outcomes peers fixes the incentive. Not documenting a
 * directory is a normal, first-class answer, and saying so costs a reason
 * rather than an apology.
 */
const PlannedPageSchema = z
  .object({
    path: z.string().min(1),
    responsibility: z.string().min(1).describe("One line: what this owns."),
    entrypoint: z
      .string()
      .min(1)
      .describe("The named symbol or file a reader starts from."),
    sources: z
      .array(z.string().min(1))
      .min(1)
      .describe("Implementation paths and symbols, not directories."),
    tests: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Focused tests and the command that runs them - the Make target or CI job, not just the file.",
      ),
    edges: z
      .array(
        z.object({
          page: z.string().min(1),
          relationship: z
            .string()
            .min(1)
            .describe("What crosses the boundary, in which direction."),
        }),
      )
      .default([]),
  })
  .strict();

const EntrySchema = z.discriminatedUnion("disposition", [
  z
    .object({
      disposition: z.literal("document"),
      directory: z.string().min(1),
      pages: z.array(PlannedPageSchema).min(1),
    })
    .strict(),
  z
    .object({
      disposition: z.literal("covered_by"),
      directory: z.string().min(1),
      page: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      disposition: z.literal("exclude"),
      directory: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
]);

const SubmitPlanSchema = z.object({
  entries: z.array(EntrySchema).min(1),
});

/**
 * Normalizes a page path to exactly one wiki-root prefix.
 *
 * finalize_wiki compared plan paths against a walk of the wiki tree, and the
 * plan wrote `architecture/overview.md` while the walk produced
 * `openwiki/architecture/overview.md`. Nothing ever matched, so the gate told a
 * run that had written 72 pages that all 70 of its planned pages were missing,
 * and it authored every one of them a second time: 200 authors for 70 pages and
 * twice the token spend of any other run. Both sides normalize through here now.
 *
 * @param page - Page path as planned or as found on disk.
 * @param wikiRoot - Directory generated pages live under.
 * @returns Path rooted at the wiki directory, without a leading slash.
 */
export function normalizeWikiPage(page: string, wikiRoot = "/openwiki"): string {
  const root = wikiRoot.replace(/^\/+/u, "").replace(/\/+$/u, "");
  const bare = page.replace(/^\/+/u, "");
  return bare === root || bare.startsWith(`${root}/`) ? bare : `${root}/${bare}`;
}

/**
 * Validates a ledger against the directories that must be accounted for.
 *
 * @param entries - Plan entries, one per surveyed directory.
 * @param targets - Every survey target's path.
 * @returns Human-readable rejections, empty when the ledger is acceptable.
 */
export function validatePlan(
  entries: PlanEntry[],
  tree: readonly string[],
  uncovered: readonly string[],
  wikiRoot = "/openwiki",
): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string>();

  for (const entry of entries) {
    // A directory not in the tree is a typo, and a typo can leave the directory
    // it meant uncovered while looking like it was planned.
    if (!tree.includes(entry.directory)) {
      problems.push(
        `Entry names a directory that does not exist or was not listed: ${entry.directory}`,
      );
    }
    if (entry.disposition !== "document") {
      continue;
    }
    for (const page of entry.pages) {
      const key = normalizeWikiPage(page.path, wikiRoot);
      const owner = owners.get(key);
      if (owner && owner !== entry.directory) {
        // Two entries owning one page is two authors racing on one write, with
        // the loser's work gone.
        problems.push(
          `Page ${key} is owned by both ${owner} and ${entry.directory}`,
        );
      }
      owners.set(key, entry.directory);
      // A page without an implementation anchor, an entrypoint, or a focused
      // test cannot be authored well: the author writes what it can see, and
      // what it cannot see is what the grader asks for.
      const missing = missingEvidence(page);
      if (missing.length > 0) {
        problems.push(`Page ${page.path} is missing ${missing.join(", ")}`);
      }
    }
  }

  for (const entry of entries) {
    if (entry.disposition !== "covered_by") {
      continue;
    }
    const key = normalizeWikiPage(entry.page, wikiRoot);
    if (!owners.has(key)) {
      problems.push(
        `${entry.directory} is covered_by ${key}, which no entry documents`,
      );
    }
  }

  // An edge naming a page nothing documents is a link the author would be told
  // to make and could not.
  for (const entry of entries) {
    if (entry.disposition !== "document") {
      continue;
    }
    for (const page of entry.pages) {
      for (const edge of page.edges) {
        if (!owners.has(normalizeWikiPage(edge.page, wikiRoot))) {
          problems.push(
            `Page ${page.path} has an edge to ${edge.page}, which no entry documents`,
          );
        }
      }
    }
  }

  if (uncovered.length > 0) {
    problems.push(
      `${uncovered.length} director(ies) are covered by no entry: ${uncovered.slice(0, 20).join(", ")}${uncovered.length > 20 ? ", ..." : ""}`,
    );
  }
  return problems;
}

/**
 * Renders the reader-facing plan from the accepted ledger.
 *
 * @param ledger - Accepted plan.
 * @returns Markdown for `/openwiki/_plan.md`.
 */
export function renderPlanMarkdown(entries: PlanEntry[]): string {
  const counts = { document: 0, covered_by: 0, exclude: 0 };
  for (const entry of entries) {
    counts[entry.disposition] += 1;
  }
  const pages = entries.flatMap((entry) =>
    entry.disposition === "document" ? entry.pages : [],
  );
  return [
    "# Plan",
    "",
    `${entries.length} directories: ${counts.document} documented, ${counts.covered_by} covered elsewhere, ${counts.exclude} excluded. ${pages.length} pages.`,
    "",
    "| Page | Responsibility | Entrypoint | Tests | Relates to |",
    "| --- | --- | --- | --- | --- |",
    ...pages.map(
      (page) =>
        `| ${page.path} | ${page.responsibility} | ${page.entrypoint} | ${page.tests.join("<br>")} | ${page.edges.map((edge) => edge.page).join("<br>") || "-"} |`,
    ),
    "",
    "| Directory | Disposition | Note |",
    "| --- | --- | --- |",
    ...entries
      .filter((entry) => entry.disposition !== "document")
      .map(
        (entry) =>
          `| ${entry.directory} | ${entry.disposition} | ${"reason" in entry ? entry.reason : ""} |`,
      ),
    "",
  ].join("\n");
}

/** Backend capabilities the ledger tools need. */
interface LedgerBackend extends ListingBackend {
  write(filePath: string, content: string): Promise<{ error?: string }>;
}

/**
 * Creates the survey, plan, and finalization middleware.
 *
 * @param backend - Repository filesystem backend.
 * @param qaGate - Shared QA state, consulted when finishing.
 * @param wikiRoot - Directory generated pages live under.
 * @returns Middleware exposing survey_repository, submit_plan, finalize_wiki.
 */
export function createOpenWikiPlanLedgerMiddleware(
  backend: LedgerBackend,
  store: PlanStore,
  qaGate?: QaGate,
  wikiRoot = "/openwiki",
) {
  const setLedger = async (entries: PlanEntry[]) => {
    // Keyed by normalized path, because the brief renderer and the completion
    // gate both look pages up and the plan spells them inconsistently.
    const pages = new Map<string, PlannedPage>();
    for (const entry of entries) {
      if (entry.disposition !== "document") {
        continue;
      }
      for (const page of entry.pages) {
        pages.set(normalizeWikiPage(page.path, wikiRoot), page);
      }
    }
    store.set({ entries, pages });
    const written = await backend.write(
      `${wikiRoot}/_plan.md`,
      renderPlanMarkdown(entries),
    );
    return { plannedPages: [...pages.keys()], planWritten: !written.error };
  };

  const listDirectories = tool(
    async () => {
      const tree = await collectDirectoryTree(backend);
      return JSON.stringify({ directories: tree.length, tree });
    },
    {
      name: "list_repository_directories",
      description:
        "List the repository's directories for planning, three levels deep, with test, vendor, and build directories already excluded. Coverage is not limited to what this shows: submit_plan checks the whole tree to any depth, and an entry covers everything beneath it, so a directory deeper than this listing is covered by whichever entry contains it.",
      schema: z.object({}),
    },
  );

  const submitPlan = tool(
    async (rawInput) => {
      const input = SubmitPlanSchema.parse(rawInput);
      const directories = input.entries.map((entry) => entry.directory);
      const [tree, uncovered] = await Promise.all([
        collectDirectoryTree(backend),
        findUncoveredDirectories(backend, directories),
      ]);
      const problems = validatePlan(input.entries, tree, uncovered, wikiRoot);
      if (problems.length > 0) {
        return JSON.stringify({ accepted: false, problems });
      }
      const { plannedPages, planWritten } = await setLedger(input.entries);
      return JSON.stringify({
        accepted: true,
        directoriesCovered: tree.length,
        entries: input.entries.length,
        plannedPages: plannedPages.length,
        planWritten,
        documented: input.entries.filter((e) => e.disposition === "document")
          .length,
        coveredElsewhere: input.entries.filter(
          (e) => e.disposition === "covered_by",
        ).length,
        excluded: input.entries.filter((e) => e.disposition === "exclude")
          .length,
      });
    },
    {
      name: "submit_plan",
      description:
        "Submit the plan: one entry per area of the repository, each with a disposition. A documented area lists its pages, and each page carries the evidence its author will be sent: responsibility in one line, the entrypoint a reader starts from, implementation paths and symbols rather than directories, the focused tests plus the command that runs them, and an edge per relationship saying what crosses the boundary in which direction. A page missing any of those is rejected, because an author sent without them writes what it can see and omits what a reader changing the code actually needs. Beyond that: Use document with the pages it owns; covered_by naming another entry's page and why, when the area is relevant but belongs on that page; or exclude with a reason, when the area is not a documentation subject at all. Excluding is a normal outcome, not a failure - fixtures, test data, generated output, scratch and personal experiments usually deserve it, and a page manufactured for one costs an author a real subsystem needed. It is also narrow: CI and release workflows, deployment and infrastructure definitions, migrations, schedulers, data stores, and configuration a reader needs to run the system are documented or covered_by, never excluded, because a reader changing code needs to know how it is built, released, and verified. A dedicated page needs evidence of an independent responsibility, owner and entrypoint, lifecycle or state boundary, public extension surface, or meaningful validation surface; a directory existing is not on its own a reason to document it. A large area is several pages: give one each to independently registered route families, distinct data models or stores, and subsystems that run on their own, because a single page cannot state the responsibility, boundary, and validation surface of each. Choose entry directories to match how the repository is organised, nest them where a directory has significant files beside significant subdirectories, and cover every directory from list_repository_directories - a plan missing one is rejected with the paths rather than partially applied. /openwiki/_plan.md is rendered from the accepted plan, so do not write or parse it yourself.",
      schema: SubmitPlanSchema,
    },
  );

  const finalizeWiki = tool(
    async () => {
      const ledger = store.get();
      if (!ledger) {
        return JSON.stringify({
          complete: false,
          problems: ["No plan exists; call submit_plan before finishing."],
        });
      }
      const problems: string[] = [];
      const existing = new Set<string>();
      const collect = async (directory: string, depth: number) => {
        if (depth > 8) {
          return;
        }
        const result = await backend.ls(directory);
        for (const file of result.files ?? []) {
          if (file.is_dir) {
            await collect(file.path, depth + 1);
          } else if (file.path.endsWith(".md")) {
            existing.add(normalizeWikiPage(file.path, wikiRoot));
          }
        }
      };
      await collect(wikiRoot, 0);

      const absent = [...ledger.pages.keys()].filter(
        (page) => !existing.has(page),
      );
      if (absent.length > 0) {
        problems.push(
          `${absent.length} planned page(s) were never written: ${absent.slice(0, 10).join(", ")}${absent.length > 10 ? ", ..." : ""}`,
        );
      }
      const qaProblem = qaGate ? qaFinalizationProblem(qaGate) : null;
      if (qaProblem) {
        problems.push(qaProblem);
      }

      return JSON.stringify({
        complete: problems.length === 0,
        plannedPages: ledger.pages.size,
        pagesOnDisk: existing.size,
        ...(qaGate ? { qaMode: qaGate.mode, qaStatus: qaGate.status } : {}),
        problems,
      });
    },
    {
      name: "finalize_wiki",
      description:
        "Check the wiki against the plan before you finish, and against semantic QA when it is enabled. It reports any planned page that was never written. You may not end the run while it reports problems: author the missing pages through author_pages and call it again. It reads the ledger rather than your summary of it, because a run that lost an authoring report once finished with 33 of 62 planned pages and reported success.",
      schema: z.object({}),
    },
  );

  return createMiddleware({
    name: "OpenWikiPlanLedgerMiddleware",
    tools: [listDirectories, submitPlan, finalizeWiki],
  });
}
