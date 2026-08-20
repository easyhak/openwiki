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
  collectDirectoryTree,
  collectPlanningView,
  findUncoveredDirectories,
  type ListingBackend,
} from "./repo-inventory.js";
import {
  type BoundaryClaim,
  type BoundaryDisposition,
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

const BoundaryClaimSchema = z
  .object({
    id: z.string().min(1).max(80),
    direction: z.enum(["inbound", "outbound", "shared"]),
    counterparty: z
      .string()
      .min(1)
      .max(240)
      .describe("A recorded area directory or external:<name>."),
    relationship: z.string().min(10).max(500),
    mechanism: z.string().min(3).max(500),
    sources: z.array(z.string().min(1).max(500)).min(1).max(12),
    tests: z.array(z.string().min(1).max(500)).max(8),
    testsAbsent: z.string().min(20).max(300).optional(),
  })
  .strict()
  // A relationship with no focused test is common, and requiring one anyway
  // makes dropping the claim the cheapest honest answer - which suppresses the
  // boundaries the survey exists to surface. Saying so explicitly is the answer;
  // silence is not.
  .refine(
    (claim) => claim.tests.length > 0 || Boolean(claim.testsAbsent),
    {
      message:
        'Give focused tests and the command that runs them, or testsAbsent saying what you looked for and why nothing covers this relationship.',
      path: ["tests"],
    },
  );

const AreaBoundarySurveySchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("reviewed"),
      inspected: z.array(z.string().min(1).max(500)).min(1).max(20),
      boundaries: z.array(BoundaryClaimSchema).min(1).max(30),
    })
    .strict(),
  z
    .object({
      status: z.literal("no_boundaries"),
      inspected: z.array(z.string().min(1).max(500)).min(1).max(20),
      reason: z.string().min(20).max(1000),
      boundaries: z.tuple([]),
    })
    .strict(),
]);

const EntrySchema = z.discriminatedUnion("disposition", [
  z
    .object({
      disposition: z.literal("document"),
      directory: z.string().min(1),
      pages: z.array(PlannedPageSchema).min(1),
      survey: AreaBoundarySurveySchema.optional(),
    })
    .strict(),
  z
    .object({
      disposition: z.literal("covered_by"),
      directory: z.string().min(1),
      page: z.string().min(1),
      reason: z.string().min(1),
      survey: AreaBoundarySurveySchema.optional(),
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

const BoundaryDispositionInputSchema = z.discriminatedUnion("disposition", [
  z
    .object({
      boundary: z.string().min(1).max(160),
      claims: z.array(z.string().min(3).max(320)).min(1).max(30),
      disposition: z.literal("document"),
      page: PlannedPageSchema,
    })
    .strict(),
  z
    .object({
      boundary: z.string().min(1).max(160),
      claims: z.array(z.string().min(3).max(320)).min(1).max(30),
      disposition: z.literal("covered_by"),
      page: z.string().min(1),
      reason: z.string().min(20).max(1000),
    })
    .strict(),
  z
    .object({
      boundary: z.string().min(1).max(160),
      claims: z.array(z.string().min(3).max(320)).min(1).max(30),
      disposition: z.literal("exclude"),
      reason: z.string().min(20).max(1000),
    })
    .strict(),
]);

const SubmitPlanSchema = z.object({
  entries: z.array(EntrySchema).min(1).optional(),
  boundaries: z.array(BoundaryDispositionInputSchema).optional(),
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
const SubmitPlanInputSchema = z.object({
  entries: z.array(z.record(z.string(), z.unknown())).min(1).optional(),
  boundaries: z.array(z.record(z.string(), z.unknown())).optional(),
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
export function normalizeWikiPage(
  page: string,
  wikiRoot = "/openwiki",
): string {
  const root = wikiRoot.replace(/^\/+/u, "").replace(/\/+$/u, "");
  const bare = page.replace(/^\/+/u, "");
  return bare === root || bare.startsWith(`${root}/`)
    ? bare
    : `${root}/${bare}`;
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
  if (!tree.includes(entry.directory) && entry.disposition !== "exclude") {
    // A directory not in the tree is a typo, and a typo can leave the directory
    // it meant uncovered while looking like it was planned.
    //
    // An exclusion is exempt. The coverage walk runs live and to any depth while
    // the listing is bounded and read once, so it can report a directory the
    // listing never showed - one created during the run, or one deeper than the
    // listing goes. Refusing the exclusion too left the plan unable to answer a
    // requirement it was being held to, which stops authoring outright.
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
  boundaries: BoundaryDisposition[] = [],
): string[] {
  return [
    ...blockingProblems(entries, uncovered, boundaries),
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
  boundaries: BoundaryDisposition[] = [],
): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string>();
  const recordOwner = (page: PlannedPage, owner: string): void => {
    const key = canonicalWikiPage(page.path);
    const existing = owners.get(key);
    if (existing) {
      problems.push(`${key} is owned by both ${existing} and ${owner}`);
    } else {
      owners.set(key, owner);
    }
  };
  for (const entry of entries) {
    if (entry.disposition !== "document") {
      continue;
    }
    for (const page of entry.pages) {
      recordOwner(page, entry.directory);
    }
  }
  for (const boundary of boundaries) {
    if (boundary.disposition === "document") {
      recordOwner(boundary.page, `boundary ${boundary.boundary}`);
    }
  }
  const checkEdges = (page: PlannedPage): void => {
    for (const edge of page.edges) {
      if (!owners.has(canonicalWikiPage(edge.page))) {
        problems.push(
          `${page.path} has an edge to ${edge.page}, which no entry documents`,
        );
      }
    }
  };
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
        checkEdges(page);
      }
    }
  }
  for (const boundary of boundaries) {
    if (boundary.disposition === "covered_by") {
      if (!owners.has(canonicalWikiPage(boundary.page))) {
        problems.push(
          `${boundary.boundary} is covered_by ${boundary.page}, which no entry documents`,
        );
      }
    } else if (boundary.disposition === "document") {
      checkEdges(boundary.page);
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
    const prefix = entry.directory === "/" ? "/" : `${entry.directory}/`;
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
  boundaries: BoundaryDisposition[] = [],
): string {
  const counts = { document: 0, covered_by: 0, exclude: 0 };
  for (const entry of entries) {
    counts[entry.disposition] += 1;
  }
  const pages = entries.flatMap((entry) =>
    entry.disposition === "document" ? entry.pages : [],
  );
  const boundaryPages = boundaries.flatMap((boundary) =>
    boundary.disposition === "document" ? [boundary.page] : [],
  );
  const claims = collectBoundaryClaims(entries);
  const boundaryProblems = boundaryLedgerProblems(entries, boundaries);
  return [
    "# Plan",
    "",
    `${entries.length} directories: ${counts.document} documented, ${counts.covered_by} covered elsewhere, ${counts.exclude} excluded. ${pages.length + boundaryPages.length} pages.`,
    "",
    "| Page | Responsibility | Entrypoint | Tests | Relates to |",
    "| --- | --- | --- | --- | --- |",
    ...[...pages, ...boundaryPages].map(
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
    "",
    "## Area boundary surveys",
    "",
    "| Area | Status | Inspected evidence | Note |",
    "| --- | --- | --- | --- |",
    ...entries
      .filter((entry) => entry.disposition !== "exclude")
      .map((entry) => {
        if (!entry.survey) {
          return `| ${entry.directory} | missing | - | No boundary survey recorded |`;
        }
        return `| ${entry.directory} | ${entry.survey.status} | ${entry.survey.inspected.join("<br>")} | ${entry.survey.status === "no_boundaries" ? entry.survey.reason : `${entry.survey.boundaries.length} claim(s)`} |`;
      }),
    ...(claims.size > 0
      ? [
          "",
          "## Boundary claims",
          "",
          "| Claim | Area | Direction | Counterparty | Relationship and mechanism | Evidence | Validation |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...[...claims.entries()].map(
            ([key, record]) =>
              `| ${key} | ${record.area} | ${record.claim.direction} | ${record.claim.counterparty} | ${record.claim.relationship}<br>${record.claim.mechanism} | ${record.claim.sources.join("<br>")} | ${record.claim.tests.length > 0 ? record.claim.tests.join("<br>") : `none: ${record.claim.testsAbsent ?? "unstated"}`} |`,
          ),
        ]
      : []),
    ...(boundaries.length > 0
      ? [
          "",
          "## Boundary dispositions",
          "",
          "| Boundary | Claims | Disposition | Page or reason |",
          "| --- | --- | --- | --- |",
          ...boundaries.map((boundary) => {
            const outcome =
              boundary.disposition === "document"
                ? boundary.page.path
                : boundary.disposition === "covered_by"
                  ? `${boundary.page}: ${boundary.reason}`
                  : boundary.reason;
            return `| ${boundary.boundary} | ${boundary.claims.join("<br>")} | ${boundary.disposition} | ${outcome} |`;
          }),
        ]
      : []),
    ...(boundaryProblems.length > 0
      ? [
          "",
          "## Unresolved boundary ledger",
          "",
          ...boundaryProblems.map((problem) => `- ${problem}`),
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
): Promise<{ blocking: string[]; shortfall: string[] }> {
  const entries = store.get()?.entries ?? [];
  if (entries.length === 0) {
    return {
      blocking: ["No plan recorded; call submit_plan first."],
      shortfall: [],
    };
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
  // Reciprocity advises rather than blocks. Satisfying it needs two areas
  // surveyed consistently, so one sloppy survey would otherwise hold up claims
  // recorded correctly in another entry - a precondition an area cannot meet on
  // its own. Missing surveys and undisposed claims stay blocking: those an area
  // can answer by itself.
  const boundary = boundaryProblems(entries, ledger?.boundaries ?? []);
  return {
    blocking: [
      ...blockingProblems(entries, uncovered, ledger?.boundaries ?? []),
      ...boundary.structural,
    ],
    shortfall: [
      ...advisoryProblems(entries, view.directories, view.sourceFiles),
      ...boundary.reciprocity,
    ],
  };
}

/**
 * The one name for a claim, since an id is only unique within its own survey.
 *
 * @param area - Directory of the entry whose survey recorded the claim.
 * @param id - Claim id as that survey spelled it.
 * @returns Key of the form <area>#<id>.
 */
export function boundaryClaimKey(area: string, id: string): string {
  return `${area}#${id}`;
}

/** The direction the counterparty's matching claim has to carry. */
const RECIPROCAL: Record<
  BoundaryClaim["direction"],
  BoundaryClaim["direction"]
> = {
  inbound: "outbound",
  outbound: "inbound",
  shared: "shared",
};

/**
 * Indexes every relationship the area surveys reported.
 *
 * @param entries - Every recorded entry.
 * @returns Claims by their canonical key, with the area that reported each.
 */
export function collectBoundaryClaims(
  entries: PlanEntry[],
): Map<string, { area: string; claim: BoundaryClaim }> {
  const claims = new Map<string, { area: string; claim: BoundaryClaim }>();
  for (const entry of entries) {
    if (entry.disposition === "exclude" || !entry.survey) {
      continue;
    }
    for (const claim of entry.survey.boundaries) {
      claims.set(boundaryClaimKey(entry.directory, claim.id), {
        area: entry.directory,
        claim,
      });
    }
  }
  return claims;
}

/**
 * Whether one cited source sits inside one planned area.
 *
 * The root area owns the repository's own files rather than everything beneath
 * it: treating "/" as a prefix would let any source in the tree anchor it, and
 * a page could then claim every participant while citing one directory.
 *
 * @param source - Implementation anchor, optionally carrying a #symbol.
 * @param area - Area directory as an entry records it.
 * @returns True when the source is inside that area.
 */
export function sourceBelongsToArea(source: string, area: string): boolean {
  const bare = (source.replace(/^\/+/u, "").split("#")[0] ?? "").trim();
  const directory = area.replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (!bare) {
    return false;
  }
  if (directory === "") {
    return !bare.includes("/");
  }
  return bare === directory || bare.startsWith(`${directory}/`);
}

/**
 * Checks one boundary disposition against the claims the surveys reported.
 *
 * A disposition can only answer a relationship some area actually observed,
 * because the point of the unit is to answer evidence rather than to invent
 * subjects: a plan could otherwise clear its boundary report by naming
 * relationships nothing in the repository shows.
 *
 * A documented boundary must also cite every internal participant. A page whose
 * sources all sit on one side is a page about that side, and the fact it was
 * supposed to carry - what crosses, and which side is authoritative - is
 * exactly what it will omit.
 *
 * @param disposition - Candidate boundary disposition.
 * @param claims - Claims the surveys reported, by key.
 * @returns Problems, empty when the disposition is recordable.
 */
export function validateBoundaryDisposition(
  disposition: BoundaryDisposition,
  claims: ReadonlyMap<string, { area: string; claim: BoundaryClaim }>,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const participants = new Set<string>();
  for (const reference of disposition.claims) {
    if (seen.has(reference)) {
      problems.push(`${disposition.boundary} lists ${reference} twice.`);
      continue;
    }
    seen.add(reference);
    const record = claims.get(reference);
    if (!record) {
      problems.push(
        `${disposition.boundary} refers to ${reference}, which no area survey claims. Use <area directory>#<claim id> from a survey you submitted.`,
      );
      continue;
    }
    participants.add(record.area);
    if (!record.claim.counterparty.startsWith("external:")) {
      participants.add(record.claim.counterparty);
    }
  }
  if (disposition.disposition !== "document") {
    return problems;
  }
  problems.push(
    ...missingEvidence(disposition.page).map(
      (missing) => `${disposition.boundary}: missing ${missing}`,
    ),
  );
  const uncited = [...participants].filter(
    (participant) =>
      !disposition.page.sources.some((source) =>
        sourceBelongsToArea(source, participant),
      ),
  );
  if (uncited.length > 0) {
    problems.push(
      `${disposition.boundary} cites no source in ${uncited.join(", ")}. A boundary page anchored on one side documents that side and omits the boundary.`,
    );
  }
  return problems;
}

/**
 * Reports what the boundary ledger has not settled.
 *
 * Three things have to hold before a plan can be authored from. Every area the
 * plan keeps was actually investigated, so an area with no survey is a subtree
 * whose outward relationships nobody looked for. Every relationship an area
 * reported has an answer, because an observed boundary that no page and no
 * reason accounts for is a fact the wiki drops silently. And an internal
 * relationship is reported by both of its ends, because one area seeing a
 * boundary the other does not is the sign it was guessed rather than read.
 *
 * External counterparties are exempt from the last: the other end is outside
 * the repository, so nothing here can survey it.
 *
 * @param entries - Every recorded entry.
 * @param boundaries - Every recorded boundary disposition.
 * @returns Problems that must clear before authoring.
 */
export function boundaryProblems(
  entries: PlanEntry[],
  boundaries: BoundaryDisposition[],
): { structural: string[]; reciprocity: string[] } {
  const structural: string[] = [];
  const reciprocity: string[] = [];
  const kept = new Set(
    entries
      .filter((entry) => entry.disposition !== "exclude")
      .map((entry) => entry.directory),
  );
  for (const entry of entries) {
    if (entry.disposition === "exclude") {
      continue;
    }
    if (!entry.survey) {
      structural.push(
        `${entry.directory} has no boundary survey. Record what you inspected, and either the relationships crossing this area's boundary or "no_boundaries" with the reason none do.`,
      );
      continue;
    }
    const ids = new Set<string>();
    for (const claim of entry.survey.boundaries) {
      if (ids.has(claim.id)) {
        structural.push(
          `${entry.directory} reports ${claim.id} twice; a claim id is unique within its survey.`,
        );
      }
      ids.add(claim.id);
      if (claim.counterparty.startsWith("external:")) {
        continue;
      }
      const key = boundaryClaimKey(entry.directory, claim.id);
      if (claim.counterparty === entry.directory) {
        structural.push(
          `${key} names its own area as the counterparty; a boundary has two sides.`,
        );
      } else if (!kept.has(claim.counterparty)) {
        structural.push(
          `${key} names ${claim.counterparty}, which is not an area the plan documents or covers. Use a directory another entry records, or external:<name>.`,
        );
      }
    }
  }

  const claims = collectBoundaryClaims(entries);
  const disposedBy = new Map<string, string[]>();
  for (const boundary of boundaries) {
    for (const reference of new Set(boundary.claims)) {
      disposedBy.set(reference, [
        ...(disposedBy.get(reference) ?? []),
        boundary.boundary,
      ]);
    }
  }
  for (const [reference, names] of disposedBy) {
    if (!claims.has(reference)) {
      structural.push(
        `${names[0]} disposes of ${reference}, which no area survey claims.`,
      );
    } else if (names.length > 1) {
      structural.push(
        `${reference} is disposed of by ${names.join(" and ")}; a claim takes exactly one disposition.`,
      );
    }
  }
  for (const [key, record] of claims) {
    if (!disposedBy.has(key)) {
      structural.push(
        `${key} (${record.claim.direction}, ${record.claim.counterparty}) has no disposition. Give it a boundary page, name the existing page that covers it, or exclude it with a reason.`,
      );
    }
    if (record.claim.counterparty.startsWith("external:")) {
      continue;
    }
    // Paired by claim id, not by (area, counterparty, direction): two areas here
    // share a hundred tables, so several claims routinely run between one pair in
    // one direction. Keyed by the triple, the second of them overwrote the first,
    // which let an unmirrored claim pass on another claim's mate and then asked
    // for two unrelated relationships to share one boundary.
    const wanted = RECIPROCAL[record.claim.direction];
    const mateKey = boundaryClaimKey(
      record.claim.counterparty,
      record.claim.id,
    );
    const mate = claims.get(mateKey);
    if (
      !mate ||
      mate.claim.counterparty !== record.area ||
      mate.claim.direction !== wanted
    ) {
      reciprocity.push(
        `${key} reports a ${record.claim.direction} relationship with ${record.claim.counterparty}, and ${record.claim.counterparty} records no ${wanted} claim back to ${record.area} under the same id. Both ends of one relationship carry the same claim id, so survey that area for it or drop the claim.`,
      );
      continue;
    }
    // Reported from the near side only, so one relationship yields one problem
    // rather than the same problem from each of its ends.
    const here = disposedBy.get(key);
    const there = disposedBy.get(mateKey);
    if (key < mateKey && here && there && here[0] !== there[0]) {
      structural.push(
        `${key} and ${mateKey} are the two sides of one relationship but sit in different boundaries (${here[0]}, ${there[0]}). Dispose of both in the same one.`,
      );
    }
  }
  return { structural, reciprocity };
}

/**
 * Every boundary problem, for reporting rather than for gating.
 *
 * @param entries - Recorded entries.
 * @param boundaries - Recorded dispositions.
 * @returns Structural problems followed by reciprocity problems.
 */
export function boundaryLedgerProblems(
  entries: PlanEntry[],
  boundaries: BoundaryDisposition[],
): string[] {
  const { structural, reciprocity } = boundaryProblems(entries, boundaries);
  return [...structural, ...reciprocity];
}

export function createOpenWikiPlanLedgerMiddleware(
  backend: LedgerBackend,
  store: PlanStore,
  qaGate?: QaGate,
  wikiRoot = "/openwiki",
) {
  const setLedger = async (
    entries: PlanEntry[],
    boundaries: BoundaryDisposition[],
  ) => {
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
    // Boundary pages join the same map: they are dispatched by the same pool and
    // checked by the same completion gate. Only the plan's shape differs.
    for (const boundary of boundaries) {
      if (boundary.disposition === "document") {
        pages.set(canonicalWikiPage(boundary.page.path), boundary.page);
      }
    }
    store.set({ entries, boundaries, pages });
    const written = await backend.write(
      `${wikiRoot}/_plan.md`,
      renderPlanMarkdown(entries, boundaries),
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

  const listUnresolvedBoundaries = tool(
    () => {
      const ledger = store.get();
      const entries = ledger?.entries ?? [];
      const boundaries = ledger?.boundaries ?? [];
      const claims = collectBoundaryClaims(entries);
      return Promise.resolve(
        JSON.stringify({
          areasRecorded: entries.length,
          areasSurveyed: entries.filter(
            (entry) => entry.disposition !== "exclude" && entry.survey,
          ).length,
          claims: claims.size,
          boundaries: boundaries.length,
          problems: boundaryLedgerProblems(entries, boundaries),
        }),
      );
    },
    {
      name: "list_unresolved_boundaries",
      description: [
        "Read back what the boundary ledger has not settled: areas with no survey, relationships one area reported and its counterparty did not, and claims no disposition answers.",
        "It records nothing and costs no plan state, so call it to see what is left rather than resubmitting a plan to find out. The same problems appear in submit_plan's `blocking`.",
      ].join(" "),
      schema: z.object({}),
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
      if (!parsed.data.entries?.length && !parsed.data.boundaries?.length) {
        return JSON.stringify({
          accepted: false,
          problems: ["Send entries, boundaries, or both."],
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

      const entries = [...merged.values()];
      // Boundaries merge by name the way entries merge by directory, and are
      // checked against the claims the merged surveys carry: a disposition
      // answers a relationship some area reported, never one it names itself.
      const claims = collectBoundaryClaims(entries);
      const mergedBoundaries = new Map<string, BoundaryDisposition>();
      for (const boundary of store.get()?.boundaries ?? []) {
        mergedBoundaries.set(boundary.boundary, boundary);
      }
      const rejectedBoundaries: string[] = [];
      for (const boundary of parsed.data.boundaries ?? []) {
        const problems = validateBoundaryDisposition(boundary, claims);
        if (problems.length > 0) {
          rejectedBoundaries.push(...problems);
          continue;
        }
        mergedBoundaries.set(boundary.boundary, boundary);
      }
      const boundaries = [...mergedBoundaries.values()];

      const uncovered = await findUncoveredDirectories(
        backend,
        entries.map((entry) => entry.directory),
      );
      const boundary = boundaryProblems(entries, boundaries);
      const blocking = [
        ...blockingProblems(entries, uncovered, boundaries),
        ...boundary.structural,
      ];
      const shortfall = [
        ...advisoryProblems(entries, tree, view.sourceFiles),
        ...boundary.reciprocity,
      ];
      await setLedger(entries, boundaries);
      const documented = entries.filter(
        (entry) => entry.disposition === "document",
      ).length;
      return JSON.stringify({
        accepted: rejected.length === 0 && rejectedBoundaries.length === 0,
        recorded: entries.length,
        documented,
        plannedPages: store.get()?.pages.size ?? 0,
        ...(rejected.length > 0 ? { rejectedEntries: rejected } : {}),
        boundaryClaims: claims.size,
        boundariesRecorded: boundaries.length,
        ...(rejectedBoundaries.length > 0 ? { rejectedBoundaries } : {}),
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
        "Every entry you keep - document or covered_by - also carries a `survey` recording what you found when you looked at that area's outward relationships. Record it in the same call as the entry, while you are already reading the area; it is not a separate pass.",
        "The boundary is the entry's DIRECTORY, not its service. Anything leaving that directory crosses it, including a sibling directory in the same service and a parent entry that contains it: for /smith-go/runs, /smith-go/queue is across the boundary exactly as /smith-backend is. Being internal to one service is not a reason to report nothing - most relationships worth documenting are internal to a service, which is why they have no page of their own.",
        "Answer these about the area, rather than judging whether it has a boundary. What state does it write that another area also writes or reads - a table, a key, a queue, a file, a config value. What does it read that another area produces. What calls into it, and what does it call. What does it publish or consume. What does it depend on or deploy outside this repository. `none` to one of those is a narrow statement you can support; a blanket no_boundaries usually means the questions were not asked.",
        "Something outside the repository is a claim, not a reason for having none: a provider API, a managed service, a deploy target, a scheduled runner. Its counterparty is external:<name> and it needs no reciprocal - but it is still a relationship a reader has to know about.",
        "A page `edge` does not discharge a claim. An edge says two pages relate; a claim says what concretely crosses, in which direction, through which mechanism, with the source that proves it. An area whose relationships are recorded only as edges has not been surveyed.",
        "no_boundaries is the right answer for an area that genuinely stands alone - a pure algorithm, vendored or generated code, a self-contained utility, prose. It is the wrong answer for a subsystem that happens to sit inside a larger service:",
        '  "survey":{"status":"reviewed","inspected":["smith-go/api/routes.go","smith-go/store/pg.go"],"boundaries":[{"id":"sessions-write","direction":"outbound","counterparty":"/smith-backend","relationship":"writes session rows the Python API also writes","mechanism":"direct INSERT into public.sessions","sources":["smith-go/store/pg.go#InsertSession"],"tests":["smith-go/store/pg_test.go - make test-dir DIR=store"]}]}',
        '  "survey":{"status":"no_boundaries","inspected":["docs/adr/0001.md"],"reason":"Prose only: nothing here is imported, called, deployed, or written by another area.","boundaries":[]}',
        "A claim needs focused tests and the command that runs them, or `testsAbsent` saying what you looked for and why nothing covers the relationship - plenty of real relationships have no test, and dropping the claim to avoid saying so hides exactly what this is for. A claim is something you saw, not something the layout suggests: name the concrete mechanism - the call, the table, the queue, the artifact, the deployment step - and cite the source that proves it. `direction` is from this area outwards, and `counterparty` is another entry's directory or external:<name> for something outside the repository. An area with genuinely nothing crossing its boundary says so with no_boundaries and a reason; that is a normal answer, not a failure.",
        "An internal relationship has to be reported by both ends. If /smith-go claims an outbound relationship with /smith-backend, /smith-backend's survey needs the matching inbound claim - so survey the counterparty before claiming it. A claim only one side records is reported and does not stop authoring, so keep one you can see from here and let the other end catch up. `shared` pairs with `shared`, and external counterparties need no reciprocal. Both ends of one relationship carry the same claim id - that is how the two sides are matched. A claim only one side can see is reported but does not stop authoring, since the other area's survey is not yours to fix from here.",
        "Then every claim gets exactly one disposition, in the same call's `boundaries`, and the two sides of one relationship go in the same disposition:",
        '  {"boundary":"session-ownership","claims":["/smith-go#sessions-write","/smith-backend#sessions-write"],"disposition":"document","page":<page>}',
        '  {"boundary":"session-ownership","claims":[...],"disposition":"covered_by","page":"openwiki/data/postgres.md","reason":"..."}',
        '  {"boundary":"session-ownership","claims":[...],"disposition":"exclude","reason":"..."}',
        "A boundary page is not a directory page - it exists because the fact spans areas - so its sources must anchor in every internal participant, and its responsibility says which side is authoritative and what the other side does. Its evidence and tests come from the claims, so you do not have to find them again. `list_unresolved_boundaries` reads back what is still open without recording anything.",
        "Most areas of a repository need a page of their own. Excluding suits fixtures, test data, generated output, and scratch; CI and release workflows, deployment definitions, migrations, schedulers, data stores, and configuration a reader needs are documented or covered_by. covered_by is for an area genuinely documented on another page, not a way to avoid writing one, and one page cannot absorb more than a few areas. A large area is several pages: one each for independently registered route families, distinct data models or stores, and subsystems that run on their own.",
        "The response separates two things. `blocking` stops author_pages until it clears - a directory no entry covers, an area with no survey, a claim with no disposition, or a page reference that resolves to nothing. `shortfall` does not stop anything: it reports areas whose planned pages look thin for the source they hold, and authoring proceeds either way, so treat it as a prompt to plan better rather than a barrier to clear. Never invent placeholder pages to satisfy it; a page that documents nothing is worse than an area that is thin.",
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
      problems.push(...blockingProblems(ledger.entries, [], ledger.boundaries));
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
    tools: [
      listDirectories,
      listUnresolvedBoundaries,
      submitPlan,
      finalizeWiki,
    ],
  });
}
