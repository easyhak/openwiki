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
 * Read-only discovery only. `task` is deliberately absent: the middleware exposes
 * it as a top-level `task()` global inside the REPL already, with subagentType
 * and responseSchema support, and listing it in `ptc` is rejected outright
 * because a second dispatch path through `tools.*` would drop responseSchema.
 * Fan-out therefore works without being requested here - and rather better,
 * since a schema lets an author return structured propositions.
 *
 * A responseSchema passed to task() must carry a stable top-level `title`.
 * LangChain names the extraction tool after it and falls back to extract-N off a
 * process-global counter, so an untitled schema gives every dispatch a different
 * tool name, which changes the request prefix and defeats prompt caching for the
 * whole subagent. The init prompt fixes one title for page-author; anything else
 * dispatching with a schema needs its own.
 *
 * Authoring stays on the direct surface: a
 * page's prose has to come out of a model turn, so routing write_file through
 * the REPL would only mean emitting every page's body inside one code string.
 * Fan-out is how authoring scales instead - each subagent spends its own turns.
 *
 * `resolveToolList` silently drops a name matching no registered tool, so a
 * rename upstream would quietly turn the REPL back into a plain sandbox and the
 * agent would fall back to per-file round-trips with nothing failing loudly.
 *
 * `resolve_claims` is here because the coordinator's context was the funnel that
 * lost the claim set. Authors return roughly nineteen propositions per page and
 * only about three per page were being established: to establish a thousand
 * propositions by hand the coordinator must first read all thousand into its
 * transcript and then re-emit them, so it condensed instead, and saying not to
 * did not change that. Called from the REPL it can pipe author returns straight
 * into Claims without any of them entering its context.
 *
 * This does not weaken the boundary docs-only-backend draws. That refuses SHELL
 * access to Claims state as implementation-owned; a PTC call is the same
 * schema-validated tool the agent already holds, reached from code rather than
 * from a message, and the coordinator remains the single writer. Authors still
 * do not get it: fifty-seven concurrent writers is a different question about
 * the store, and the ownership split is what keeps a proposition traceable to
 * the agent that read the evidence.
 */
const PTC_TOOLS = [
  "ls",
  "glob",
  "grep",
  "read_file",
  "resolve_claims",
] as const;

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

/**
 * Heap ceiling per REPL session.
 *
 * The coordinator gets room for a tree walk over a large repository, which the
 * 64 MiB default cannot hold. An author gets far less, because there is one of
 * it per author and roughly twenty run at once: sized like the coordinator that
 * is up to 5 GiB of WASM heaps inside a 16 GiB sandbox, and the first trial with
 * authors holding interpreters died with nothing written and no error recorded,
 * which is what an out-of-memory kill looks like from outside. An author's job
 * here is to locate and extract passages, not to hold a repository in memory.
 */
const COORDINATOR_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const AUTHOR_MEMORY_LIMIT_BYTES = 48 * 1024 * 1024;

/**
 * Creates the Code Interpreter middleware for init and update runs.
 *
 * @returns Middleware exposing an `eval` tool with the discovery and fan-out
 *   tools callable from inside it.
 */
export function createOpenWikiCodeInterpreterMiddleware(
  { concurrent = false }: { concurrent?: boolean } = {},
) {
  return createCodeInterpreterMiddleware({
    ptc: [...PTC_TOOLS],
    executionTimeoutMs: EXECUTION_TIMEOUT_MS,
    maxResultChars: MAX_RESULT_CHARS,
    memoryLimitBytes: concurrent
      ? AUTHOR_MEMORY_LIMIT_BYTES
      : COORDINATOR_MEMORY_LIMIT_BYTES,
  });
}
