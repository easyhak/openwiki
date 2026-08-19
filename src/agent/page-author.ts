/**
 * The init-only page authoring subagent.
 *
 * Authoring is the phase that dominates a documentation run: 111 write_file and
 * edit_file calls over 270 messages in the measured gated run, 26m21s of a
 * 60-minute budget, and every one of those a sequential model turn. Discovery
 * and review can be collapsed into the REPL, but a page's prose has to come out
 * of a model turn, so the only way it gets cheaper is more turns at once.
 *
 * Fanning these out from `eval` costs one orchestrator turn for N pages. What it
 * risks is the thing a wiki is for: an author that sees only its own page cannot
 * describe how its subject relates to anything else. So the split is graph
 * against node. The coordinator owns the inventory, the relationship map, the
 * page paths, quickstart, the link audit and the QA loop - everything that is
 * cross-page by nature and already produced before fan-out. An author owns one
 * page and is handed its edges, so it states its relationships without having
 * read its neighbours.
 *
 * Claims keep the merge honest. An author returns the propositions it
 * established with repo:// evidence rather than prose to be trusted, and the
 * coordinator establishes them through resolve_claims - which means nothing
 * reaches a page's claim set because a subagent asserted it.
 */

import type { SubAgent } from "deepagents";
import {
  createFilesystemMiddleware,
  type AnyBackendProtocol,
  type FsToolName,
} from "deepagents";
import { createOpenWikiCodeInterpreterMiddleware } from "./code-interpreter.js";
import type { OpenWikiCommand, OpenWikiOutputMode } from "./types.js";

/**
 * Filesystem tools an author gets.
 *
 * The reviewers' read/search set plus the two mutating tools, and deliberately
 * not `execute`. Path permissions cannot constrain a shell-capable backend, so
 * the tool surface is where that boundary has to hold - the same reasoning
 * review-subagents.ts applies to reviewers.
 *
 * Confinement to the wiki comes free from the shared backend: `docsOnly` limits
 * writes to the openwiki/ tree and `.openwikiignore` gates every path, so an
 * author cannot touch repository source or read a secret even though it can
 * write. What is NOT enforced is confinement to its own page - deepagents
 * resolves a subagent's permissions once at construction, so a per-assignment
 * path rule is not expressible. Authors are held to their assignment by the
 * coordinator's instruction, and the state backend merges concurrent page
 * writes rather than losing them.
 */
export const AUTHOR_FILESYSTEM_TOOLS = [
  "read_file",
  "ls",
  "glob",
  "grep",
  "write_file",
  "edit_file",
] as const satisfies readonly FsToolName[];

const PAGE_AUTHOR_DESCRIPTION =
  "Writes one assigned wiki page from a supplied evidence brief and relationship edges, then returns the material propositions it established with repo:// evidence. Dispatch these concurrently from eval, one per planned page. Give each call exactly one page path.";

const PAGE_AUTHOR_SYSTEM_PROMPT = `You author exactly one wiki page and report what you established.

Your assignment names one canonical page path, its inventory unit, the evidence paths and symbols to inspect, its focused tests, and its relationship edges. Write that page and nothing else.

Hard constraints:
- Write only the single page path you were assigned. Never create, edit, or delete another page, an index, quickstart, or the plan file. Another author owns each of those concurrently.
- Do not read /openwiki/_plan.md or any other wiki page. Your assignment is complete by construction: if something you need is missing from it, say so in your report rather than going to look for it. The plan is large, every author reading it multiplies that cost, and your neighbours' pages are being written while you work, so what you would read is half-finished.
- Read repository source and tests as evidence, starting from the paths and symbols your assignment names. Never document a secret, credential, token, or .env value.
- Gather evidence through the \`eval\` tool where you can: one call that locates and extracts the passages you need beats a read_file per path, and only what you return enters your context. Extract passages verbatim - names, ordering, conditions, error strings - rather than summarising them, because a proposition you cannot state exactly is one you have not established.
- Prefer grep and targeted reads over reading a large file whole. Everything you read stays in your context for the rest of your turns, so a wide read costs every later step, not just the one that made it.
- Do not invent files, modules, APIs, or behavior. Every material proposition must be supported by source or tests you inspected.

Establish the claims first, then write the page from them:
- Derive the material factual propositions from what you inspected, before drafting prose. Each is one concise atomic proposition with the repo://path or repo://path#symbol evidence that establishes it. Split compound facts rather than collapsing a component into one summary proposition.
- Cover the categories your assignment and the page's subject require: responsibilities, why it exists, ownership and entrypoints, important symbols, dependencies and data flow, invariants and lifecycle ordering, extension points, focused tests and what they prove, validation, schemas, and scope boundaries the evidence supports. A page that established two or three propositions has not read its subject.
- Write the page from that proposition set. Every proposition must appear as explained prose stating the mechanism and the specific names, values, ordering, and conditions a reader needs to act on it. Prose may exceed the claim set where it connects or contextualises, but nothing material should appear on the page without a proposition behind it.
- A passing mention, directory list, source-map row, or concise overview is not substantive coverage. A path or symbol points at evidence; it never substitutes for stating what that evidence says.
- An agent or human should be able to understand this component and its workflows from your page without reading a single line of code outside the wiki.
- State each supplied relationship in the prose that explains it, linking the target page by the path you were given. Do not invent link targets: another author may not have written that page yet, and a guessed path is a broken link.
- Begin the file with OKF v0.1 front matter as your assignment specifies.

Reporting:
- Return every proposition you established, with its evidence, as a single JSON object in your final message: {"page": "...", "propositions": [{"statement": "...", "evidence": ["repo://..."]}], "undocumented": ["..."]}. No prose around it. That return is how they reach the wiki's claim set: the coordinator owns all Claims operations and establishes what you report, so a proposition you leave out of the response is one the wiki cannot later re-verify, however well the prose reads.
- Report any assigned unit you could not document from evidence, and why, rather than writing an unsupported page.`;

/**
 * The author's return contract.
 *
 * Described here rather than attached as `responseFormat`, which cost far more
 * than it bought. Measured locally on two otherwise identical agents: without a
 * responseFormat, turn 1 is cold and every later turn caches ~99%; with one,
 * every turn is cold. In the fan-out run that made page-author the only agent
 * at 0% cache while the coordinator sat at 92%, and it burned 15.9M of the
 * run's 18.1M prompt tokens uncached - 88% of the bill.
 *
 * It was not buying much either: only 3 of 57 authors produced a parsed
 * structuredResponse, while the other 54 returned exactly this shape as JSON in
 * their final message, which the coordinator reads without difficulty. So the
 * schema stays as the documented contract and the field goes.
 */
const PAGE_AUTHOR_SUBAGENT: SubAgent = {
  name: "page-author",
  description: PAGE_AUTHOR_DESCRIPTION,
  systemPrompt: PAGE_AUTHOR_SYSTEM_PROMPT,
};

/**
 * Returns the init-only page authoring subagent.
 *
 * @param command - Current OpenWiki command.
 * @param outputMode - Current output target.
 * @param backend - Shared wiki backend; its docsOnly and ignore rules are what
 *   confine an author to the wiki without a path permission.
 * @returns The author for repository init, otherwise no subagents.
 */
export function resolvePageAuthorSubagents(
  command: OpenWikiCommand,
  outputMode: OpenWikiOutputMode,
  backend: AnyBackendProtocol,
): SubAgent[] {
  if (command !== "init" || outputMode !== "repository") {
    return [];
  }

  // Same-name middleware replaces DeepAgents' default filesystem middleware
  // rather than sitting alongside it, which is what keeps `execute` off the
  // surface instead of merely unused.
  return [
    {
      ...PAGE_AUTHOR_SUBAGENT,
      middleware: [
        ...(PAGE_AUTHOR_SUBAGENT.middleware ?? []),
        // An author reads more of the repository than anyone else in the run -
        // roughly nineteen files each, one turn apiece, every result then carried
        // in its context for the rest of its turns. The REPL lets it gather that
        // evidence in one call and keep only what it quotes. resolve_claims is on
        // the shared PTC list but an author does not hold that tool, and
        // resolveToolList drops names an agent lacks, so it stays coordinator-only.
        createOpenWikiCodeInterpreterMiddleware(),
        createFilesystemMiddleware({
          backend,
          tools: [...AUTHOR_FILESYSTEM_TOOLS],
        }),
      ],
    },
  ];
}
