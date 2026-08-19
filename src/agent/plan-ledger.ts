/**
 * Plan ledger and completion gate.
 *
 * A ten-trial run scored 0.358 on average and 0.290 at the bottom, and the
 * bottom trial was not a quality failure. Its plan reconciled at 65 inventory
 * units and 62 planned pages; 41 authors were dispatched; 33 pages reached
 * disk. Nothing noticed. The workflow's own reconciliation step is an
 * instruction, and an instruction cannot refuse to finish.
 *
 * So the plan becomes a structure rather than a Markdown table the model writes
 * and then re-parses - one graded run really did recover its own plan with
 * `planText.split("\n").filter(x => x.startsWith("| "))` - and finishing
 * becomes a gate that reads that structure. `_plan.md` is rendered from the
 * ledger for the reader's benefit, not consumed as data.
 *
 * The gate is a floor, never a target. Ten trials say reward correlates with
 * page count at +0.52 across the whole sample and at -0.42 once the one
 * collapsed trial is dropped: below the floor, breadth collapse destroys the
 * score; above it, more pages buy nothing. A gate that demanded a page count
 * would be fitting one repository's median and would push every run into the
 * region where breadth stops paying.
 */

import { tool } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { collectInventory } from "./repo-inventory.js";
import type { QaGate } from "./wiki-verification.js";

/** Dispositions a unit may be given, beyond being assigned its own page. */
const GROUPED = "grouped";
const EXCLUDED = "excluded";

const EntrySchema = z.object({
  unitId: z.string().min(1),
  disposition: z.enum(["page", GROUPED, EXCLUDED]),
  page: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
});

const SubmitPlanSchema = z.object({
  entries: z.array(EntrySchema).min(1),
});

/** What the ledger holds once a plan is accepted. */
export interface PlanLedger {
  entries: z.infer<typeof EntrySchema>[];
  plannedPages: string[];
}

/**
 * Validates a submitted ledger against the mechanical inventory.
 *
 * @param entries - Model-supplied dispositions.
 * @param unitIds - Every mechanically discovered unit ID.
 * @returns Human-readable rejections, empty when the ledger is acceptable.
 */
export function validatePlan(
  entries: z.infer<typeof EntrySchema>[],
  unitIds: readonly string[],
): string[] {
  const problems: string[] = [];
  const known = new Set(unitIds);
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!known.has(entry.unitId)) {
      problems.push(`Unknown unit: ${entry.unitId}`);
      continue;
    }
    if (seen.has(entry.unitId)) {
      problems.push(`Duplicate disposition for unit: ${entry.unitId}`);
      continue;
    }
    seen.add(entry.unitId);
    if (entry.disposition === "page" && !entry.page) {
      problems.push(`Unit ${entry.unitId} is dispositioned page with no page`);
    }
    // Grouping and exclusion are the two ways breadth quietly disappears, so
    // each one costs an explicit reason rather than being free.
    if (entry.disposition !== "page" && !entry.reason) {
      problems.push(
        `Unit ${entry.unitId} is ${entry.disposition} with no reason`,
      );
    }
    if (entry.disposition === GROUPED && !entry.page) {
      problems.push(
        `Unit ${entry.unitId} is grouped but names no page to group into`,
      );
    }
  }

  const missing = unitIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    problems.push(
      `${missing.length} unit(s) have no disposition: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""}`,
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
export function renderPlanMarkdown(ledger: PlanLedger): string {
  const rows = ledger.entries
    .map(
      (entry) =>
        `| ${entry.unitId} | ${entry.disposition} | ${entry.page ?? ""} | ${entry.reason ?? ""} |`,
    )
    .join("\n");
  return [
    "# Plan",
    "",
    `Units: ${ledger.entries.length}. Planned pages: ${ledger.plannedPages.length}.`,
    "",
    "| Unit | Disposition | Page | Reason |",
    "| --- | --- | --- | --- |",
    rows,
    "",
  ].join("\n");
}

/** Backend capabilities the ledger tools need. */
interface LedgerBackend {
  ls(dirPath: string): Promise<{
    error?: string;
    files?: { path: string; is_dir?: boolean }[];
  }>;
  write(filePath: string, content: string): Promise<{ error?: string }>;
}

/**
 * Creates the plan-ledger middleware.
 *
 * @param backend - Repository filesystem backend.
 * @param wikiRoot - Directory generated pages live under.
 * @returns Middleware exposing `submit_plan` and `finalize_wiki`.
 */
export function createOpenWikiPlanLedgerMiddleware(
  backend: LedgerBackend,
  qaGate?: QaGate,
  wikiRoot = "/openwiki",
) {
  let ledger: PlanLedger | null = null;

  const submitPlan = tool(
    async (rawInput) => {
      const input = SubmitPlanSchema.parse(rawInput);
      const units = await collectInventory(backend);
      const problems = validatePlan(
        input.entries,
        units.map((unit) => unit.id),
      );
      if (problems.length > 0) {
        return JSON.stringify({ accepted: false, problems });
      }
      const plannedPages = [
        ...new Set(
          input.entries
            .filter((entry) => entry.disposition === "page")
            .map((entry) => entry.page as string),
        ),
      ];
      ledger = { entries: input.entries, plannedPages };
      const written = await backend.write(
        `${wikiRoot}/_plan.md`,
        renderPlanMarkdown(ledger),
      );
      return JSON.stringify({
        accepted: true,
        units: units.length,
        plannedPages: plannedPages.length,
        grouped: input.entries.filter((e) => e.disposition === GROUPED).length,
        excluded: input.entries.filter((e) => e.disposition === EXCLUDED).length,
        planWritten: !written.error,
      });
    },
    {
      name: "submit_plan",
      description:
        "Submit the unit-to-page ledger for the whole repository. Every unit inventory_repository returned needs exactly one entry: disposition 'page' with its canonical page, or 'grouped' into a named page with a reason, or 'excluded' with a reason. A ledger missing units, repeating one, or grouping without a reason is rejected with the problems listed, and nothing is recorded until it is accepted. /openwiki/_plan.md is rendered from the accepted ledger, so do not write it yourself and do not parse it back - ask for the ledger instead.",
      schema: SubmitPlanSchema,
    },
  );

  const finalizeWiki = tool(
    async () => {
      if (!ledger) {
        return JSON.stringify({
          complete: false,
          problems: ["No plan has been accepted; call submit_plan first."],
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

      const absent = ledger.plannedPages.filter((page) => {
        const normalized = page.replace(/^\/+/u, "");
        return !existing.has(normalized);
      });
      if (absent.length > 0) {
        problems.push(
          `${absent.length} planned page(s) were never written: ${absent.slice(0, 10).join(", ")}${absent.length > 10 ? ", ..." : ""}`,
        );
      }
      // QA blocks finishing only in full mode, and only for a documentation
      // defect. `off` finalizes with the outcome recorded as not_triggered, so
      // an ablation has a clean control rather than a mode that cannot end. And
      // an infrastructure failure never blocks: a run that authored sixty pages
      // has done real work, and refusing to let it finish because the QA
      // plumbing broke would burn every token that produced them.
      if (qaGate?.mode === "full") {
        if (qaGate.status === "not_triggered") {
          problems.push(
            "Semantic QA has not run. Call verify_wiki, repair what it reports, then verify again.",
          );
        } else if (qaGate.status === "failed") {
          problems.push(
            `Semantic QA left ${qaGate.unresolved.length} question(s) unresolved: ${qaGate.unresolved.slice(0, 10).join(", ")}. Repair the reported pages through author_pages, then call verify_wiki again.`,
          );
        }
      }

      return JSON.stringify({
        complete: problems.length === 0,
        plannedPages: ledger.plannedPages.length,
        pagesOnDisk: existing.size,
        ...(qaGate
          ? { qaMode: qaGate.mode, qaStatus: qaGate.status }
          : {}),
        problems,
      });
    },
    {
      name: "finalize_wiki",
      description:
        "Check the wiki against the accepted plan before you finish. It reports any planned page that was never written. You may not end the run while it reports problems: author the missing pages and call it again. It reads the ledger rather than your summary of it, because a run that lost an authoring report once finished with 33 of 62 planned pages and reported success.",
      schema: z.object({}),
    },
  );

  return createMiddleware({
    name: "OpenWikiPlanLedgerMiddleware",
    tools: [submitPlan, finalizeWiki],
  });
}
