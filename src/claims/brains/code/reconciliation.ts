import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OpenWikiIgnore } from "../../../agent/openwiki-ignore.js";
import { ClaimSessionError } from "../../core/errors.js";
import type {
  Claim,
  ClaimOperation,
  EvidenceResolver,
  ResolvedEvidence,
} from "../../core/types.js";
import type { ClaimSession } from "./session.js";
import {
  formatRepositoryEvidenceResource,
  parseRepositoryEvidenceResource,
} from "../../evidence/repository/resource.js";
import type { GroundingContext, GroundingIssue, PageClaims } from "./types.js";

/**
 * Maximum semantic claim decisions requested from one model call.
 */
const MAX_BATCH_CLAIMS = 24;

/**
 * Soft evidence-content budget for one reconciliation prompt.
 */
const MAX_BATCH_EVIDENCE_CHARACTERS = 120_000;

/**
 * Maximum reconciliation model calls allowed to run concurrently.
 */
export const CLAIMS_RECONCILIATION_CONCURRENCY = 3;

/**
 * Maximum deterministic evidence resolutions allowed in flight.
 */
const EVIDENCE_RESOLUTION_CONCURRENCY = 16;

/**
 * Attempts allowed for a malformed or incomplete structured response.
 */
const MAX_BATCH_ATTEMPTS = 2;

/**
 * Bounded current-source candidates supplied for one unresolved repository path.
 */
const MAX_UNRESOLVED_CANDIDATES = 8;

/**
 * Stable model-call tag used to keep direct reconciliation output off streams.
 */
const NOSTREAM_TAG = "langsmith:nostream";

const CanonicalNonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), {
    message: "Must not contain surrounding whitespace",
  });

const ProposedEvidenceSchema = z
  .object({ resource: CanonicalNonEmptyStringSchema })
  .strict();

const ReconciliationDecisionSchema = z.discriminatedUnion("disposition", [
  z
    .object({
      page: CanonicalNonEmptyStringSchema,
      claimId: CanonicalNonEmptyStringSchema,
      disposition: z.literal("reaffirm"),
      statement: CanonicalNonEmptyStringSchema,
      evidence: z.array(ProposedEvidenceSchema).min(1),
    })
    .strict(),
  z
    .object({
      page: CanonicalNonEmptyStringSchema,
      claimId: CanonicalNonEmptyStringSchema,
      disposition: z.literal("revise"),
      statement: CanonicalNonEmptyStringSchema,
      evidence: z.array(ProposedEvidenceSchema).min(1),
    })
    .strict(),
  z
    .object({
      page: CanonicalNonEmptyStringSchema,
      claimId: CanonicalNonEmptyStringSchema,
      disposition: z.literal("delete"),
    })
    .strict(),
]);

const ReconciliationResponseSchema = z
  .object({
    reconciliations: z.array(ReconciliationDecisionSchema),
  })
  .strict();

type ReconciliationDecision = z.infer<typeof ReconciliationDecisionSchema>;
type ReconciliationResponse = z.infer<typeof ReconciliationResponseSchema>;

/**
 * Immutable semantic work for one preflight claim issue.
 */
interface ReconciliationTask {
  page: string;
  claim: Claim;
  issue: GroundingIssue & { claimId: string };
}

/**
 * One resolved source snapshot shared by every concurrent proposal call.
 */
interface EvidenceSnapshot {
  resource: string;
  resolved: ResolvedEvidence | null;
}

/**
 * One immutable evidence inventory shared by every proposal batch.
 */
interface EvidenceInventory {
  snapshots: Map<string, EvidenceSnapshot>;
  candidatesByUnresolvedResource: Map<string, string[]>;
}

/**
 * Page-agnostic proposal batch. Calls may overlap by page but never by claim.
 */
interface ReconciliationBatch {
  kind: "evidence-changed" | "unresolved";
  tasks: ReconciliationTask[];
}

/**
 * Inputs owned by the prepared Claims runtime.
 */
export interface ClaimsReconciliationInput {
  context: GroundingContext;
  persisted: ReadonlyMap<string, PageClaims>;
  resolver: EvidenceResolver;
  session: ClaimSession;

  /**
   * Repository root used for bounded unresolved-path candidate discovery.
   */
  rootDir?: string;

  /**
   * Repository read boundary applied during candidate discovery.
   */
  openWikiIgnore?: OpenWikiIgnore;
}

/**
 * Summary of a completed pre-agent reconciliation pass.
 */
export interface ClaimsReconciliationResult {
  batchCount: number;
  claimCount: number;
  pageCount: number;
}

/**
 * Reconciles every claim-level preflight issue before the documentation agent.
 *
 * Model calls operate only on immutable snapshots and return proposals. The
 * proposals are validated as one complete set before mutations are grouped and
 * atomically applied page-by-page to the run-scoped Claim session.
 *
 * @param model - Provider-independent structured-output chat model.
 * @param input - Prepared persisted Claims state and deterministic resolver.
 * @param onStatus - Optional user-visible status sink.
 * @returns Counts for debugging and progress reporting.
 */
export async function reconcileClaimsBeforeAgent(
  model: BaseChatModel,
  input: ClaimsReconciliationInput,
  onStatus?: (message: string) => void,
): Promise<ClaimsReconciliationResult> {
  const tasks = collectTasks(input.context, input.persisted);
  if (tasks.length === 0) {
    return { batchCount: 0, claimCount: 0, pageCount: 0 };
  }

  const evidence = await snapshotEvidence(tasks, input);
  const batches = createBatches(tasks, evidence);
  const pages = new Set(tasks.map((task) => task.page));
  onStatus?.(
    `Reconciling ${tasks.length} changed claim${tasks.length === 1 ? "" : "s"} across ${pages.size} page${pages.size === 1 ? "" : "s"}...`,
  );

  const batchDecisions = await mapWithConcurrency(
    batches,
    CLAIMS_RECONCILIATION_CONCURRENCY,
    (batch) => reconcileBatch(model, batch, evidence),
  );
  const decisions = batchDecisions.flat();
  validateCompleteDecisionSet(tasks, decisions);

  const operationsByPage = groupOperationsByPage(tasks, decisions);
  for (const [page, operations] of operationsByPage) {
    await input.session.updateClaims({ page, operations });
  }
  replaceReconciledContext(input.context, tasks);

  return {
    batchCount: batches.length,
    claimCount: tasks.length,
    pageCount: pages.size,
  };
}

/**
 * Selects persisted claim issues that require semantic disposition.
 */
function collectTasks(
  context: GroundingContext,
  persisted: ReadonlyMap<string, PageClaims>,
): ReconciliationTask[] {
  const tasks: ReconciliationTask[] = [];
  for (const issue of context.issues) {
    if (
      (issue.kind !== "stale" && issue.kind !== "unresolved") ||
      !issue.claimId
    ) {
      continue;
    }
    const claim = persisted
      .get(issue.page)
      ?.claims.find((candidate) => candidate.id === issue.claimId);
    if (!claim) {
      throw new ClaimSessionError(
        `Claims reconciliation could not load ${issue.claimId} for ${issue.page}.`,
      );
    }
    tasks.push({
      page: issue.page,
      claim: cloneClaim(claim),
      issue: { ...issue, claimId: issue.claimId },
    });
  }
  return tasks.sort(
    (left, right) =>
      left.page.localeCompare(right.page) ||
      left.claim.id.localeCompare(right.claim.id),
  );
}

/**
 * Resolves every evidence resource once before concurrent model calls start.
 */
async function snapshotEvidence(
  tasks: readonly ReconciliationTask[],
  input: ClaimsReconciliationInput,
): Promise<EvidenceInventory> {
  const resources = [
    ...new Set(
      tasks.flatMap((task) => task.claim.evidence.map((item) => item.resource)),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const snapshots = await mapWithConcurrency(
    resources,
    EVIDENCE_RESOLUTION_CONCURRENCY,
    async (resource) => ({
      resource,
      resolved: await input.resolver.resolve(resource),
    }),
  );
  const snapshotMap = new Map(
    snapshots.map((snapshot) => [snapshot.resource, snapshot]),
  );
  const candidatesByUnresolvedResource = await discoverUnresolvedCandidates(
    tasks,
    input,
    snapshotMap,
  );
  return { snapshots: snapshotMap, candidatesByUnresolvedResource };
}

/**
 * Finds a small path-similar current-source set for unresolved repository
 * evidence. Candidates are resolved and supplied with content, so the model may
 * retarget only to evidence it actually inspected rather than inventing paths.
 */
async function discoverUnresolvedCandidates(
  tasks: readonly ReconciliationTask[],
  input: ClaimsReconciliationInput,
  snapshots: Map<string, EvidenceSnapshot>,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!input.rootDir || !input.openWikiIgnore) {
    return result;
  }

  const unresolvedResources = [
    ...new Set(
      tasks
        .filter((task) => task.issue.kind === "unresolved")
        .flatMap((task) => task.issue.resources ?? []),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (unresolvedResources.length === 0) {
    return result;
  }

  const repositoryResources = unresolvedResources.flatMap((resource) => {
    try {
      return [{ resource, parsed: parseRepositoryEvidenceResource(resource) }];
    } catch {
      return [];
    }
  });
  if (repositoryResources.length === 0) {
    return result;
  }

  const paths = await collectRepositoryCandidatePaths(
    input.rootDir,
    input.openWikiIgnore,
  );
  for (const { resource, parsed } of repositoryResources) {
    const ranked = paths
      .map((candidatePath) => ({
        path: candidatePath,
        score: scoreCandidatePath(parsed.path, candidatePath),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.path.localeCompare(right.path),
      )
      .slice(0, MAX_UNRESOLVED_CANDIDATES);
    const candidates: string[] = [];
    for (const candidate of ranked) {
      const candidateResource = formatRepositoryEvidenceResource({
        path: candidate.path,
      });
      if (!snapshots.has(candidateResource)) {
        try {
          snapshots.set(candidateResource, {
            resource: candidateResource,
            resolved: await input.resolver.resolve(candidateResource),
          });
        } catch {
          continue;
        }
      }
      if (snapshots.get(candidateResource)?.resolved) {
        candidates.push(candidateResource);
      }
    }
    result.set(resource, candidates);
  }
  return result;
}

/**
 * Enumerates safe regular repository files without following symbolic links.
 */
async function collectRepositoryCandidatePaths(
  rootDir: string,
  openWikiIgnore: OpenWikiIgnore,
): Promise<string[]> {
  const files: string[] = [];

  async function walk(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (
          entry.name === ".git" ||
          entry.name === "node_modules" ||
          relative === "openwiki" ||
          openWikiIgnore.ignores(relative, true)
        ) {
          continue;
        }
        await walk(path.join(directory, entry.name), relative);
        continue;
      }
      if (
        entry.isFile() &&
        !openWikiIgnore.ignores(relative) &&
        !isSensitiveCandidatePath(relative)
      ) {
        files.push(relative);
      }
    }
  }

  await walk(rootDir, "");
  return files;
}

/**
 * Excludes common credential containers from speculative candidate reads.
 */
function isSensitiveCandidatePath(filePath: string): boolean {
  const name = path.posix.basename(filePath).toLowerCase();
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    [".key", ".p12", ".pem", ".pfx"].some((extension) =>
      name.endsWith(extension),
    )
  );
}

/**
 * Ranks likely renames or neighboring replacements for one missing path.
 */
function scoreCandidatePath(
  missingPath: string,
  candidatePath: string,
): number {
  const missingDirectory = path.posix.dirname(missingPath);
  const candidateDirectory = path.posix.dirname(candidatePath);
  const missingExtension = path.posix.extname(missingPath).toLowerCase();
  const candidateExtension = path.posix.extname(candidatePath).toLowerCase();
  const missingTokens = pathTokens(missingPath);
  const candidateTokens = new Set(pathTokens(candidatePath));
  const sharedTokens = missingTokens.filter((token) =>
    candidateTokens.has(token),
  ).length;

  if (missingDirectory !== candidateDirectory && sharedTokens === 0) {
    return 0;
  }

  return (
    (missingDirectory === candidateDirectory ? 30 : 0) +
    (missingExtension === candidateExtension ? 5 : 0) +
    sharedTokens * 12
  );
}

/**
 * Produces normalized path terms used only for deterministic candidate ranking.
 */
function pathTokens(filePath: string): string[] {
  return path.posix
    .basename(filePath, path.posix.extname(filePath))
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1);
}

/**
 * Packs issue classes independently so unresolved work can run concurrently
 * with ordinary evidence-changed judgments.
 */
function createBatches(
  tasks: readonly ReconciliationTask[],
  evidence: EvidenceInventory,
): ReconciliationBatch[] {
  return (["stale", "unresolved"] as const).flatMap((issueKind) => {
    const selected = tasks
      .filter((task) => task.issue.kind === issueKind)
      .sort((left, right) =>
        issueKind === "unresolved"
          ? (left.issue.resources ?? [])
              .join("\u0000")
              .localeCompare((right.issue.resources ?? []).join("\u0000")) ||
            left.page.localeCompare(right.page) ||
            left.claim.id.localeCompare(right.claim.id)
          : left.page.localeCompare(right.page) ||
            left.claim.id.localeCompare(right.claim.id),
      );
    const batches: ReconciliationBatch[] = [];
    let current: ReconciliationTask[] = [];

    for (const task of selected) {
      const candidate = [...current, task];
      if (
        current.length > 0 &&
        (candidate.length > MAX_BATCH_CLAIMS ||
          evidenceCharacters(candidate, evidence) >
            MAX_BATCH_EVIDENCE_CHARACTERS)
      ) {
        batches.push({
          kind: issueKind === "stale" ? "evidence-changed" : "unresolved",
          tasks: current,
        });
        current = [task];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) {
      batches.push({
        kind: issueKind === "stale" ? "evidence-changed" : "unresolved",
        tasks: current,
      });
    }
    return batches;
  });
}

/**
 * Counts unique resolved source characters included by a proposed batch.
 */
function evidenceCharacters(
  tasks: readonly ReconciliationTask[],
  evidence: EvidenceInventory,
): number {
  const resources = new Set(
    tasks.flatMap((task) => [
      ...task.claim.evidence.map((item) => item.resource),
      ...(task.issue.resources ?? []).flatMap(
        (resource) =>
          evidence.candidatesByUnresolvedResource.get(resource) ?? [],
      ),
    ]),
  );
  return [...resources].reduce(
    (total, resource) =>
      total + (evidence.snapshots.get(resource)?.resolved?.content.length ?? 0),
    0,
  );
}

/**
 * Requests one strict disposition for every claim in a proposal batch.
 */
async function reconcileBatch(
  model: BaseChatModel,
  batch: ReconciliationBatch,
  evidence: EvidenceInventory,
): Promise<ReconciliationDecision[]> {
  const systemPrompt = buildSystemPrompt(batch.kind);
  const taskPrompt = buildTaskPrompt(batch, evidence);
  let finalError: unknown;

  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
    try {
      const runnable = model.withStructuredOutput<ReconciliationResponse>(
        ReconciliationResponseSchema,
      );
      const raw = await runnable.invoke(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: taskPrompt },
          ...(attempt > 1
            ? [
                {
                  role: "user" as const,
                  content: `The previous response was invalid: ${summarizeError(finalError)}. Return the complete corrected structured response.`,
                },
              ]
            : []),
        ],
        { tags: [NOSTREAM_TAG] },
      );
      const response = ReconciliationResponseSchema.parse(raw);
      validateBatchDecisionSet(batch.tasks, response.reconciliations);
      validateDecisionEvidence(
        response.reconciliations,
        evidence,
        new Set(batchEvidenceResources(batch, evidence)),
      );
      return response.reconciliations;
    } catch (error) {
      finalError = error;
    }
  }

  throw new ClaimSessionError(
    `Claims ${batch.kind} reconciliation failed after ${MAX_BATCH_ATTEMPTS} attempts: ${summarizeError(finalError)}`,
  );
}

/**
 * Builds stable semantic rules for direct Claims disposition calls.
 */
function buildSystemPrompt(kind: ReconciliationBatch["kind"]): string {
  return `You reconcile persisted factual Claims against current repository evidence.
Every supplied claim is mandatory work. Return exactly one disposition for every claimId and preserve its exact page.

- reaffirm: the existing statement remains fully supported. Copy the statement exactly and list only presented, resolved evidence resources that support it.
- revise: the existing statement is no longer fully correct but a corrected statement is supported. Return the complete corrected statement and only presented, resolved evidence resources.
- delete: current presented evidence cannot support a truthful replacement.

Evidence-changed means content changed, not that the statement is necessarily obsolete. Unresolved resources have no current content and must never be returned as evidence. Do not invent resource identities, facts, files, or symbols. Prefer deletion over an unsupported guess.
This batch contains ${kind} work. Return structured data only.`;
}

/**
 * Serializes claims and de-duplicated evidence snapshots for one model call.
 */
function buildTaskPrompt(
  batch: ReconciliationBatch,
  evidence: EvidenceInventory,
): string {
  const resources = batchEvidenceResources(batch, evidence);
  return JSON.stringify(
    {
      claims: batch.tasks.map((task) => ({
        page: task.page,
        claimId: task.claim.id,
        statement: task.claim.statement,
        evidence: task.claim.evidence.map((item) => item.resource),
        issue: {
          kind:
            task.issue.kind === "stale" ? "evidence-changed" : task.issue.kind,
          resources: task.issue.resources ?? [],
          candidates: (task.issue.resources ?? []).flatMap(
            (resource) =>
              evidence.candidatesByUnresolvedResource.get(resource) ?? [],
          ),
        },
      })),
      currentEvidence: resources.map((resource) => {
        const snapshot = evidence.snapshots.get(resource);
        return snapshot?.resolved
          ? {
              resource,
              status: "resolved",
              currentVersion: snapshot.resolved.evidence.version,
              content: snapshot.resolved.content,
            }
          : { resource, status: "unresolved" };
      }),
    },
    null,
    2,
  );
}

/**
 * Returns the exact de-duplicated evidence identities exposed to one batch.
 */
function batchEvidenceResources(
  batch: ReconciliationBatch,
  evidence: EvidenceInventory,
): string[] {
  return [
    ...new Set(
      batch.tasks.flatMap((task) => [
        ...task.claim.evidence.map((item) => item.resource),
        ...(task.issue.resources ?? []).flatMap(
          (resource) =>
            evidence.candidatesByUnresolvedResource.get(resource) ?? [],
        ),
      ]),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

/**
 * Requires exact claim coverage within one model response.
 */
function validateBatchDecisionSet(
  tasks: readonly ReconciliationTask[],
  decisions: readonly ReconciliationDecision[],
): void {
  const expected = new Map(
    tasks.map((task) => [decisionKey(task.page, task.claim.id), task]),
  );
  const seen = new Set<string>();
  for (const decision of decisions) {
    const key = decisionKey(decision.page, decision.claimId);
    const task = expected.get(key);
    if (!task) {
      throw new ClaimSessionError(
        `Unexpected reconciliation decision for ${decision.claimId} on ${decision.page}.`,
      );
    }
    if (seen.has(key)) {
      throw new ClaimSessionError(
        `Duplicate reconciliation decision for ${decision.claimId} on ${decision.page}.`,
      );
    }
    if (
      decision.disposition === "reaffirm" &&
      decision.statement !== task.claim.statement
    ) {
      throw new ClaimSessionError(
        `Reaffirmed claim ${decision.claimId} must preserve its exact statement.`,
      );
    }
    seen.add(key);
  }
  const missing = [...expected.keys()].filter((key) => !seen.has(key));
  if (missing.length > 0) {
    throw new ClaimSessionError(
      `Reconciliation response omitted ${missing.length} required claim${missing.length === 1 ? "" : "s"}.`,
    );
  }
}

/**
 * Requires exact coverage again after concurrently completed batches are joined.
 */
function validateCompleteDecisionSet(
  tasks: readonly ReconciliationTask[],
  decisions: readonly ReconciliationDecision[],
): void {
  validateBatchDecisionSet(tasks, decisions);
}

/**
 * Ensures every proposed evidence resource was presented and currently resolves.
 */
function validateDecisionEvidence(
  decisions: readonly ReconciliationDecision[],
  evidence: EvidenceInventory,
  allowedResources: ReadonlySet<string>,
): void {
  for (const decision of decisions) {
    if (decision.disposition === "delete") {
      continue;
    }
    for (const proposed of decision.evidence) {
      const snapshot = evidence.snapshots.get(proposed.resource);
      if (!allowedResources.has(proposed.resource) || !snapshot?.resolved) {
        throw new ClaimSessionError(
          `Claim ${decision.claimId} proposed unavailable evidence: ${proposed.resource}`,
        );
      }
    }
  }
}

/**
 * Reduces pure claim decisions into one atomic mutation batch per page.
 */
function groupOperationsByPage(
  tasks: readonly ReconciliationTask[],
  decisions: readonly ReconciliationDecision[],
): Map<string, ClaimOperation[]> {
  const taskOrder = new Map(
    tasks.map((task, index) => [decisionKey(task.page, task.claim.id), index]),
  );
  const ordered = [...decisions].sort(
    (left, right) =>
      (taskOrder.get(decisionKey(left.page, left.claimId)) ?? 0) -
      (taskOrder.get(decisionKey(right.page, right.claimId)) ?? 0),
  );
  const grouped = new Map<string, ClaimOperation[]>();
  for (const decision of ordered) {
    const operation: ClaimOperation =
      decision.disposition === "delete"
        ? { op: "delete", id: decision.claimId }
        : {
            op: "update",
            id: decision.claimId,
            statement: decision.statement,
            evidence: decision.evidence,
          };
    const operations = grouped.get(decision.page) ?? [];
    operations.push(operation);
    grouped.set(decision.page, operations);
  }
  return grouped;
}

/**
 * Replaces reconciled claim issues with one page-level authoring obligation.
 */
function replaceReconciledContext(
  context: GroundingContext,
  tasks: readonly ReconciliationTask[],
): void {
  const reconciledKeys = new Set(
    tasks.map((task) => decisionKey(task.page, task.claim.id)),
  );
  const reconciledPages = new Set(tasks.map((task) => task.page));
  const remaining = context.issues.filter(
    (issue) =>
      !issue.claimId ||
      !reconciledKeys.has(decisionKey(issue.page, issue.claimId)),
  );
  for (const page of [...reconciledPages].sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (
      !remaining.some(
        (issue) => issue.page === page && issue.kind === "out-of-sync-page",
      )
    ) {
      remaining.push({ page, kind: "out-of-sync-page" });
    }
  }
  context.issues = remaining.sort(
    (left, right) =>
      left.page.localeCompare(right.page) ||
      left.kind.localeCompare(right.kind),
  );
}

/**
 * Runs asynchronous work through a small fixed worker pool.
 */
async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(inputs[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Builds an unambiguous page-and-claim identity key.
 */
function decisionKey(page: string, claimId: string): string {
  return `${page}\u0000${claimId}`;
}

/**
 * Clones one persisted claim across reconciliation ownership boundaries.
 */
function cloneClaim(claim: Claim): Claim {
  return {
    ...claim,
    evidence: claim.evidence.map((item) => ({ ...item })),
  };
}

/**
 * Keeps provider or schema failures concise and out of user prompts.
 */
function summarizeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown model failure";
  }
  return `${error.name}: ${error.message.replace(/\s+/gu, " ").trim().slice(0, 500)}`;
}
