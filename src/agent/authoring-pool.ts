/**
 * Host-side authoring pool and repair-wave driver.
 *
 * The orchestration was the run's largest uncontrolled variable. Given the same
 * prompt, graded runs wrote materially different schedulers in REPL JavaScript:
 * one dispatched authors in fixed slices of eighteen and waited for the slowest
 * author in each slice, another pooled them; one called resolve_claims once per
 * page a hundred and eight times, another batched; one ran four verifier waves
 * against an unchanged wiki before repairing anything; and one indexed a text
 * block as an array and silently skipped its entire QA phase. Every instruction
 * added to correct these worked twice and failed once, because a prompt asks for
 * a scheduler and cannot guarantee one.
 *
 * So the scheduler stops being an instruction. This middleware exposes it as a
 * tool: the model supplies assignments and policy, and the pool, the refill, the
 * settling, the deduplication and the result parsing happen here, identically on
 * every run. What the model is good at - deciding which pages exist and what
 * evidence each author needs - stays with the model.
 *
 * It dispatches through the same `task` tool the agent already holds, found the
 * way @langchain/quickjs finds it: from `request.tools` in `wrapModelCall`.
 * Subagent selection, permissions and filesystem confinement are therefore
 * unchanged - this is a scheduling wrapper, not a second dispatch path.
 */

import { tool } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import type { ClaimSession } from "../claims/brains/code/session.js";
import { z } from "zod";
import { normalizeWikiPage } from "./plan-ledger.js";
import { dispatchSubagent, type TaskToolLike } from "./subagent-dispatch.js";

/**
 * Authors in flight at once.
 *
 * Twenty was the figure the prompt asked for and the figure a pooled run
 * actually sustained. The cap is on concurrent subagents rather than on batch
 * size, which is the whole difference: a slice of twenty finishes when its
 * slowest author does, while a pool of twenty is twenty busy authors until the
 * work runs out.
 */
const DEFAULT_AUTHOR_CONCURRENCY = 20;

/** Hard ceiling, so a model-supplied concurrency cannot become a fork bomb. */
const MAX_AUTHOR_CONCURRENCY = 32;

/**
 * Runs `worker` over `items` as a refilling pool rather than as batches.
 *
 * Each slot takes the next unstarted item the moment it settles, so one slow
 * item delays only itself. Rejections are captured per item, never thrown: a
 * pool that aborts on the first failure would lose every author still running.
 *
 * @param items - Work items in dispatch order.
 * @param limit - Maximum items in flight.
 * @param worker - Per-item async operation.
 * @returns Settled outcomes in the order `items` were supplied.
 */
export async function pool<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
): Promise<PromiseSettledResult<TResult>[]> {
  const outcomes: PromiseSettledResult<TResult>[] = Array.from(
    { length: items.length },
    () => ({ status: "rejected", reason: new Error("not started") }),
  );
  let next = 0;
  const slots = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) {
          return;
        }
        try {
          outcomes[index] = {
            status: "fulfilled",
            value: await worker(items[index], index),
          };
        } catch (reason) {
          outcomes[index] = { status: "rejected", reason };
        }
      }
    })(),
  );
  await Promise.all(slots);
  return outcomes;
}

/** One page's authoring outcome, as the REPL receives it. */
interface AuthorOutcome {
  page: string;
  claims: number;
  error?: string;
}

const AssignmentSchema = z.object({
  page: z.string().min(1),
  // Named `brief` for a repair as much as for a first draft, because an author
  // has no memory of its first pass: a repair brief is the original brief plus
  // the defect, not the defect alone. A graded run tried `{page, defect}` first
  // and spent a round trip on the schema error, so the description says so.
  brief: z
    .string()
    .min(1)
    .describe(
      "Complete self-contained instruction for this page. For a repair, the original brief plus the defect to fix - never the defect alone, since the author cannot see its previous pass.",
    ),
});

const AuthorPagesInputSchema = z.object({
  assignments: z.array(AssignmentSchema).min(1),
  concurrency: z.number().int().positive().optional(),
});

/**
 * Creates the authoring-pool middleware.
 *
 * @returns Middleware exposing `author_pages`, for registration in `ptc`.
 */
export function createOpenWikiAuthoringPoolMiddleware(session?: ClaimSession) {
  // Narrow to what dispatch needs, because the request's tool union includes
  // shapes without `invoke` and this only ever calls one tool by name.
  let taskTool: TaskToolLike | null = null;

  const authorPages = tool(
    async (rawInput, config) => {
      const input = AuthorPagesInputSchema.parse(rawInput);
      if (!taskTool) {
        throw new Error(
          "author_pages requires the subagent task tool, which is not registered on this agent.",
        );
      }
      const dispatch = taskTool;

      // One author per page, ever. Two authors on one page race on the write
      // and the loser's evidence is silently gone, so a repeated page is a
      // caller bug worth reporting rather than a request worth honouring.
      const seen = new Set<string>();
      const assignments: { page: string; brief: string }[] = [];
      const duplicates: string[] = [];
      for (const assignment of input.assignments) {
        if (seen.has(assignment.page)) {
          duplicates.push(assignment.page);
          continue;
        }
        seen.add(assignment.page);
        assignments.push(assignment);
      }

      const limit = Math.min(
        input.concurrency ?? DEFAULT_AUTHOR_CONCURRENCY,
        MAX_AUTHOR_CONCURRENCY,
      );
      const outcomes = await pool(assignments, limit, async (assignment) => {
        const output = await dispatchSubagent(
          dispatch,
          "page-author",
          assignment.brief,
          config,
        );
        return { assignment, output };
      });

      // Counts come from the claim session, which is the authority on what was
      // established. Asking the author to report them put the same payload
      // through the same seam under a different name, and a report can disagree
      // with the store while the store cannot disagree with itself.
      const results: AuthorOutcome[] = outcomes.map((outcome, index) => {
        const page = `/${normalizeWikiPage(assignments[index].page)}`;
        if (outcome.status === "rejected") {
          return {
            page,
            claims: 0,
            error:
              outcome.reason instanceof Error
                ? outcome.reason.message
                : String(outcome.reason),
          };
        }
        return { page, claims: session ? session.inspectClaims(page).length : 0 };
      });

      // Zero claims is a failed task, not a page needing another pass. A page
      // is written only alongside its claims now, so an author that established
      // none produced nothing - and re-dispatching the same brief that already
      // produced nothing is how a run spent 136 author calls on 68 pages.
      for (const result of results) {
        if (!result.error && result.claims === 0) {
          result.error =
            "Author established no claims, so it wrote nothing. Do not re-dispatch this brief unchanged: give it the specific evidence anchors it lacked, or drop the page.";
        }
      }
      const failed = results.filter((result) => result.error);

      return JSON.stringify({
        authored: results.length - failed.length,
        claimsEstablished: results.reduce(
          (total, result) => total + result.claims,
          0,
        ),
        failed,
        ...(duplicates.length > 0 ? { duplicatePagesIgnored: duplicates } : {}),
      });
    },
    {
      name: "author_pages",
      description:
        "Dispatch one page-author per assignment as a refilling pool of twenty and return each page's outcome. Pass the whole phase - initial authoring or one repair wave - in a single call: it pools, refills as each author settles, dedupes repeated pages, and reports a failed author against its own page rather than losing the pool. Each author writes its page and establishes its own Claims, so you do not call resolve_claims for these pages; the counts come back from the claim store itself. A page under pagesWithNoClaims wrote prose it never grounded and is worth re-dispatching. Each assignment is {page, brief}, where brief is the complete self-contained instruction for that page, since an author cannot read the plan or its neighbours. Never call this once per page and never run two calls covering the same page at once.",
      schema: AuthorPagesInputSchema,
    },
  );

  return createMiddleware({
    name: "OpenWikiAuthoringPoolMiddleware",
    tools: [authorPages],
    wrapModelCall: (request, handler) => {
      // Same source @langchain/quickjs reads it from: the task tool is created
      // by the subagent middleware and only appears on the request.
      const found = (request.tools ?? []).find(
        (candidate: { name?: string }) => candidate.name === "task",
      );
      taskTool ??= (found as unknown as typeof taskTool) ?? null;
      return handler(request);
    },
  });
}
