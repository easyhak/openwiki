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
- Read repository source and tests as evidence. Never document a secret, credential, token, or .env value.
- Do not invent files, modules, APIs, or behavior. Every material proposition must be supported by source or tests you inspected.

Writing the page:
- Explain responsibilities, why the component exists, ownership and entrypoints, important symbols, dependencies and data flow, invariants and lifecycle ordering, extension points, focused tests and what they prove, validation, schemas, and scope boundaries the evidence supports.
- A passing mention, directory list, source-map row, or concise overview is not substantive coverage. A path or symbol points at evidence; it never substitutes for stating what that evidence says.
- An agent or human should be able to understand this component and its workflows from your page without reading a single line of code outside the wiki.
- State each supplied relationship in the prose that explains it, linking the target page by the path you were given. Do not invent link targets: another author may not have written that page yet, and a guessed path is a broken link.
- Begin the file with OKF v0.1 front matter as your assignment specifies.

Reporting:
- Return the material factual propositions you established, each as one concise atomic proposition with its repo://path or repo://path#symbol evidence. Split compound facts rather than returning one summary proposition for the page.
- The coordinator owns every Claims operation. Do not call Claims tools; your returned propositions are how they reach the wiki's claim set.
- Report any assigned unit you could not document from evidence, and why, rather than writing an unsupported page.`;

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
        createFilesystemMiddleware({
          backend,
          tools: [...AUTHOR_FILESYSTEM_TOOLS],
        }),
      ],
    },
  ];
}
