import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RunnableConfig } from "@langchain/core/runnables";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ClaimsStore } from "../../../src/claims/brains/code/store.ts";
import type { PageClaims } from "../../../src/claims/brains/code/types.ts";
import type {
  EvidenceResolver,
  ResolvedEvidence,
} from "../../../src/claims/core/types.ts";
import type {
  GenerationSummary,
  PageJob,
  PageResult,
  ReviewOutput,
} from "../../../src/agent/generation/contracts.ts";
import type { PageGraphRunner } from "../../../src/agent/generation/page-graph.ts";
import { PendingWorkStore } from "../../../src/agent/generation/pending-work-store.ts";
import type { GenerationSpecialists } from "../../../src/agent/generation/specialists.ts";
import {
  createUpdateGraph,
  type UpdateGraphInitialState,
} from "../../../src/agent/generation/update-graph.ts";
import { OpenWikiIgnore } from "../../../src/agent/openwiki-ignore.ts";

const execFileAsync = promisify(execFile);
const runtimePage = "/openwiki/architecture/runtime.md";
const baseResource = "repo://src/base.ts#run";

type ReviewStep =
  | ReviewOutput
  | Error
  | ((
      task: string,
      evidence: unknown,
      config?: RunnableConfig,
    ) => ReviewOutput);

/**
 * Deterministic review specialist used by UpdateGraph tests.
 */
class ScriptedReviewSpecialists implements GenerationSpecialists {
  /**
   * Review calls in graph order.
   */
  readonly calls: Array<{
    task: string;
    evidence: unknown;
    config?: RunnableConfig;
  }> = [];

  constructor(private readonly steps: ReviewStep[]) {}

  reconcilePage(): Promise<never> {
    return Promise.reject(new Error("Unexpected page reconciliation."));
  }

  authorPage(): Promise<never> {
    return Promise.reject(new Error("Unexpected page authoring."));
  }

  discover(): Promise<never> {
    return Promise.reject(new Error("Unexpected repository discovery."));
  }

  async review(
    task: string,
    evidence: unknown,
    config?: RunnableConfig,
  ): Promise<ReviewOutput> {
    this.calls.push({ task, evidence, config });
    const step = this.steps.shift();
    if (!step) throw new Error("Missing scripted review step.");
    if (step instanceof Error) throw step;
    return await Promise.resolve(
      typeof step === "function" ? step(task, evidence, config) : step,
    );
  }
}

type PageHandler = (
  job: PageJob,
  config?: RunnableConfig,
) => PageResult | Promise<PageResult>;

/**
 * PageGraph double that measures fan-out and mirrors pending completion.
 */
class RecordingPages implements PageGraphRunner {
  /**
   * Jobs observed in start order.
   */
  readonly jobs: PageJob[] = [];

  /**
   * Runnable configurations observed per page.
   */
  readonly configs: Array<RunnableConfig | undefined> = [];

  /**
   * Highest simultaneous page invocation count.
   */
  maxActive = 0;

  /**
   * Current simultaneous page invocation count.
   */
  private active = 0;

  constructor(
    private readonly pending: PendingWorkStore,
    private readonly handler: PageHandler = (job) => pageResult(job),
  ) {}

  async run(job: PageJob, config?: RunnableConfig): Promise<PageResult> {
    this.jobs.push(structuredClone(job));
    this.configs.push(config);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const result = await this.handler(job, config);
      if (["committed", "unchanged", "deleted"].includes(result.status)) {
        await this.pending.complete(job.id);
      }
      return result;
    } finally {
      this.active -= 1;
    }
  }
}

describe("UpdateGraph", () => {
  let rootDir: string;
  let previousHead: string;
  let claimsStore: ClaimsStore;
  let pending: PendingWorkStore;
  let evidence: Map<string, ResolvedEvidence | null>;
  let resolver: EvidenceResolver;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-update-graph-"));
    await git("init", "--initial-branch=main");
    await write(
      ".gitignore",
      ".env\n.env.*\n*.pem\n*.key\n*.crt\ncredentials.json\nnode_modules/\n.DS_Store\n",
    );
    await write("src/base.ts", "export function run() { return 1; }\n");
    await stageAndCommit("initial update fixture");
    previousHead = await git("rev-parse", "HEAD");
    claimsStore = new ClaimsStore(rootDir);
    pending = new PendingWorkStore(
      rootDir,
      () => new Date("2026-08-14T12:00:00Z"),
    );
    evidence = new Map();
    resolver = {
      resolve(resource) {
        return Promise.resolve(evidence.get(resource) ?? null);
      },
    };
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  test("finishes a true no-op without model calls or page fan-out", async () => {
    const specialists = new ScriptedReviewSpecialists([]);
    const pages = new RecordingPages(pending);

    const summary = await invoke(specialists, pages);

    expect(summary).toEqual(emptySummary());
    expect(specialists.calls).toHaveLength(0);
    expect(pages.jobs).toHaveLength(0);
    await expect(pending.list()).resolves.toEqual([]);
  });

  test("runs mandatory Claims-only work even when the planner adds nothing", async () => {
    await seedClaimPage(runtimePage, [claim(baseResource, "version:old")]);
    evidence.set(baseResource, resolved(baseResource, "version:new"));
    const specialists = new ScriptedReviewSpecialists([
      emptyReview(),
      emptyReview(),
    ]);
    const pages = new RecordingPages(pending);

    const summary = await invoke(specialists, pages);

    expect(pages.jobs).toHaveLength(1);
    expect(pages.jobs[0]).toMatchObject({
      page: runtimePage,
      operation: "reconcile",
      reasons: ["claims:stale:claim_0"],
    });
    expect(summary).toMatchObject({
      status: "complete",
      planned: 1,
      committed: 1,
      pending: 0,
    });
  });

  test("runs inherited pending page work and clears it only after success", async () => {
    await pending.add({
      id: "pending:runtime",
      kind: "page",
      page: runtimePage,
      reason: "Prior repair remains unfinished.",
      sourceHints: ["src/base.ts"],
    });
    const specialists = new ScriptedReviewSpecialists([
      emptyReview(),
      emptyReview(),
    ]);
    const pages = new RecordingPages(pending);

    const summary = await invoke(specialists, pages);

    expect(pages.jobs).toHaveLength(1);
    expect(pages.jobs[0]).toMatchObject({
      operation: "repair",
      reasons: ["pending:runtime"],
    });
    expect(summary.pending).toBe(0);
    await expect(pending.list()).resolves.toEqual([]);
  });

  test("maps a Git-only source change through persisted evidence", async () => {
    await seedClaimPage(runtimePage, [claim(baseResource, "version:1")]);
    evidence.set(baseResource, resolved(baseResource, "version:1"));
    await write("src/base.ts", "export function run() { return 2; }\n");
    const specialists = new ScriptedReviewSpecialists([
      emptyReview(),
      emptyReview(),
    ]);
    const pages = new RecordingPages(pending);

    await invoke(specialists, pages);

    expect(pages.jobs).toHaveLength(1);
    expect(pages.jobs[0]).toMatchObject({
      page: runtimePage,
      operation: "reconcile",
      reasons: ["git:evidence-match"],
      sourceHints: ["src/base.ts"],
    });
  });

  test("uses planner jobs for otherwise unmapped Git changes", async () => {
    await write("src/unmapped.ts", "export const unmapped = true;\n");
    const specialists = new ScriptedReviewSpecialists([
      reviewWithJobs([reviewJob(runtimePage, "create", ["src/unmapped.ts"])]),
      emptyReview(),
    ]);
    const pages = new RecordingPages(pending);

    const summary = await invoke(specialists, pages);

    expect(pages.jobs).toHaveLength(1);
    expect(pages.jobs[0]).toMatchObject({
      page: runtimePage,
      operation: "create",
      sourceHints: ["src/unmapped.ts"],
    });
    expect(summary).toMatchObject({ status: "complete", planned: 1 });
  });

  test("never accepts deletion authority from the planner", async () => {
    await write("src/unmapped.ts", "export const unmapped = true;\n");
    const specialists = new ScriptedReviewSpecialists([
      reviewWithJobs([reviewJob(runtimePage, "delete", ["src/unmapped.ts"])]),
      emptyReview(),
    ]);
    const pages = new RecordingPages(pending);

    await invoke(specialists, pages);

    expect(pages.jobs[0].operation).toBe("reconcile");
  });

  test("degrades after two planner failures and persists every unmapped change", async () => {
    await write("src/unmapped.ts", "export const unmapped = true;\n");
    const specialists = new ScriptedReviewSpecialists([
      retryableFailure("planner unavailable once"),
      retryableFailure("planner unavailable twice"),
    ]);
    const pages = new RecordingPages(pending);

    const summary = await invoke(specialists, pages);
    const remaining = await pending.list();

    expect(specialists.calls).toHaveLength(2);
    expect(pages.jobs).toHaveLength(0);
    expect(summary).toMatchObject({
      status: "partial",
      planned: 0,
      pending: 2,
    });
    expect(remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "review:update:planner" }),
        expect.objectContaining({
          kind: "unmapped-change",
          sourceHints: ["src/unmapped.ts"],
        }),
      ]),
    );
  });

  test("stops a terminal planner failure after its actual invocation", async () => {
    await write("src/unmapped.ts", "export const unmapped = true;\n");
    const terminal = Object.assign(new Error("invalid API key"), {
      status: 401,
    });
    const specialists = new ScriptedReviewSpecialists([terminal]);

    const summary = await invoke(specialists, new RecordingPages(pending));

    expect(specialists.calls).toHaveLength(1);
    expect(summary.status).toBe("partial");
  });

  test("joins parallel page fan-out before review and honors maxConcurrency four", async () => {
    await write("src/unmapped.ts", "export const unmapped = true;\n");
    const jobs = Array.from({ length: 6 }, (_, index) =>
      reviewJob(`/openwiki/generated/page-${index}.md`, "create", [
        "src/unmapped.ts",
      ]),
    );
    const specialists = new ScriptedReviewSpecialists([
      reviewWithJobs(jobs),
      (_task, reviewEvidence) => {
        const results = (reviewEvidence as { results: PageResult[] }).results;
        expect(results).toHaveLength(6);
        return emptyReview();
      },
    ]);
    const pages = new RecordingPages(pending, async (job) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return pageResult(job);
    });

    const summary = await invoke(specialists, pages);

    expect(pages.jobs).toHaveLength(6);
    expect(pages.maxActive).toBe(4);
    expect(pages.configs.every((config) => config?.maxConcurrency === 4)).toBe(
      true,
    );
    expect(summary).toMatchObject({ planned: 6, committed: 6, pending: 0 });
  });

  test("serializes same-page deterministic and planner work into one job", async () => {
    await seedClaimPage(runtimePage, [claim(baseResource, "version:1")]);
    evidence.set(baseResource, resolved(baseResource, "version:1"));
    await write("src/base.ts", "export function run() { return 2; }\n");
    const specialists = new ScriptedReviewSpecialists([
      reviewWithJobs([reviewJob(runtimePage, "repair", ["src/base.ts"])]),
      emptyReview(),
    ]);
    const pages = new RecordingPages(pending);

    await invoke(specialists, pages);

    expect(pages.jobs).toHaveLength(1);
    expect(pages.jobs[0]).toMatchObject({
      page: runtimePage,
      operation: "repair",
      reasons: ["git:evidence-match", "review-job"],
    });
  });

  test("runs exactly one changed-surface repair wave", async () => {
    await write("src/unmapped.ts", "export const unmapped = true;\n");
    const secondPage = "/openwiki/architecture/worker.md";
    const specialists = new ScriptedReviewSpecialists([
      reviewWithJobs([reviewJob(runtimePage, "create", ["src/unmapped.ts"])]),
      reviewWithJobs([
        reviewJob(runtimePage, "reconcile", ["src/unmapped.ts"]),
        reviewJob(secondPage, "create", ["src/unmapped.ts"]),
      ]),
    ]);
    const pages = new RecordingPages(pending);

    const summary = await invoke(specialists, pages);

    expect(specialists.calls).toHaveLength(2);
    expect(pages.jobs.map(({ wave }) => wave)).toEqual([0, 1, 1]);
    expect(
      pages.jobs.slice(1).every(({ operation }) => operation === "repair"),
    ).toBe(true);
    expect(summary).toMatchObject({ planned: 3, committed: 2 });
  });

  test("persists changed-surface reviewer outage instead of failing the update", async () => {
    await write("src/unmapped.ts", "export const unmapped = true;\n");
    const specialists = new ScriptedReviewSpecialists([
      reviewWithJobs([reviewJob(runtimePage, "create", ["src/unmapped.ts"])]),
      new DOMException("review timed out", "TimeoutError"),
    ]);
    const pages = new RecordingPages(pending);

    const summary = await invoke(specialists, pages);
    const remaining = await pending.list();

    expect(summary).toMatchObject({
      status: "partial",
      committed: 1,
      pending: 1,
    });
    expect(remaining).toMatchObject([
      { id: "review:update:0", kind: "review-gap" },
    ]);
  });

  test("summarizes latest page outcomes and unfinished work", async () => {
    await write("src/unmapped.ts", "export const unmapped = true;\n");
    const statuses: PageResult["status"][] = [
      "committed",
      "unchanged",
      "deleted",
      "failed",
      "deferred",
    ];
    const jobs = statuses.map((_, index) =>
      reviewJob(`/openwiki/status/page-${index}.md`, "create", [
        "src/unmapped.ts",
      ]),
    );
    const specialists = new ScriptedReviewSpecialists([
      reviewWithJobs(jobs),
      emptyReview(),
    ]);
    const pages = new RecordingPages(pending, (job) => {
      const index = Number(/page-(\d+)/u.exec(job.page)?.[1]);
      return pageResult(job, statuses[index]);
    });

    const summary = await invoke(specialists, pages);

    expect(summary).toEqual({
      status: "partial",
      planned: 5,
      committed: 1,
      unchanged: 1,
      deleted: 1,
      failed: 1,
      deferred: 1,
      pending: 2,
    });
  });

  test("nominates deletion only when every recorded repository resource is deleted", async () => {
    await seedClaimPage(runtimePage, [claim(baseResource, "version:1")]);
    evidence.set(baseResource, null);
    await rm(path.join(rootDir, "src/base.ts"));
    const specialists = new ScriptedReviewSpecialists([
      emptyReview(),
      emptyReview(),
    ]);
    const pages = new RecordingPages(pending);

    await invoke(specialists, pages);

    expect(pages.jobs).toHaveLength(1);
    expect(pages.jobs[0]).toMatchObject({
      page: runtimePage,
      operation: "delete",
    });
    expect(pages.jobs[0].reasons).toEqual(
      expect.arrayContaining([
        "claims:unresolved:claim_0",
        "git:all-evidence-files-deleted",
      ]),
    );
  });

  test("preserves a page when repository deletion provenance is mixed", async () => {
    await write("src/other.ts", "export const other = true;\n");
    await stageAndCommit("add second evidence source");
    previousHead = await git("rev-parse", "HEAD");
    const otherResource = "repo://src/other.ts";
    await seedClaimPage(runtimePage, [
      claim(baseResource, "version:1", "claim_base"),
      claim(otherResource, "version:1", "claim_other"),
    ]);
    evidence.set(baseResource, null);
    evidence.set(otherResource, resolved(otherResource, "version:1"));
    await rm(path.join(rootDir, "src/base.ts"));
    const specialists = new ScriptedReviewSpecialists([
      emptyReview(),
      emptyReview(),
    ]);
    const pages = new RecordingPages(pending);

    await invoke(specialists, pages);

    expect(pages.jobs).toHaveLength(1);
    expect(pages.jobs[0].operation).toBe("reconcile");
  });

  test("preserves a page when deletion provenance includes another namespace", async () => {
    const externalResource = "external://runtime";
    await seedClaimPage(runtimePage, [
      claim(baseResource, "version:1", "claim_base"),
      claim(externalResource, "version:1", "claim_external"),
    ]);
    evidence.set(baseResource, null);
    evidence.set(externalResource, resolved(externalResource, "version:1"));
    await rm(path.join(rootDir, "src/base.ts"));
    const specialists = new ScriptedReviewSpecialists([
      emptyReview(),
      emptyReview(),
    ]);
    const pages = new RecordingPages(pending);

    await invoke(specialists, pages);

    expect(pages.jobs).toHaveLength(1);
    expect(pages.jobs[0].operation).toBe("reconcile");
  });

  test("keeps a failed deterministic delete pending for the next update", async () => {
    await seedClaimPage(runtimePage, [claim(baseResource, "version:1")]);
    evidence.set(baseResource, null);
    await rm(path.join(rootDir, "src/base.ts"));
    const specialists = new ScriptedReviewSpecialists([
      emptyReview(),
      emptyReview(),
    ]);
    const pages = new RecordingPages(pending, (job) => {
      expect(job.operation).toBe("delete");
      return pageResult(job, "failed");
    });

    const summary = await invoke(specialists, pages);
    const remaining = await pending.list();

    expect(summary).toMatchObject({
      status: "partial",
      deleted: 0,
      failed: 1,
      pending: 1,
    });
    expect(remaining).toMatchObject([{ kind: "page", page: runtimePage }]);
  });

  test("propagates caller cancellation without persisting an outage", async () => {
    await write("src/unmapped.ts", "export const unmapped = true;\n");
    const caller = new AbortController();
    const specialists = new ScriptedReviewSpecialists([
      (_task, _evidence, config) => {
        expect(config?.signal).toBeDefined();
        caller.abort();
        expect(config?.signal?.aborted).toBe(true);
        throw caller.signal.reason;
      },
    ]);

    await expect(
      invoke(specialists, new RecordingPages(pending), {
        signal: caller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(pending.list()).resolves.toEqual([]);
  });

  /**
   * Invokes one graph with the required bounded concurrency.
   */
  async function invoke(
    specialists: GenerationSpecialists,
    pages: PageGraphRunner,
    config: RunnableConfig = {},
  ): Promise<GenerationSummary> {
    const graph = createUpdateGraph({
      rootDir,
      context: {
        lastUpdate: {
          updatedAt: "2026-08-14T00:00:00Z",
          command: "update",
          gitHead: previousHead,
          model: "scripted",
          status: "complete",
        },
      },
      openWikiIgnore: new OpenWikiIgnore([]),
      claimsStore,
      resolver,
      pending,
      pages,
      specialists,
    });
    const output = await graph.invoke(initialState(), {
      maxConcurrency: 4,
      ...config,
    });
    if (!output.summary) throw new Error("UpdateGraph returned no summary.");
    return output.summary;
  }

  /**
   * Writes and synchronizes one generated page Claim fixture.
   */
  async function seedClaimPage(
    page: string,
    claims: PageClaims["claims"],
  ): Promise<void> {
    const relativePage = page.replace(/^\/+/, "");
    await write(relativePage, `# ${path.basename(page, ".md")}\n`);
    await claimsStore.writePage(page, {
      schemaVersion: 1,
      pageVersion: await claimsStore.hashPage(page),
      claims,
    });
  }

  /**
   * Writes one fixture file below the temporary repository.
   */
  async function write(relativePath: string, content: string): Promise<void> {
    const absolute = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }

  /**
   * Runs one isolated Git fixture command.
   */
  async function git(...args: string[]): Promise<string> {
    const result = await execFileAsync(
      "git",
      [
        "-c",
        "user.name=OpenWiki Test",
        "-c",
        "user.email=openwiki-test@example.invalid",
        ...args,
      ],
      { cwd: rootDir },
    );
    return result.stdout.trim();
  }

  /**
   * Stages the isolated fixture, checks names, and creates one commit.
   */
  async function stageAndCommit(message: string): Promise<void> {
    await git("add", "--all");
    const staged = await git("diff", "--cached", "--name-only", "-z");
    const secretPath = staged
      .split("\0")
      .find((file) =>
        /(?:^|\/)(?:\.env(?:\..*)?|credentials\.json)$|\.(?:pem|key|crt)$/iu.test(
          file,
        ),
      );
    if (secretPath) {
      throw new Error(`Unsafe secret-like fixture path staged: ${secretPath}`);
    }
    await git("commit", "--quiet", "-m", message);
  }
});

/**
 * Creates complete empty UpdateGraph parent state.
 */
function initialState(): UpdateGraphInitialState {
  return {
    delta: null,
    inheritedPending: [],
    jobs: [],
    activeJob: null,
    results: [],
    plannedJobIds: [],
    reviewWave: 0,
    plannerInvocations: 0,
    summary: null,
  };
}

/**
 * Creates an empty successful reviewer output.
 */
function emptyReview(): ReviewOutput {
  return { jobs: [], gaps: [], resolvedPendingIds: [] };
}

/**
 * Creates a reviewer output containing page jobs.
 */
function reviewWithJobs(jobs: ReviewOutput["jobs"]): ReviewOutput {
  return { jobs, gaps: [], resolvedPendingIds: [] };
}

/**
 * Creates one structured reviewer page proposal.
 */
function reviewJob(
  page: string,
  operation: ReviewOutput["jobs"][number]["operation"],
  sourceHints: string[],
): ReviewOutput["jobs"][number] {
  return {
    page,
    operation,
    reasons: ["review-job"],
    sourceHints,
    priority: 500,
  };
}

/**
 * Creates one persisted Claim fixture.
 */
function claim(
  resource: string,
  version: string,
  id = "claim_0",
): PageClaims["claims"][number] {
  return {
    id,
    statement: `The runtime is supported by ${resource}.`,
    evidence: [{ resource, version }],
  };
}

/**
 * Creates one current evidence fixture.
 */
function resolved(resource: string, version: string): ResolvedEvidence {
  return {
    evidence: { resource, version },
    content: `current content for ${resource}`,
  };
}

/**
 * Creates one compact page result.
 */
function pageResult(
  job: PageJob,
  status: PageResult["status"] = "committed",
): PageResult {
  return {
    page: job.page,
    wave: job.wave,
    status,
    reconcilerInvocations: 1,
    authorInvocations: status === "deleted" ? 0 : 1,
    changedLinks: [],
    ...(status === "failed" || status === "deferred"
      ? {
          failure: {
            code:
              status === "deferred"
                ? ("deferred" as const)
                : ("page_invalid" as const),
            message: `${status} fixture`,
          },
        }
      : {}),
    durationMs: 1,
  };
}

/**
 * Creates the expected empty complete summary.
 */
function emptySummary(): GenerationSummary {
  return {
    status: "complete",
    planned: 0,
    committed: 0,
    unchanged: 0,
    deleted: 0,
    failed: 0,
    deferred: 0,
    pending: 0,
  };
}

/**
 * Creates one retryable provider-like failure.
 */
function retryableFailure(message: string): Error {
  return Object.assign(new Error(message), { status: 503 });
}
