/**
 * Code Interpreter middleware for repository documentation runs.
 *
 * The init workflow's cost is dominated by round-trips, not by thinking. A
 * measured run against a 17,444-file monorepo spent roughly 58 turns on
 * exploration (read_file 27.9, ls 19.1, grep 6.3, glob 5.1) and another 20 on
 * `task`, against only 50-61 write_file/edit_file calls - while the published
 * anchor managed 80. Every intervention that tried to buy breadth or depth by
 * instruction alone simply moved work between those buckets and left the total
 * where it was, because they all compete for one turn budget.
 *
 * Programmatic tool calling breaks that coupling. Exposing the read-only
 * discovery tools and `task` inside the REPL lets one `eval` walk the tree and
 * fan out researchers, so the orchestrator's turn count stops scaling with the
 * repository's size and the freed turns are available for authoring.
 *
 * Claims are what make the fan-out safe: a researcher returns propositions with
 * repo:// evidence rather than prose to be trusted, and the parent establishes
 * them through resolve_claims. That keeps ungrounded subagent output out of the
 * wiki even when nothing the parent inspected produced it.
 */

import { createCodeInterpreterMiddleware } from "@langchain/quickjs";

/**
 * Tools exposed inside the REPL.
 *
 * Read-only discovery plus `task`. Authoring stays on the direct surface: a
 * page's prose has to come out of a model turn, so routing write_file through
 * the REPL would only mean emitting every page's body inside one code string.
 * Fan-out is how authoring scales instead - each subagent spends its own turns.
 *
 * `resolveToolList` silently drops a name matching no registered tool, so a
 * rename upstream would quietly turn the REPL back into a plain sandbox and the
 * agent would fall back to per-file round-trips with nothing failing loudly.
 *
 * `resolve_claims` is deliberately absent. docs-only-backend already refuses
 * shell access to Claims state as implementation-owned, and while a PTC call is
 * a schema-validated tool call rather than a shell escape, widening that
 * boundary is the author's decision to make, not a side effect of this change.
 */
const PTC_TOOLS = ["ls", "glob", "grep", "read_file", "task"] as const;

/**
 * Wall-clock budget for one `eval`.
 *
 * The QuickJS interrupt handler is deadline-based, so time spent awaiting a
 * host PTC call counts against this: the 5s default cannot survive a single
 * `task`, let alone a fan-out. 15 minutes admits a wide fan-out while still
 * bounding a runaway loop far inside a documentation run's own timeout.
 */
const EXECUTION_TIMEOUT_MS = 900_000;

/**
 * Results are a summary channel, not a transport for file contents. The default
 * 4,000 characters is too tight for a reconciled inventory of a large monorepo,
 * and an unbounded one would simply move the context cost from turns to tokens.
 */
const MAX_RESULT_CHARS = 32_000;

/** A tree walk over a large repository holds far more than the 64 MiB default. */
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * Creates the Code Interpreter middleware for init and update runs.
 *
 * @returns Middleware exposing an `eval` tool with the discovery and fan-out
 *   tools callable from inside it.
 */
export function createOpenWikiCodeInterpreterMiddleware() {
  return createCodeInterpreterMiddleware({
    ptc: [...PTC_TOOLS],
    executionTimeoutMs: EXECUTION_TIMEOUT_MS,
    maxResultChars: MAX_RESULT_CHARS,
    memoryLimitBytes: MEMORY_LIMIT_BYTES,
  });
}
