import { createHash } from "node:crypto";
import { normalizeWikiPagePath } from "../../claims/brains/code/paths.js";
import { PageJobSchema, type PageJob } from "./contracts.js";

/**
 * Operation precedence used only after delete proof has been validated.
 */
const OPERATION_PRECEDENCE: Readonly<Record<PageJob["operation"], number>> = {
  create: 1,
  reconcile: 2,
  repair: 3,
  quickstart: 4,
  delete: 5,
};

/**
 * Input accepted before a deterministic job identifier is assigned.
 */
export type ProposedPageJob = Omit<PageJob, "id">;

/**
 * Creates a stable identifier from canonical job identity fields.
 *
 * @param job - Canonical job without an identifier.
 * @returns SHA-256-derived job identifier.
 */
export function createPageJobId(job: ProposedPageJob): string {
  const payload = JSON.stringify({
    operation: job.operation,
    page: job.page,
    reasons: [...job.reasons].sort(),
    wave: job.wave,
  });
  return `job_${createHash("sha256").update(payload).digest("hex").slice(0, 24)}`;
}

/**
 * Canonicalizes, validates, deduplicates, and sorts page work.
 *
 * Same-page work is merged before every fan-out. Delete is accepted only when
 * every same-page proposal is delete; a mixed delete/write proposal is rejected
 * because deletion requires separate deterministic proof.
 *
 * @param proposed - Untrusted planner or deterministic job proposals.
 * @returns Stable canonical page jobs.
 */
export function mergePageJobs(proposed: readonly ProposedPageJob[]): PageJob[] {
  const byPage = new Map<string, ProposedPageJob[]>();
  for (const candidate of proposed) {
    const page = normalizeWikiPagePath(candidate.page);
    const normalized: ProposedPageJob = {
      ...candidate,
      page,
      reasons: uniqueSorted(candidate.reasons),
      sourceHints: uniqueSorted(candidate.sourceHints),
    };
    PageJobSchema.omit({ id: true }).parse(normalized);
    const group = byPage.get(page) ?? [];
    group.push(normalized);
    byPage.set(page, group);
  }

  const jobs: PageJob[] = [];
  for (const [page, group] of byPage) {
    const hasDelete = group.some((item) => item.operation === "delete");
    if (hasDelete && group.some((item) => item.operation !== "delete")) {
      throw new Error(`Conflicting delete and write jobs for ${page}.`);
    }
    const selected = [...group].sort(
      (left, right) =>
        OPERATION_PRECEDENCE[right.operation] -
          OPERATION_PRECEDENCE[left.operation] ||
        right.priority - left.priority,
    )[0];
    const merged: ProposedPageJob = {
      ...selected,
      page,
      reasons: uniqueSorted(group.flatMap((item) => item.reasons)),
      sourceHints: uniqueSorted(group.flatMap((item) => item.sourceHints)),
      wave: Math.max(...group.map((item) => item.wave)),
      priority: Math.max(...group.map((item) => item.priority)),
    };
    jobs.push(PageJobSchema.parse({ ...merged, id: createPageJobId(merged) }));
  }
  return jobs.sort(
    (left, right) =>
      right.priority - left.priority || left.page.localeCompare(right.page),
  );
}

/**
 * Merges parallel page results and rejects same-wave conflicts.
 *
 * @param current - Results already present in parent state.
 * @param update - Results emitted by one or more parallel tasks.
 * @returns Stable latest result per canonical page.
 */
export function mergePageResults(
  current: readonly import("./contracts.js").PageResult[],
  update: readonly import("./contracts.js").PageResult[],
): import("./contracts.js").PageResult[] {
  const byPage = new Map(current.map((result) => [result.page, result]));
  for (const result of update) {
    const existing = byPage.get(result.page);
    if (existing?.wave === result.wave) {
      throw new Error(
        `Page ${result.page} produced multiple results for wave ${result.wave}.`,
      );
    }
    if (!existing || result.wave > existing.wave) {
      byPage.set(result.page, result);
    }
  }
  return [...byPage.values()].sort((left, right) =>
    left.page.localeCompare(right.page),
  );
}

/**
 * Merges parallel stable identifiers without duplicating earlier values.
 *
 * @param current - Identifiers already present in graph state.
 * @param update - Identifiers emitted by one or more tasks.
 * @returns Unique identifiers in lexical order.
 */
export function mergeStableIds(
  current: readonly string[],
  update: readonly string[],
): string[] {
  return [...new Set([...current, ...update])].sort((left, right) =>
    left.localeCompare(right),
  );
}

/**
 * Deduplicates bounded strings in lexical order.
 *
 * @param values - Candidate values.
 * @returns Trimmed non-empty unique values.
 */
function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}
