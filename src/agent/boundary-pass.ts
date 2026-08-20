/**
 * A pass that reads pages in pairs.
 *
 * Boundary is the claim role the grader finds absent most often and the only
 * one no intervention has moved: 59% to 79% absent across every round, under a
 * page contract that names it, briefs that carry the relationship, and a rule
 * requiring one per page. Requiring more edges bought token edges. Carrying the
 * neighbour's responsibility into the brief helped the author describe its own
 * side.
 *
 * The reason it resists is structural. A boundary fact is a fact about two
 * components - that the control plane never calls into the data plane, that Go
 * and Python write the same Redis keys, that headers are rebuilt from an
 * allowlist rather than forwarded - and every writer in this system owns exactly
 * one page. An author is told not to read its neighbours, correctly, because
 * they are half-written while it works. So nobody is ever in a position to
 * notice what the pair implies.
 *
 * Once authoring is done those pages are finished, and reading them together is
 * cheap in a way reading source is not. This pass gives one reviewer a page and
 * the pages it has edges to, and asks for the facts that only appear when you
 * hold both.
 */

import { tool } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { pool } from "./authoring-pool.js";
import { canonicalWikiPage, type PlanStore } from "./plan-store.js";
import { dispatchSubagent, type TaskToolLike } from "./subagent-dispatch.js";

/** Pairs reviewed at once. Each reads two or more finished pages. */
const BOUNDARY_CONCURRENCY = 12;

/**
 * Creates the boundary reconciliation middleware.
 *
 * @param store - Shared plan store, for the edges to reconcile.
 * @returns Middleware exposing `reconcile_boundaries`.
 */
export function createOpenWikiBoundaryMiddleware(store: PlanStore) {
  let taskTool: TaskToolLike | null = null;

  const reconcile = tool(
    async (_input, config) => {
      const ledger = store.get();
      if (!ledger) {
        return JSON.stringify({
          reconciled: 0,
          error: "No plan recorded.",
        });
      }
      if (!taskTool) {
        throw new Error("reconcile_boundaries requires the subagent task tool.");
      }
      const dispatch = taskTool;

      const work = [...ledger.pages.values()]
        .filter((page) => page.edges.length > 0)
        .map((page) => ({
          page: canonicalWikiPage(page.path),
          neighbours: page.edges.map((edge) => ({
            page: canonicalWikiPage(edge.page),
            relationship: edge.relationship,
          })),
        }));

      const outcomes = await pool(work, BOUNDARY_CONCURRENCY, (item) =>
        dispatchSubagent(
          dispatch,
          "page-author",
          [
            `Reconcile the boundaries of ${item.page} against the pages it relates to. Both are already written.`,
            "",
            "Read your page and each of these, then edit only your page:",
            ...item.neighbours.map(
              (n) => `  - ${n.page} - ${n.relationship}`,
            ),
            "",
            "You are looking for the facts that only appear when both pages are in front of you, and that neither author could state alone: what actually crosses between them - the call, the table, the queue, the header, the contract - in which direction, what the other side does with it, and what it does NOT do. A one-way rule is a boundary fact: if one of them never calls back into the other, say so. So is a shared substrate: if both write the same store or keys, say so and say who owns which.",
            "Where your page already claims a relationship in vague terms, replace it with the specific mechanism. Where the pair implies something neither page states, add it.",
            "Establish any new proposition with establish_claims before write_page, as usual, and change nothing else about the page.",
          ].join("\n"),
          config,
        ),
      );

      const failed = outcomes.filter((o) => o.status === "rejected").length;
      return JSON.stringify({
        reconciled: outcomes.length - failed,
        failed,
        pagesWithoutEdges: ledger.pages.size - work.length,
      });
    },
    {
      name: "reconcile_boundaries",
      description:
        "After the wiki is written, review each page against the pages it has relationships to and state what actually crosses between them. One reviewer reads both sides, which no author could do while they were being written. Call it once, after authoring and before finishing. It edits pages in place and establishes any new propositions itself.",
      schema: z.object({}),
    },
  );

  return createMiddleware({
    name: "OpenWikiBoundaryMiddleware",
    tools: [reconcile],
    wrapModelCall: (request, handler) => {
      const found = (request.tools ?? []).find(
        (candidate: { name?: string }) => candidate.name === "task",
      );
      taskTool ??= (found as unknown as typeof taskTool) ?? null;
      return handler(request);
    },
  });
}
