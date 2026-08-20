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
  // The claim store accepts only a Markdown file below the wiki root and throws
  // otherwise. A plan carrying "architecture/overview" therefore produced a
  // page nothing could ever ground, and the throw surfaced from a count read
  // deep inside the authoring pool rather than at the plan that caused it.
  if (!/\.md$/u.test(page.path.trim())) {
    missing.push("a .md page path");
  }
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
