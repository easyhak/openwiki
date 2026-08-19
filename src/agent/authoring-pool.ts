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
import { resolvePagesIndependently } from "../claims/brains/code/tools.js";
import type { ClaimOperation } from "../claims/core/types.js";
import { z } from "zod";

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
async function pool<TItem, TResult>(
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

/**
 * Reads an author's report out of whatever it actually returned.
 *
 * page-author is told to end with one JSON object and usually does, but a
 * responseSchema does not bind it and a model may wrap the object in prose or a
 * fence. Parsing here rather than in REPL code means one implementation with one
 * set of failure modes, instead of a fresh regex per run.
 *
 * @param output - Raw subagent return value.
 * @returns The parsed report, or null when nothing JSON-shaped was found.
 */
function parseAuthorReport(output: unknown): AuthorReport | null {
  if (output !== null && typeof output === "object") {
    return output;
  }
  if (typeof output !== "string") {
    return null;
  }
  // Last balanced object wins: an author that explains itself before reporting
  // puts the report at the end, and a fenced block leaves the fence outside it.
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(output.slice(start, end + 1)) as AuthorReport;
  } catch {
    return null;
  }
}

/**
 * Converts an author's reported propositions into claim add operations.
 *
 * Authors report evidence as bare `repo://` strings, which is the shape their
 * prompt asks for, while the claim store wants `{resource}` objects. Both are
 * accepted because a model asked for one shape supplies the other often enough
 * that rejecting it would drop real evidence on a technicality.
 *
 * @param propositions - Propositions as the author reported them.
 * @returns Add operations, skipping any proposition with no usable evidence.
 */
function toClaimOperations(
  propositions: { statement: string; evidence: unknown[] }[],
): ClaimOperation[] {
  const operations: ClaimOperation[] = [];
  for (const proposition of propositions) {
    const evidence = (proposition.evidence ?? [])
      .map((entry) =>
        typeof entry === "string"
          ? { resource: entry }
          : entry !== null &&
              typeof entry === "object" &&
              typeof (entry as { resource?: unknown }).resource === "string"
            ? { resource: (entry as { resource: string }).resource }
            : null,
      )
      .filter((entry): entry is { resource: string } => entry !== null);
    if (evidence.length === 0 || !proposition.statement) {
      continue;
    }
    operations.push({
      op: "add",
      statement: proposition.statement,
      evidence,
    });
  }
  return operations;
}

/** One author's structured report. */
interface AuthorReport {
  page?: string;
  propositions?: { statement: string; evidence: unknown[] }[];
  undocumented?: string[];
}

/** One page's authoring outcome, as the REPL receives it. */
interface AuthorOutcome {
  page: string;
  ok: boolean;
  propositions: { statement: string; evidence: unknown[] }[];
  undocumented: string[];
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
  let taskTool: {
    invoke: (input: unknown, config?: unknown) => Promise<unknown>;
  } | null = null;

  const authorPages = tool(
    async (rawInput, config) => {
      const input = AuthorPagesInputSchema.parse(rawInput);
      if (!taskTool) {
        throw new Error(
          "author_pages requires the subagent task tool, which is not registered on this agent.",
        );
      }
      const dispatch = taskTool;

      // One author per page, ever. Two authors on one page race on write_file
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
        const output = await dispatch.invoke(
          { description: assignment.brief, subagent_type: "page-author" },
          config,
        );
        return { assignment, output };
      });

      const results: AuthorOutcome[] = outcomes.map((outcome, index) => {
        const page = assignments[index].page;
        if (outcome.status === "rejected") {
          return {
            page,
            ok: false,
            propositions: [],
            undocumented: [],
            error:
              outcome.reason instanceof Error
                ? outcome.reason.message
                : String(outcome.reason),
          };
        }
        const report = parseAuthorReport(outcome.value.output);
        if (!report) {
          return {
            page,
            ok: false,
            propositions: [],
            undocumented: [],
            error: "Author returned no parseable report.",
          };
        }
        return {
          page,
          ok: true,
          propositions: report.propositions ?? [],
          undocumented: report.undocumented ?? [],
        };
      });

      const authored = results.filter((result) => result.ok);
      const propositionTotal = authored.reduce(
        (total, result) => total + result.propositions.length,
        0,
      );

      // Establish here rather than handing the propositions back.
      //
      // Returning them was the bug that cost a graded run its worst score. Fifty
      // pages of roughly twenty propositions each, with evidence, is far past
      // any tool-result limit: the middleware offloaded it, the offload write
      // was refused, and the coordinator never learned which pages had been
      // written. Offloading works now, but a payload whose only consumer is
      // resolve_claims has no reason to travel through the REPL and the model's
      // context to get there.
      //
      // It also retires the batching instruction. "Accumulate the phase, 8-12
      // pages per call, never per page" produced 108 calls in one run, 16 in the
      // next, and 7 in the run that collapsed. Establishing from here makes the
      // batching a property of the code instead of a thing to ask for.
      const claims = session
        ? await resolvePagesIndependently(
            session,
            authored
              .filter((result) => result.propositions.length > 0)
              .map(
                (result) =>
                  [result.page, toClaimOperations(result.propositions)] as [
                    string,
                    ClaimOperation[],
                  ],
              ),
          )
        : null;

      return JSON.stringify({
        authored: authored.length,
        failed: results.filter((result) => !result.ok),
        propositionTotal,
        pages: results.map((result) => result.page),
        ...(claims
          ? {
              claimsEstablishedFor: claims.pages.length,
              ...(claims.failed ? { claimsFailed: claims.failed } : {}),
            }
          : {}),
        ...(duplicates.length > 0 ? { duplicatePagesIgnored: duplicates } : {}),
      });
    },
    {
      name: "author_pages",
      description:
        "Dispatch one page-author per assignment as a refilling pool of twenty, establish every proposition they report, and return the outcome per page. Pass the whole phase - initial authoring or one repair wave - in a single call: it pools, refills as each author settles, dedupes repeated pages, parses each report, establishes its propositions as Claims, and reports failures per page under failed rather than losing the pool. You do not call resolve_claims for pages authored here; it is already done. Each assignment is {page, brief}, where brief is the complete self-contained instruction for that page, since an author cannot read the plan or its neighbours. Never call this once per page and never run two calls covering the same page at once.",
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
