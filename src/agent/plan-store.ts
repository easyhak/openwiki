/**
 * The plan as evidence, and the briefs generated from it.
 *
 * The ledger stored a directory, a disposition, and page paths. Nothing else -
 * so when the critic asked for a page's source paths, symbols, focused tests,
 * and boundary edges, and the coordinator worked them out, that work was
 * discarded at submission. Author briefs then said "inspect the relevant source
 * directory implied by this page path" and listed every page in the wiki as a
 * possible link target.
 *
 * What that costs is measurable. Across graded runs the two claim roles the
 * grader asks for and the wiki keeps missing are boundary, absent 64% of the
 * time, and validation, absent 57% - the two an author cannot derive from its
 * own subtree. A boundary fact is about the relationship between two components,
 * and the only participant that saw both is the planner. The validation answer
 * lives in Makefiles and CI workflows, not beside the code under test.
 *
 * So the plan carries them, and the brief is rendered here rather than composed
 * by the coordinator: a page with no implementation anchor, no entrypoint, and
 * no focused test cannot be dispatched, because an author sent without them will
 * write what it can see and the page will miss exactly what the grader asks.
 */

/**
 * The one canonical form of a wiki page path.
 *
 * A page was spelled four ways across one run - `architecture/overview`,
 * `architecture/overview.md`, `openwiki/architecture/overview.md`, and
 * `/openwiki/architecture/overview.md` - and each boundary normalized
 * differently or not at all. The costs compounded: the plan stored the
 * extensionless form, briefs correctly told authors to write the `.md` file, all
 * 57 authors succeeded and established their claims, and then a count read on
 * the un-suffixed path threw and discarded the whole pool result. The
 * coordinator re-dispatched all 57 pages, which produced 120 author calls, a
 * second independent draft of every page, and left 56 seconds for verification
 * inside a 20-minute budget. The run scored 0.
 *
 * So every boundary calls this: planning, authoring, Claims, and finalization.
 * An extensionless path is an alias rather than an error, because the intent is
 * unambiguous and rejecting it only sent the coordinator round the loop again.
 *
 * @param page - Page path in any of the spellings a model produces.
 * @returns Absolute path of the form /openwiki/<path>.md.
 */
export function canonicalWikiPage(page: string, wikiRoot = "openwiki"): string {
  const bare = page
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");
  const rooted = bare.startsWith(`${wikiRoot}/`)
    ? bare.slice(wikiRoot.length + 1)
    : bare;
  const withExtension = /\.md$/iu.test(rooted) ? rooted : `${rooted}.md`;
  return `/${wikiRoot}/${withExtension}`;
}

/** One page the plan commits to, with the evidence its author needs. */
export interface PlannedPage {
  path: string;
  responsibility: string;
  entrypoint: string;
  sources: string[];
  tests: string[];
  edges: { page: string; relationship: string }[];
}

/** One area of the repository and what the plan does about it. */
export type PlanEntry =
  | { disposition: "document"; directory: string; pages: PlannedPage[] }
  | {
      disposition: "covered_by";
      directory: string;
      page: string;
      reason: string;
    }
  | { disposition: "exclude"; directory: string; reason: string };

/** The accepted plan. */
export interface PlanLedger {
  entries: PlanEntry[];
  pages: Map<string, PlannedPage>;
}

/** Shared between the tool that accepts a plan and the tools that consume it. */
export interface PlanStore {
  get(): PlanLedger | null;
  set(ledger: PlanLedger): void;
}

/**
 * Creates an empty plan store.
 *
 * @returns A store the plan and authoring tools share.
 */
export function createPlanStore(): PlanStore {
  let ledger: PlanLedger | null = null;
  return {
    get: () => ledger,
    set: (next) => {
      ledger = next;
    },
  };
}

/**
 * Reports what a planned page is missing before it can be authored.
 *
 * @param page - The planned page.
 * @returns Missing field names, empty when the page is dispatchable.
 */
export function missingEvidence(page: PlannedPage): string[] {
  const missing: string[] = [];
  if (page.sources.length === 0) {
    missing.push("sources");
  }
  if (!page.entrypoint.trim()) {
    missing.push("entrypoint");
  }
  if (page.tests.length === 0) {
    missing.push("tests");
  }
  if (!page.responsibility.trim()) {
    missing.push("responsibility");
  }
  // Boundary is the claim role the grader finds absent most often - 64% to 71%
  // across runs - and it is the one an author cannot derive from its own
  // subtree: it is a fact about two components, and only the planner saw both.
  // A plan that names no relationship for a page guarantees the page states
  // none. Measured on a healthy plan, 11 of 65 pages had zero edges and the
  // rest averaged 1.2.
  if (page.edges.length === 0) {
    missing.push(
      "at least one edge - what this depends on, or what depends on it",
    );
  }
  return missing;
}

/**
 * Renders one author's brief from the plan.
 *
 * Only the pages this one has an edge to are named, rather than the whole wiki.
 * A brief listing every page invites links the author cannot justify, and a
 * relationship it was not given is one it cannot state - which is the boundary
 * half of what the grader asks for.
 *
 * @param page - The planned page to author.
 * @param defect - What to fix, when this is a repair rather than a first draft.
 * @returns The complete brief.
 */
export function renderBrief(page: PlannedPage, defect?: string): string {
  const edges =
    page.edges.length > 0
      ? page.edges
          .map((edge) => `  - ${edge.page}: ${edge.relationship}`)
          .join("\n")
      : "  - none recorded";
  return [
    `Write the OpenWiki page ${page.path}.`,
    "",
    `Responsibility: ${page.responsibility}`,
    `Entrypoint: ${page.entrypoint}`,
    `Implementation evidence, where to start reading:`,
    ...page.sources.map((source) => `  - ${source}`),
    `Focused tests, and what a reader would run to check a change:`,
    ...page.tests.map((test) => `  - ${test}`),
    `Relationships. State each one in the prose that explains it, and link only these pages:`,
    edges,
    "",
    "Read the evidence above before drafting, and follow it into whatever it references - the Makefile target or CI job that runs those tests, and the module on the other side of each relationship. Both are things a reader changing this component needs and neither is inside your own directory.",
    ...(defect
      ? [
          "",
          `This page already exists and is being repaired. Preserve what is correct and fix this: ${defect}`,
        ]
      : []),
  ].join("\n");
}
