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

const PAGE_AUTHOR_DESCRIPTION = [
  "Writes one assigned wiki page from a supplied evidence brief and relationship edges, and establishes that page's Claims itself with repo:// evidence.",
  "Dispatch concurrently through author_pages, one page per task. It returns a short plain-text note, not JSON: how many claims a page established comes from the claim store rather than from anything it says.",
].join(" ");

const PAGE_AUTHOR_SYSTEM_PROMPT = `You author exactly one wiki page and report what you established.

Your assignment names one canonical page path, its inventory unit, the evidence paths and symbols to inspect, its focused tests, and its relationship edges. Write that page and nothing else.

Hard constraints:
- Write only the single page path you were assigned. Never create, edit, or delete another page, an index, quickstart, or the plan file. Another author owns each of those concurrently.
- Do not read /openwiki/_plan.md or any other wiki page. Your assignment is complete by construction: if something you need is missing from it, say so in your report rather than going to look for it. Your neighbours' pages are being written while you work, so what you would read is half-finished.
- Read repository source and tests as evidence, starting from the paths and symbols your assignment names. Never document a secret, credential, token, or .env value.
- Prefer grep and targeted reads over reading a large file whole.
- Do not invent files, modules, APIs, or behavior. Every material proposition must be supported by source or tests you inspected.

Establish the claims first, then write the page from them:
- Derive the material factual propositions from what you inspected, before drafting prose. Each is one concise atomic proposition with the repo://path or repo://path#symbol evidence that establishes it. Split compound facts rather than collapsing a component into one summary proposition.
- Cover the categories your assignment and the page's subject require: responsibilities, why it exists, ownership and entrypoints, important symbols, dependencies and data flow, invariants and lifecycle ordering, extension points, focused tests and what they prove, validation, schemas, and scope boundaries the evidence supports.
- Four of those a reader cannot do without, because they are what someone about to change this component opens the page for, so make sure your set answers all four and does not merely touch them: what it is responsible for and deliberately is not; where it lives, down to packages, files, and named entrypoints; what crosses its boundary in each direction, including the data or contract that passes; and how someone would check they had not broken it. These are a floor beneath the categories above, not a replacement for them.
- Name the thing rather than the category. "Covered by unit tests" establishes nothing; "TestQueueRunPayload proves an empty hash_key is rejected before any Redis write" establishes something a reader can act on. The same goes for "depends on the database" against the named client and the table it writes.
- A substantial component's page establishes several dozen propositions, because that is how many separable facts its evidence contains. Under ten means the evidence was not read rather than that the subject was small - and a page whose subject really is small says so, in a proposition, rather than being quietly thin.
- Write the page from that proposition set. Every proposition must appear as explained prose stating the mechanism and the specific names, values, ordering, and conditions a reader needs to act on it. Prose may exceed the claim set where it connects or contextualises, but nothing material should appear on the page without a proposition behind it.
- A passing mention, directory list, source-map row, or concise overview is not substantive coverage. A path or symbol points at evidence; it never substitutes for stating what that evidence says.
- An agent or human should be able to understand this component and its workflows from your page without reading a single line of code outside the wiki.
- State each supplied relationship in the prose that explains it, linking the target page by the path you were given. Do not invent link targets: another author may not have written that page yet, and a guessed path is a broken link.
- Begin the file with OKF v0.1 front matter as your assignment specifies.

Establish your claims yourself, with resolve_claims:
- Call it for your page with the propositions you derived. You own your page's claim set; nobody establishes it on your behalf, and a proposition you never establish is one the wiki cannot re-verify however well the prose reads.
- Evidence is \`repo://path\` or \`repo://path#symbol\`, and nothing else. No line ranges, no directories, no trailing slash. A symbol must be one the file actually declares - if you are unsure a name resolves, cite the file.
- If it rejects a resource, that is a fact about your evidence and you have the file open: cite the symbol the file really declares, or cite the file. Do not abandon the claim.
- Establish in batches rather than one call per proposition, and do it as you go rather than saving it for the end, so a page that runs long still has grounded claims.

Reporting:
- Finish with a short plain-text note: what you wrote, and any assigned area you could not document from evidence and why. It is read by a person, not parsed, so do not wrap it in JSON.
- Report an area you could not document rather than writing an unsupported page.`;

/**
 * The author establishes its own claims.
 *
 * It had returned them instead, for the coordinator to establish. That put a
 * page's forty-odd propositions through a JSON return contract, a parser, and a
 * pool, and every one of those seams broke at least once: a schema that never
 * bound, a payload too large for a tool result, a relative page path the claim
 * store refused, and one unresolvable symbol atomically discarding a whole
 * page's claims. In one graded run 65 of 90 pages established nothing.
 *
 * The author already had resolve_claims - subagents inherit the parent's tools -
 * and was being told not to use it. It is also the only participant that can
 * actually repair bad evidence, because it has the file open: a coordinator
 * downstream can only degrade a rejected `#symbol` to its file and hope.
 *
 * Counts come from the claim session afterwards rather than from the author's
 * report, so there is nothing to parse and nothing that can disagree with the
 * store.
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
        createFilesystemMiddleware({
          backend,
          tools: [...AUTHOR_FILESYSTEM_TOOLS],
        }),
      ],
    },
  ];
}
