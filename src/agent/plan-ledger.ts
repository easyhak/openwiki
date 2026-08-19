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
import { qaFinalizationProblem, type QaGate } from "./wiki-verification.js";

const EntrySchema = z.object({
  directory: z.string().min(1),
  pages: z.array(z.string().min(1)),
  reason: z.string().min(1).optional(),
});

const SubmitPlanSchema = z.object({
  entries: z.array(EntrySchema).min(1),
});

type PlanEntry = z.infer<typeof EntrySchema>;

/** What the ledger holds once a plan is accepted. */
export interface PlanLedger {
  entries: PlanEntry[];
  plannedPages: string[];
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
): string[] {
  const problems: string[] = [];

  for (const entry of entries) {
    // A directory that is not in the tree is a typo, and a typo can leave the
    // directory it meant uncovered while looking like it was planned.
    if (!tree.includes(entry.directory)) {
      problems.push(
        `Entry names a directory that does not exist or was not listed: ${entry.directory}`,
      );
    }
    if (entry.pages.length === 0 && !entry.reason) {
      problems.push(
        `Directory ${entry.directory} plans no pages and gives no reason`,
      );
    }
  }

  if (uncovered.length > 0) {
    problems.push(
      `${uncovered.length} director(ies) are covered by no entry: ${uncovered.slice(0, 20).join(", ")}${uncovered.length > 20 ? ", ..." : ""}`,
    );
  }

  const owners = new Map<string, string>();
  for (const entry of entries) {
    for (const page of entry.pages) {
      const owner = owners.get(page);
      if (owner && owner !== entry.directory) {
        // Two entries planning one page is two authors racing on one
        // write_file, with the loser's evidence gone.
        problems.push(
          `Page ${page} is claimed by both ${owner} and ${entry.directory}`,
        );
      }
      owners.set(page, entry.directory);
    }
  }
  return problems;
}

/**
 * Renders the reader-facing plan from the accepted ledger.
 *
 * @param ledger - Accepted plan.
 * @returns Markdown for `/openwiki/_plan.md`.
 */
export function renderPlanMarkdown(ledger: PlanLedger): string {
  return [
    "# Plan",
    "",
    `Directories: ${ledger.entries.length}. Planned pages: ${ledger.plannedPages.length}.`,
    "",
    "| Directory | Pages | Note |",
    "| --- | --- | --- |",
    ...ledger.entries.map(
      (entry) =>
        `| ${entry.directory} | ${entry.pages.join("<br>") || "-"} | ${entry.reason ?? ""} |`,
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
  qaGate?: QaGate,
  wikiRoot = "/openwiki",
) {
  let ledger: PlanLedger | null = null;

  const setLedger = async (entries: PlanEntry[]) => {
    const plannedPages = [
      ...new Set(entries.flatMap((entry) => entry.pages)),
    ].map((page) => page.replace(/^\/+/u, ""));
    ledger = { entries, plannedPages };
    const written = await backend.write(
      `${wikiRoot}/_plan.md`,
      renderPlanMarkdown(ledger),
    );
    return { plannedPages, planWritten: !written.error };
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
      const problems = validatePlan(input.entries, tree, uncovered);
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
        emptyEntries: input.entries
          .filter((entry) => entry.pages.length === 0)
          .map((entry) => entry.directory),
      });
    },
    {
      name: "submit_plan",
      description:
        "Submit the plan: one entry per area of the repository, each naming the directory it covers and the pages that document it, or an explicit reason for planning none. Choose entry directories to match how this repository is organised - one per service where services sit at the top level, one per package under a nested packages/ tree, a handful for a small repository. Entries may nest, and a directory belongs to its deepest entry. Every directory from list_repository_directories must be covered, and a plan missing one is rejected with the paths rather than partially applied. /openwiki/_plan.md is rendered from the accepted plan, so do not write or parse it yourself.",
      schema: SubmitPlanSchema,
    },
  );

  const finalizeWiki = tool(
    async () => {
      if (!ledger) {
        return JSON.stringify({
          complete: false,
          problems: [
            "No plan exists; call submit_plan before finishing.",
          ],
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
            existing.add(file.path.replace(/^\/+/u, ""));
          }
        }
      };
      await collect(wikiRoot, 0);

      const absent = ledger.plannedPages.filter((page) => !existing.has(page));
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
        plannedPages: ledger.plannedPages.length,
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
