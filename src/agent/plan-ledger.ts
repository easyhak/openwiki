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
 * And finishing is a gate rather than an instruction. A run once planned 62
 * pages, dispatched 41 authors, wrote 33 pages, and reported success, because
 * reconciliation was a numbered step in a workflow and an instruction cannot
 * refuse to finish.
 *
 * The gate is a floor, never a target. Its job is to catch a plan that has
 * collapsed - one page standing in for a subsystem - not to push a plan towards
 * any particular size. A wiki wide enough to have a page per subsystem is wide
 * enough; beyond that, more pages are a judgement for the planner, not this.
 */

import { tool } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import { z } from "zod";
import {
  type ContractCandidate,
  sharedContracts,
} from "./concept-discovery.js";
import {
  collectDirectoryTree,
  collectPlanningView,
  findUncoveredDirectories,
  type ListingBackend,
} from "./repo-inventory.js";
import {
  type ContractEntry,
  canonicalWikiPage,
  missingEvidence,
  type PlanEntry,
  type PlannedPage,
  type PlanStore,
} from "./plan-store.js";
import { qaFinalizationProblem, type QaGate } from "./wiki-verification.js";

/**
 * What a directory's documentation disposition is.
 *
 * The previous shape - `pages: []` with an optional reason - made "no page" an
 * obscure edge of the schema, and a graded run took the hint: not one of 59
 * entries used it. Every directory got a page manufactured for it, including
 * /secrets.example, /test_data, and three personal scratch trees under
 * /experimental, each consuming an author that a real subsystem needed.
 *
 * Making the three outcomes peers fixes the incentive. Not documenting a
 * directory is a normal, first-class answer, and saying so costs a reason
 * rather than an apology.
 */
const PlannedPageSchema = z
  .object({
    path: z.string().min(1),
    responsibility: z.string().min(1).describe("One line: what this owns."),
    entrypoint: z
      .string()
      .min(1)
      .describe("The named symbol or file a reader starts from."),
    sources: z
      .array(z.string().min(1))
      .min(1)
      .describe("Implementation paths and symbols, not directories."),
    tests: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Focused tests and the command that runs them - the Make target or CI job, not just the file.",
      ),
    edges: z
      .array(
        z.object({
          page: z.string().min(1),
          relationship: z
            .string()
            .min(1)
            .describe("What crosses the boundary, in which direction."),
        }),
      )
      .default([]),
  })
  .strict();

const EntrySchema = z.discriminatedUnion("disposition", [
  z
    .object({
      disposition: z.literal("document"),
      directory: z.string().min(1),
      pages: z.array(PlannedPageSchema).min(1),
    })
    .strict(),
  z
    .object({
      disposition: z.literal("covered_by"),
      directory: z.string().min(1),
      page: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      disposition: z.literal("exclude"),
      directory: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),
]);

/** Shape a contract entry must have before it can be recorded. */
const ContractInputSchema = z.union([
  z.object({
    contract: z.string().min(1),
    participants: z.array(z.string().min(1)).min(2),
    page: PlannedPageSchema,
  }),
  z.object({
    contract: z.string().min(1),
    excluded: z.literal(true),
    reason: z.string().min(20),
  }),
]);

const SubmitPlanSchema = z.object({
  entries: z.array(EntrySchema).min(1).optional(),
  contracts: z.array(ContractInputSchema).optional(),
});

/**
 * What the model is asked for, loose enough that this code sees the mistake.
 *
 * The strict schema was declared on the tool, so LangChain rejected a malformed
 * payload before the handler ran and the model saw only "Error invoking tool
 * submit_plan with kwargs {...}" - no path, no reason. A run hit it three times
 * with the same mistake, nested an entry object inside another entry's `pages`
 * array, and gave up: its plan froze at 19 pages while two attempts to grow it
 * to 24 and 18 died unexplained. Every other tool here returns readable
 * problems; this one could not, because nothing of ours executed.
 *
 * So the declared schema accepts any object and the strict one runs inside,
 * where a failure becomes a message naming the path that broke.
 */
/** Contracts listed in one call, so the list informs the plan without crowding it. */
const CONTRACTS_SHOWN = 60;

const SubmitPlanInputSchema = z.object({
  entries: z.array(z.record(z.string(), z.unknown())).min(1).optional(),
  contracts: z.array(z.record(z.string(), z.unknown())).optional(),
});

/**
 * Formats a schema failure as something a model can act on.
 *
 * @param error - The Zod failure.
 * @param entries - The payload as supplied, for shape-specific hints.
 * @returns Problem strings naming the path and the likely mistake.
 */
function describeSchemaFailure(
  error: z.ZodError,
  entries: Record<string, unknown>[],
): string[] {
  const problems = error.issues.slice(0, 12).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "entries";
    return `${path}: ${issue.message}`;
  });
  // One mistake is worth naming outright, because two nested arrays of objects
  // invite it and the generic message does not point at it.
  for (const [index, entry] of entries.entries()) {
    const pages = (entry as { pages?: unknown }).pages;
    if (!Array.isArray(pages)) {
      continue;
    }
    for (const [pageIndex, page] of pages.entries()) {
      if (
        page !== null &&
        typeof page === "object" &&
        ("disposition" in page || "directory" in page)
      ) {
        problems.push(
          `entries.${index}.pages.${pageIndex} looks like an entry rather than a page: it has a disposition or directory. Move it out into its own top-level entry.`,
        );
      }
    }
  }
  return problems;
}

/**
 * Normalizes a page path to exactly one wiki-root prefix.
 *
 * finalize_wiki compares plan paths against a walk of the wiki tree, and the
 * two sources spell the same page differently: a plan may say
 * `architecture/overview.md` where the walk yields
 * `openwiki/architecture/overview.md`. Comparing them unnormalized matches
 * nothing, which reads as every planned page being missing. Both sides
 * normalize through here.
 *
 * @param page - Page path as planned or as found on disk.
 * @param wikiRoot - Directory generated pages live under.
 * @returns Path rooted at the wiki directory, without a leading slash.
 */
export function normalizeWikiPage(page: string, wikiRoot = "/openwiki"): string {
  const root = wikiRoot.replace(/^\/+/u, "").replace(/\/+$/u, "");
  const bare = page.replace(/^\/+/u, "");
  return bare === root || bare.startsWith(`${root}/`) ? bare : `${root}/${bare}`;
}

/**
 * Validates a ledger against the directories that must be accounted for.
 *
 * @param entries - Plan entries, one per surveyed directory.
 * @param targets - Every survey target's path.
 * @returns Human-readable rejections, empty when the ledger is acceptable.
 */
export function validateEntry(
  entry: PlanEntry,
  tree: readonly string[],
): string[] {
  const problems: string[] = [];
  if (!tree.includes(entry.directory)) {
    // A directory not in the tree is a typo, and a typo can leave the directory
    // it meant uncovered while looking like it was planned.
    problems.push(
      `${entry.directory}: not a directory list_repository_directories returned`,
    );
  }
  if (entry.disposition === "document") {
    for (const page of entry.pages) {
      const missing = missingEvidence(page);
      if (missing.length > 0) {
        // An author is sent nothing but this, so a page without an anchor, an
        // entrypoint, or a focused test writes only what it can see.
        problems.push(`${page.path}: missing ${missing.join(", ")}`);
      }
    }
  }
  return problems;
}

/**
 * Reports why the plan as a whole is not ready to author from.
 *
 * Separate from per-entry validity because the plan is built up over several
 * calls: an incomplete plan is a plan in progress, not a rejected one.
 *
 * @param entries - Every recorded entry.
 * @param uncovered - Directories no entry covers.
 * @returns Problems that must clear before authoring.
 */
export function validatePlanShape(
  entries: PlanEntry[],
  uncovered: readonly string[],
  tree: readonly string[] = [],
  sourceFiles: ReadonlyMap<string, number> = new Map(),
): string[] {
  return [
    ...blockingProblems(entries, uncovered),
    ...advisoryProblems(entries, tree, sourceFiles),
  ];
}

/**
 * Problems that must clear before authoring, because they mean the wiki would
 * be wrong rather than merely coarse.
 *
 * An uncovered directory is a subtree nobody planned, which is invisible in the
 * result. A dangling page reference is an author told to link somewhere that
 * will never exist.
 *
 * @param entries - Every recorded entry.
 * @param uncovered - Directories no entry covers.
 * @returns Blocking problems.
 */
export function blockingProblems(
  entries: PlanEntry[],
  uncovered: readonly string[],
): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string>();
  for (const entry of entries) {
    if (entry.disposition !== "document") {
      continue;
    }
    for (const page of entry.pages) {
      const key = canonicalWikiPage(page.path);
      const owner = owners.get(key);
      if (owner && owner !== entry.directory) {
        // Two entries owning one page is two authors racing on one write.
        problems.push(`${key} is owned by both ${owner} and ${entry.directory}`);
      }
      owners.set(key, entry.directory);
    }
  }
  for (const entry of entries) {
    if (entry.disposition === "covered_by") {
      if (!owners.has(canonicalWikiPage(entry.page))) {
        problems.push(
          `${entry.directory} is covered_by ${entry.page}, which no entry documents`,
        );
      }
    }
    if (entry.disposition === "document") {
      for (const page of entry.pages) {
        for (const edge of page.edges) {
          if (!owners.has(canonicalWikiPage(edge.page))) {
            problems.push(
              `${page.path} has an edge to ${edge.page}, which no entry documents`,
            );
          }
        }
      }
    }
  }

  if (uncovered.length > 0) {
    problems.push(
      `${uncovered.length} director(ies) covered by no entry: ${uncovered.slice(0, 20).join(", ")}${uncovered.length > 20 ? ", ..." : ""}`,
    );
  }
  return problems;
}

/**
 * Documentable source files one page is expected to be able to describe.
 *
 * The unit is files rather than directories because a directory is not a unit of
 * information: the median directory in a monorepo holds a handful of files and
 * the largest holds hundreds, so a directory count describes nesting convention
 * rather than how much there is to write. Counting is free - the walk already
 * lists files alongside directories.
 *
 * The value is the one judgement left in this rule. Repository structure cannot
 * supply it: subdividing the tree to coherent units fragments to roughly a dozen
 * files per unit, far finer than a readable wiki, so the number comes from what a
 * page can usefully say rather than from the tree.
 */
const SOURCE_FILES_PER_PAGE = 100;

/**
 * Pages any documented area has.
 *
 * One, definitionally: an area that is documented has a page. Every page past the
 * first is earned by volume. A floor of two asks a four-file module for two pages
 * while asking a two-hundred-file service for the same two.
 */
const MIN_PAGES_PER_AREA = 1;

/**
 * Problems worth telling the planner about that must not stop it authoring.
 *
 * Decomposition and proportion are quality: a coarse plan writes a worse wiki,
 * not a wrong one. Making them blocking once cost a run everything - a
 * coordinator built a large, healthy plan, then authoring refused it over
 * "/smith-go holds 165 directories and plans one page", it answered by adding
 * deeper entries instead of a second page, and the run finished with a single
 * page on disk. The remedy it chose was one the message offered and one that
 * never terminates.
 *
 * A nudge that can zero a run is not a nudge. These are reported and the run
 * proceeds.
 *
 * @param entries - Every recorded entry.
 * @param tree - Every directory, for measuring decomposition.
 * @returns Advisory problems.
 */
export function advisoryProblems(
  entries: PlanEntry[],
  tree: readonly string[] = [],
  sourceFiles: ReadonlyMap<string, number> = new Map(),
  sourceFilesPerPage: number = SOURCE_FILES_PER_PAGE,
): string[] {
  const problems: string[] = [];
  const documented = entries.filter(
    (entry) => entry.disposition === "document",
  ).length;
  if (entries.length >= 8 && documented * 2 < entries.length) {
    problems.push(
      `Only ${documented} of ${entries.length} areas are documented; most areas of a repository need a page of their own.`,
    );
  }
  const absorbed = new Map<string, number>();
  for (const entry of entries) {
    if (entry.disposition === "covered_by") {
      const key = canonicalWikiPage(entry.page);
      absorbed.set(key, (absorbed.get(key) ?? 0) + 1);
    }
  }
  for (const [page, count] of absorbed) {
    if (count > 3) {
      problems.push(
        `${count} areas are covered_by ${page}; one page cannot document that many`,
      );
    }
  }

  // Under-decomposition, measured against the repository rather than against a
  // page target. One page cannot describe a subtree of independent subsystems:
  // it can name them, but it cannot say what each is responsible for. An area
  // holding several directories of its own that no deeper entry claims is
  // several pages, and the count comes from the tree rather than from a
  // constant chosen here.
  const claimed = entries.map((entry) => entry.directory);
  for (const entry of entries) {
    if (entry.disposition !== "document") {
      continue;
    }
    // "/" as a prefix, not "//": the root entry's descendants are every rooted
    // path, and building the prefix by concatenation made none of them match, so
    // the root subtracted nothing and appeared to own the whole repository.
    const prefix =
      entry.directory === "/" ? "/" : `${entry.directory}/`;
    const beneath = tree.filter(
      (directory) =>
        directory.startsWith(prefix) &&
        !claimed.some(
          (other) =>
            other !== entry.directory &&
            (directory === other || directory.startsWith(`${other}/`)),
        ),
    );
    // One page per area, plus one per SOURCE_FILES_PER_PAGE files it still owns.
    // Volume rather than directory count, so the requirement tracks how much
    // there is to write instead of how deeply the repository is nested, and the
    // comparison runs at every page count: an area holding six pages' worth of
    // source is under-documented at two pages as surely as at one.
    //
    // What an area "still owns" excludes anything a deeper entry claimed, so
    // naming sub-areas is always a way to satisfy this rather than a way to
    // multiply the requirement. MAX_BLOCKED_ATTEMPTS bounds what the rule can
    // cost a run whose coordinator will not satisfy it.
    // Counts are subtree totals, so this subtracts rather than sums: the area's
    // own total, less the total of each deeper entry that claimed part of it.
    // Only the outermost claimed descendants are subtracted, since a subtree
    // total already includes anything nested inside it.
    const claimedBeneath = claimed.filter(
      (other) => other !== entry.directory && other.startsWith(prefix),
    );
    const outermost = claimedBeneath.filter(
      (other) =>
        !claimedBeneath.some(
          (nearer) => nearer !== other && other.startsWith(`${nearer}/`),
        ),
    );
    const volume = Math.max(
      0,
      outermost.reduce(
        (total, other) => total - (sourceFiles.get(other) ?? 0),
        sourceFiles.get(entry.directory) ?? 0,
      ),
    );
    const required = Math.max(
      MIN_PAGES_PER_AREA,
      Math.ceil(volume / sourceFilesPerPage),
    );
    if (entry.pages.length < required) {
      problems.push(
        `${entry.directory} plans ${entry.pages.length} page(s) for ${volume} source files across ${beneath.length} directories it still owns, and needs at least ${required}. ${beneath.length === 0 ? "It owns no subdirectories, so name more pages on this entry: one per independently registered route family, distinct store, or subsystem inside it." : "Add pages to this entry - one each for the independently registered route families, distinct stores, and subsystems that run on their own inside it. Naming deeper entries also works, but only once they claim the subtree, which is the long way round."}`,
      );
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
export function renderPlanMarkdown(
  entries: PlanEntry[],
  contracts: ContractEntry[] = [],
): string {
  const counts = { document: 0, covered_by: 0, exclude: 0 };
  for (const entry of entries) {
    counts[entry.disposition] += 1;
  }
  const pages = entries.flatMap((entry) =>
    entry.disposition === "document" ? entry.pages : [],
  );
  return [
    "# Plan",
    "",
    `${entries.length} directories: ${counts.document} documented, ${counts.covered_by} covered elsewhere, ${counts.exclude} excluded. ${pages.length} pages.`,
    "",
    "| Page | Responsibility | Entrypoint | Tests | Relates to |",
    "| --- | --- | --- | --- | --- |",
    ...pages.map(
      (page) =>
        `| ${page.path} | ${page.responsibility} | ${page.entrypoint} | ${page.tests.join("<br>")} | ${page.edges.map((edge) => edge.page).join("<br>") || "-"} |`,
    ),
    "",
    "| Directory | Disposition | Note |",
    "| --- | --- | --- |",
    ...entries
      .filter((entry) => entry.disposition !== "document")
      .map(
        (entry) =>
          `| ${entry.directory} | ${entry.disposition} | ${"reason" in entry ? entry.reason : ""} |`,
      ),
    ...(contracts.length > 0
      ? [
          "",
          `${contracts.length} contract(s) between areas.`,
          "",
          "| Contract | Participants | Page or reason |",
          "| --- | --- | --- |",
          ...contracts.map((contract) =>
            "page" in contract
              ? `| ${contract.contract} | ${contract.participants.join(", ")} | ${contract.page.path} |`
              : `| ${contract.contract} | - | excluded: ${contract.reason} |`,
          ),
        ]
      : []),
    "",
  ].join("\n");
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
/**
 * Reports why the recorded plan cannot be authored from yet.
 *
 * Shared with the authoring pool: submit_plan accumulates and no longer rejects
 * an incomplete plan, so the completeness requirement has to bite where pages
 * are actually dispatched.
 *
 * @param store - Shared plan store.
 * @param backend - Repository backend, for the coverage walk.
 * @returns Blocking problems, empty when the plan is authorable.
 */
export async function planReadiness(
  store: PlanStore,
  backend: LedgerBackend,
  candidates?: () => Promise<ContractCandidate[]>,
): Promise<{ blocking: string[]; shortfall: string[] }> {
  const entries = store.get()?.entries ?? [];
  if (entries.length === 0) {
    return { blocking: ["No plan recorded; call submit_plan first."], shortfall: [] };
  }
  const uncovered = await findUncoveredDirectories(
    backend,
    entries.map((entry) => entry.directory),
  );
  // Two classes, and the difference is whether the wiki comes out wrong or
  // merely coarse. A directory no entry covers is wrong: that subtree is absent
  // from the result and nothing downstream can tell. A thin plan is coarse, and
  // refusing to author over it is what once left a run with a complete plan and
  // one page on disk, so it travels back as a shortfall instead.
  const view = await collectPlanningView(backend);
  const ledger = store.get();
  return {
    blocking: [
      ...blockingProblems(entries, uncovered),
      ...(candidates
        ? undisposedContracts(
            await candidates(),
            ledger?.contracts ?? [],
            CONTRACTS_SHOWN,
          )
        : []),
    ],
    shortfall: advisoryProblems(entries, view.directories, view.sourceFiles),
  };
}

/**
 * Checks one contract entry against what the repository actually shows.
 *
 * A contract is only recordable if discovery found it, because the point of the
 * unit is to answer evidence rather than to invent subjects: a plan could
 * otherwise clear its contract report by naming contracts nothing shows.
 *
 * A documented contract must also cite both sides. A page whose sources all sit
 * in one participant is a page about that participant, and the fact it was
 * supposed to carry - which side owns the state - is exactly what it will omit.
 *
 * @param entry - Candidate contract entry.
 * @param known - Discovered candidates, by name.
 * @returns Problems, empty when the entry is recordable.
 */
export function validateContract(
  entry: ContractEntry,
  known: Map<string, ContractCandidate>,
): string[] {
  const candidate = known.get(entry.contract);
  if (!candidate) {
    return [
      `${entry.contract} is not a contract the repository shows. Use a name from list_shared_contracts, or drop it.`,
    ];
  }
  if ("excluded" in entry) {
    return [];
  }
  const problems: string[] = [];
  const parties = new Set(candidate.areas);
  const cited = new Set<string>();
  for (const source of entry.page.sources) {
    const bare = source.replace(/^\/+/u, "").split("#")[0] ?? "";
    for (const party of parties) {
      if (party && (bare === party || bare.startsWith(`${party}/`))) {
        cited.add(party);
      }
    }
  }
  if (cited.size < 2) {
    problems.push(
      `${entry.contract} cites ${cited.size === 0 ? "no participant" : `only ${[...cited][0]}`}. A contract page needs an anchor in at least two of ${[...parties].join(", ")}, or it documents one side and omits the contract.`,
    );
  }
  if (!entry.page.responsibility.trim()) {
    problems.push(`${entry.contract} needs a responsibility naming which side is authoritative.`);
  }
  return problems;
}

/**
 * Contracts the plan must dispose of before authoring.
 *
 * Completeness rather than size: what has to be settled is that every contract
 * the agent was shown has an answer, not that the wiki reaches any particular
 * number of pages. An answer is a page or a reason, and a reason is one call for
 * as many contracts as the coordinator wants to exclude at once.
 *
 * Bounded to what list_shared_contracts shows, because a coordinator cannot
 * dispose of a contract it was never given, and an unanswerable precondition on
 * authoring costs the whole wiki rather than the pages it wanted.
 *
 * @param candidates - Everything discovery found, sharpest first.
 * @param contracts - What the plan has recorded.
 * @param shown - How many of the candidates the listing tool reveals.
 * @returns One problem naming what is undisposed, or nothing.
 */
export function undisposedContracts(
  candidates: ContractCandidate[],
  contracts: ContractEntry[],
  shown: number,
): string[] {
  const answered = new Set(contracts.map((entry) => entry.contract));
  const sharp = candidates
    .filter(
      (candidate) =>
        candidate.kind === "parallel-impl" ||
        (candidate.writers?.length ?? 0) > 1,
    )
    .slice(0, shown);
  const missing = sharp.filter((candidate) => !answered.has(candidate.name));
  if (missing.length === 0) {
    return [];
  }
  const named = missing.slice(0, 20).map((candidate) => candidate.name);
  return [
    `${missing.length} of ${sharp.length} contracts from list_shared_contracts have no disposition: ${named.join(", ")}${missing.length > named.length ? ", ..." : ""}. Each needs a page whose sources cite two participants, or {"contract":"<name>","excluded":true,"reason":"..."}. Several exclusions can go in one submit_plan call.`,
  ];
}

/**
 * Reports contracts the repository shows and the plan has not answered.
 *
 * Advisory: a coordinator that ignores it writes a wiki missing those facts,
 * which is worse than the wiki it writes today but not nothing, and refusing to
 * author over it is how a run ends with no wiki at all.
 *
 * @param candidates - Everything discovery found.
 * @param contracts - What the plan has recorded.
 * @param limit - Most to report at once.
 * @returns Names and participants of the sharpest unanswered contracts.
 */
export function unhomedContracts(
  candidates: ContractCandidate[],
  contracts: ContractEntry[],
  limit = 12,
): string[] {
  const answered = new Set(contracts.map((entry) => entry.contract));
  return candidates
    .filter(
      (candidate) =>
        !answered.has(candidate.name) &&
        (candidate.kind === "parallel-impl" ||
          (candidate.writers?.length ?? 0) > 1),
    )
    .slice(0, limit)
    .map(
      (candidate) =>
        `${candidate.name} (${candidate.signal}; ${candidate.areas.filter(Boolean).join(", ")})`,
    );
}

export function createOpenWikiPlanLedgerMiddleware(
  backend: LedgerBackend,
  store: PlanStore,
  qaGate?: QaGate,
  wikiRoot = "/openwiki",
  repositoryRoot?: string,
) {
  // Discovered once. It is a pure function of the tree and costs seconds, but
  // submit_plan is called many times over a planning phase.
  const contractCandidates = async (): Promise<ContractCandidate[]> =>
    repositoryRoot ? sharedContracts(repositoryRoot) : [];
  const setLedger = async (entries: PlanEntry[], contracts: ContractEntry[]) => {
    // Keyed by normalized path, because the brief renderer and the completion
    // gate both look pages up and the plan spells them inconsistently.
    const pages = new Map<string, PlannedPage>();
    for (const entry of entries) {
      if (entry.disposition !== "document") {
        continue;
      }
      for (const page of entry.pages) {
        pages.set(canonicalWikiPage(page.path), page);
      }
    }
    // Contract pages join the same map: they are dispatched by the same pool and
    // checked by the same completion gate. Only the plan's shape differs.
    for (const contract of contracts) {
      if ("page" in contract) {
        pages.set(canonicalWikiPage(contract.page.path), contract.page);
      }
    }
    store.set({ entries, contracts, pages });
    const written = await backend.write(
      `${wikiRoot}/_plan.md`,
      renderPlanMarkdown(entries, contracts),
    );
    return { plannedPages: [...pages.keys()], planWritten: !written.error };
  };

  const listDirectories = tool(
    async () => {
      const tree = await collectDirectoryTree(backend);
      return JSON.stringify({ directories: tree.length, tree });
    },
    {
      name: "list_repository_directories",
      description:
        "List the repository's directories for planning, three levels deep, with test, vendor, and build directories already excluded. Coverage is not limited to what this shows: submit_plan checks the whole tree to any depth, and an entry covers everything beneath it, so a directory deeper than this listing is covered by whichever entry contains it.",
      schema: z.object({}),
    },
  );

  const listContracts = tool(
    async ({ kind }) => {
      const all = await contractCandidates();
      const filtered = kind ? all.filter((one) => one.kind === kind) : all;
      // Bounded: the whole set would crowd out the plan it is meant to inform.
      // The totals are reported so what is omitted is visible rather than
      // implied.
      const shown = filtered.slice(0, CONTRACTS_SHOWN);
      return JSON.stringify({
        found: all.length,
        shown: shown.length,
        byKind: all.reduce<Record<string, number>>((counts, one) => {
          counts[one.kind] = (counts[one.kind] ?? 0) + 1;
          return counts;
        }, {}),
        contracts: shown.map((one) => ({
          contract: one.name,
          kind: one.kind,
          signal: one.signal,
          participants: one.areas.filter(Boolean),
          ...(one.writers ? { writers: one.writers.filter(Boolean) } : {}),
          ...(one.consumers?.length
            ? { readOnly: one.consumers.filter(Boolean) }
            : {}),
          evidence: one.evidence,
          ...(one.tests.length > 0 ? { tests: one.tests } : {}),
        })),
      });
    },
    {
      name: "list_shared_contracts",
      description: [
        "List the contracts between areas that this repository shows: a table several areas write, one route implemented in two languages, an area importing another.",
        "These are facts about two areas, so no page about one area holds them - which is why they are the facts a wiki organised by directory misses. Each one either gets a page of its own, recorded through submit_plan's `contracts`, or gets an explicit exclusion saying why it needs none.",
        "A contract page has to cite both sides: its sources must anchor in at least two participants, or it documents one of them and omits the contract. `writers` is the sharp part - when two areas write one table, say which is authoritative and what the other is doing.",
        "Evidence and tests come with each contract, so its page does not need to be discovered again. Pass `kind` to see more of one class.",
      ].join(" "),
      schema: z.object({
        kind: z
          .enum(["divided-state", "parallel-impl", "cross-area-import"])
          .optional(),
      }),
    },
  );

  const submitPlan = tool(
    async (rawInput) => {
      const loose = SubmitPlanInputSchema.parse(rawInput);
      const parsed = SubmitPlanSchema.safeParse(rawInput);
      if (!parsed.success) {
        return JSON.stringify({
          accepted: false,
          problems: describeSchemaFailure(parsed.error, loose.entries ?? []),
        });
      }
      if (!parsed.data.entries?.length && !parsed.data.contracts?.length) {
        return JSON.stringify({
          accepted: false,
          problems: ["Send entries, contracts, or both."],
        });
      }

      // Merge, never replace. Submitting the whole plan at once meant forty
      // pages of evidence in one call where any single error discarded all of
      // it, and a coordinator that hit five rejections in a row stopped trying
      // to satisfy it: one run collapsed to a single root entry, another
      // deferred 37 of 38 areas to one page and authored three. Accumulating
      // lets a page's evidence be paid for once and kept.
      const merged = new Map<string, PlanEntry>();
      const previous = new Map<string, PlanEntry>();
      for (const entry of store.get()?.entries ?? []) {
        merged.set(entry.directory, entry);
        previous.set(entry.directory, entry);
      }
      // The same view the authoring gate uses. Validating here without the source
      // counts made submit_plan blind to exactly what author_pages would refuse:
      // volume read as zero, every area passed, and the coordinator was told its
      // plan was accepted with nothing pending.
      const view = await collectPlanningView(backend);
      const tree = view.directories;
      const rejected: string[] = [];
      for (const entry of parsed.data.entries ?? []) {
        const problems = validateEntry(entry, tree);
        if (problems.length > 0) {
          rejected.push(...problems);
          continue;
        }
        merged.set(entry.directory, entry);
      }

      // Replacing an entry for a directory it already had is how the plan is
      // corrected, but it silently drops pages the previous version carried, and
      // a coordinator resubmitting one directory to add pages lost the page every
      // other entry had edges to. Dropped pages are reported rather than kept,
      // since removing one is also legitimate.
      const dropped: string[] = [];
      for (const entry of parsed.data.entries ?? []) {
        const before = previous.get(entry.directory);
        if (!before || before.disposition !== "document") continue;
        const after = merged.get(entry.directory);
        if (!after || after.disposition !== "document") continue;
        const keptPaths = new Set(
          after.pages.map((planned) => canonicalWikiPage(planned.path)),
        );
        for (const planned of before.pages) {
          const path = canonicalWikiPage(planned.path);
          if (!keptPaths.has(path)) dropped.push(path);
        }
      }

      // Contracts merge by name the same way entries merge by directory.
      const candidates = await contractCandidates();
      const known = new Map(candidates.map((one) => [one.name, one]));
      const mergedContracts = new Map<string, ContractEntry>();
      for (const contract of store.get()?.contracts ?? []) {
        mergedContracts.set(contract.contract, contract);
      }
      const rejectedContracts: string[] = [];
      for (const contract of parsed.data.contracts ?? []) {
        const problems = validateContract(contract as ContractEntry, known);
        if (problems.length > 0) {
          rejectedContracts.push(...problems);
          continue;
        }
        mergedContracts.set(contract.contract, contract as ContractEntry);
      }
      const contracts = [...mergedContracts.values()];

      const entries = [...merged.values()];
      const uncovered = await findUncoveredDirectories(
        backend,
        entries.map((entry) => entry.directory),
      );
      const blocking = [
        ...blockingProblems(entries, uncovered),
        ...undisposedContracts(candidates, contracts, CONTRACTS_SHOWN),
      ];
      const shortfall = advisoryProblems(entries, tree, view.sourceFiles);
      await setLedger(entries, contracts);
      const documented = entries.filter(
        (entry) => entry.disposition === "document",
      ).length;
      return JSON.stringify({
        accepted: rejected.length === 0,
        recorded: entries.length,
        documented,
        plannedPages: store.get()?.pages.size ?? 0,
        ...(rejected.length > 0 ? { rejectedEntries: rejected } : {}),
        ...(candidates.length > 0
          ? {
              contractsRecorded: contracts.length,
              contractsFound: candidates.length,
            }
          : {}),
        ...(rejectedContracts.length > 0
          ? { rejectedContracts }
          : {}),
        ...(unhomedContracts(candidates, contracts).length > 0
          ? { contractsUnanswered: unhomedContracts(candidates, contracts) }
          : {}),
        // Two classes, named for what they cost. `blocking` stops authoring
        // until it clears; `shortfall` does not, and telling the coordinator
        // otherwise made it spend a run satisfying a floor that would have let
        // it through.
        ...(dropped.length > 0
          ? {
              pagesDropped: dropped,
              pagesDroppedNote:
                "An entry replaces the whole previous entry for its directory, so these pages are no longer planned. If that was not deliberate, resubmit the entry with them included - anything with an edge to them is now dangling.",
            }
          : {}),
        ...(blocking.length > 0 ? { blocking } : {}),
        ...(shortfall.length > 0 ? { shortfall } : {}),
      });
    },
    {
      name: "submit_plan",
      description: [
        "Record part or all of the plan. Calls accumulate: an entry replaces the one for the same directory and everything else is kept, so build the plan up a few areas at a time rather than sending it whole. An entry that is individually invalid is rejected by itself and the rest are still recorded.",
        "Every directory from list_repository_directories must be covered before you can author, and entries may nest - a directory belongs to its deepest entry. An entry on / covers only the repository's own files.",
        "An entry is one of three shapes, and nothing else:",
        '  {"disposition":"document","directory":"/smith-go","pages":[<page>, ...]}',
        '  {"disposition":"covered_by","directory":"/supabase","page":"openwiki/operations/local-stack.md","reason":"..."}',
        '  {"disposition":"exclude","directory":"/test_data","reason":"..."}',
        "A page inside a document entry is:",
        '  {"path":"openwiki/services/go-api.md","responsibility":"one line","entrypoint":"smith-go/main.go#main","sources":["smith-go/api/routes.go#Register"],"tests":["smith-go/api/routes_test.go - make test-dir DIR=api"],"edges":[{"page":"openwiki/data/postgres.md","relationship":"writes runs through it"}]}',
        "Pages carry evidence because their author is sent nothing else: an implementation anchor and symbol rather than a directory, the focused tests plus the command that runs them, and an edge per relationship saying what crosses the boundary in which direction. Never put an entry object inside a pages array.",
        "Most areas of a repository need a page of their own. Excluding suits fixtures, test data, generated output, and scratch; CI and release workflows, deployment definitions, migrations, schedulers, data stores, and configuration a reader needs are documented or covered_by. covered_by is for an area genuinely documented on another page, not a way to avoid writing one, and one page cannot absorb more than a few areas. A large area is several pages: one each for independently registered route families, distinct data models or stores, and subsystems that run on their own.",
        "The response separates two things. `blocking` stops author_pages until it clears - a directory no entry covers, or a page reference that resolves to nothing. `shortfall` does not stop anything: it reports areas whose planned pages look thin for the source they hold, and authoring proceeds either way, so treat it as a prompt to plan better rather than a barrier to clear. Never invent placeholder pages to satisfy it; a page that documents nothing is worse than an area that is thin.",
        "/openwiki/_plan.md is rendered from what is recorded, so do not write or parse it.",
      ].join(" "),
      schema: SubmitPlanInputSchema,
    },
  );

  const finalizeWiki = tool(
    async () => {
      const ledger = store.get();
      if (!ledger) {
        return JSON.stringify({
          complete: false,
          problems: ["No plan exists; call submit_plan before finishing."],
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
            existing.add(canonicalWikiPage(file.path));
          }
        }
      };
      await collect(wikiRoot, 0);

      const absent = [...ledger.pages.keys()].filter(
        (page) => !existing.has(page),
      );
      if (absent.length > 0) {
        problems.push(
          `${absent.length} planned page(s) were never written: ${absent.slice(0, 10).join(", ")}${absent.length > 10 ? ", ..." : ""}`,
        );
      }
      // Decomposition is checked here as well as at planning, because this is the
      // one place the pressure is free: the pages are already on disk, so a
      // problem costs a turn rather than the wiki. The authoring gate cannot hold
      // it - refusing there leaves nothing written at all.
      const view = await collectPlanningView(backend);
      const shortfalls = advisoryProblems(
        ledger.entries,
        view.directories,
        view.sourceFiles,
      );
      if (shortfalls.length > 0) {
        problems.push(...shortfalls);
      }
      const qaProblem = qaGate ? qaFinalizationProblem(qaGate) : null;
      if (qaProblem) {
        problems.push(qaProblem);
      }

      return JSON.stringify({
        complete: problems.length === 0,
        plannedPages: ledger.pages.size,
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
    tools: [listDirectories, listContracts, submitPlan, finalizeWiki],
  });
}
