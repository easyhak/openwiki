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
import { pool } from "./authoring-pool.js";
import {
  collectSurveyTargets,
  type ListingBackend,
} from "./repo-inventory.js";
import { qaFinalizationProblem, type QaGate } from "./wiki-verification.js";

/** Surveyors in flight. Each reads a whole subtree, so this is real work. */
const SURVEY_CONCURRENCY = 10;

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
  targets: readonly string[],
): string[] {
  const problems: string[] = [];
  const covered = new Set<string>();

  for (const entry of entries) {
    if (!targets.includes(entry.directory)) {
      problems.push(
        `Entry for a directory that is not a survey target: ${entry.directory}`,
      );
      continue;
    }
    covered.add(entry.directory);
    if (entry.pages.length === 0 && !entry.reason) {
      problems.push(
        `Directory ${entry.directory} plans no pages and gives no reason`,
      );
    }
  }

  const missing = targets.filter((target) => !covered.has(target));
  if (missing.length > 0) {
    problems.push(
      `${missing.length} directory(ies) have no plan entry: ${missing.slice(0, 15).join(", ")}${missing.length > 15 ? ", ..." : ""}`,
    );
  }

  const owners = new Map<string, string>();
  for (const entry of entries) {
    for (const page of entry.pages) {
      const owner = owners.get(page);
      if (owner && owner !== entry.directory) {
        // Two directories planning one page means two authors racing on one
        // write_file, and the loser's evidence disappearing.
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

/**
 * Extracts one surveyor's proposed pages from its text block.
 *
 * @param output - Raw surveyor output.
 * @returns Page paths, normalized without a leading slash.
 */
export function parseSurvey(output: string): string[] {
  return [...output.matchAll(/<page\s+path="([^"]+)"/gu)].map((match) =>
    match[1].replace(/^\/+/u, ""),
  );
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
  let taskTool: {
    invoke: (input: unknown, config?: unknown) => Promise<unknown>;
  } | null = null;

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

  const surveyRepository = tool(
    async (_input, config) => {
      if (!taskTool) {
        throw new Error("survey_repository requires the subagent task tool.");
      }
      const dispatch = taskTool;
      const targets = await collectSurveyTargets(backend);

      const outcomes = await pool(targets, SURVEY_CONCURRENCY, async (target) =>
        String(
          await dispatch.invoke(
            {
              description: `Survey the directory ${target.path} of this repository and report the wiki pages its subtree needs, in your documented <survey> format. Its immediate subdirectories are: ${target.children.join(", ") || "none"}. Propose page paths under openwiki/ and do not report pages for any other directory.`,
              subagent_type: "repo-surveyor",
            },
            config,
          ),
        ),
      );

      const entries: PlanEntry[] = [];
      const failed: string[] = [];
      for (const [index, outcome] of outcomes.entries()) {
        const target = targets[index];
        if (outcome.status === "rejected") {
          failed.push(target.path);
          continue;
        }
        const pages = parseSurvey(outcome.value);
        entries.push({
          directory: target.path,
          pages,
          ...(pages.length === 0
            ? { reason: "Surveyor proposed no pages for this directory." }
            : {}),
        });
      }

      const { plannedPages, planWritten } = await setLedger(entries);
      return JSON.stringify({
        directoriesSurveyed: entries.length,
        directoriesFailed: failed,
        plannedPages: plannedPages.length,
        planWritten,
        emptyDirectories: entries
          .filter((entry) => entry.pages.length === 0)
          .map((entry) => entry.directory),
      });
    },
    {
      name: "survey_repository",
      description:
        "Survey every non-test top-level directory concurrently, one repo-surveyor each, and build the plan from what they report. Call this once, before authoring. It writes /openwiki/_plan.md from the result, so do not write or parse that file yourself. Each surveyor owns its subtree and proposes the pages it needs, so you do not plan directory contents yourself: your job afterwards is reconciling names, cross-directory relationships, and anything the surveys missed, through submit_plan.",
      schema: z.object({}),
    },
  );

  const submitPlan = tool(
    async (rawInput) => {
      const input = SubmitPlanSchema.parse(rawInput);
      const targets = await collectSurveyTargets(backend);
      const problems = validatePlan(
        input.entries,
        targets.map((target) => target.path),
      );
      if (problems.length > 0) {
        return JSON.stringify({ accepted: false, problems });
      }
      const { plannedPages, planWritten } = await setLedger(input.entries);
      return JSON.stringify({
        accepted: true,
        directories: input.entries.length,
        plannedPages: plannedPages.length,
        planWritten,
      });
    },
    {
      name: "submit_plan",
      description:
        "Replace the plan with a complete ledger: one entry per surveyed directory, listing the pages it owns, or an explicit reason for planning none. Use it to amend what survey_repository produced - renaming pages, adding a page the surveys missed, resolving two directories that claimed the same page. Every non-test top-level directory must appear, and a ledger missing one is rejected with the list rather than partially applied.",
      schema: SubmitPlanSchema,
    },
  );

  const finalizeWiki = tool(
    async () => {
      if (!ledger) {
        return JSON.stringify({
          complete: false,
          problems: [
            "No plan exists; call survey_repository before finishing.",
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
    tools: [surveyRepository, submitPlan, finalizeWiki],
    wrapModelCall: (request, handler) => {
      const found = (request.tools ?? []).find(
        (candidate: { name?: string }) => candidate.name === "task",
      );
      taskTool ??= (found as unknown as typeof taskTool) ?? null;
      return handler(request);
    },
  });
}
