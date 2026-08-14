import {
  AtomicRepositoryFiles,
  GenerationPersistenceError,
} from "./atomic-files.js";
import {
  PendingWorkDocumentSchema,
  PendingWorkItemSchema,
  type PendingWorkDocument,
  type PendingWorkItem,
  type PageJob,
  type ReviewGap,
} from "./contracts.js";

/**
 * Repository-relative OpenWiki-owned pending-work document.
 */
export const PENDING_WORK_PATH = "openwiki/.claims/pending-work.json";

/**
 * Mutable fields required to create or refresh one pending item.
 */
export type PendingWorkInput = Pick<
  PendingWorkItem,
  "id" | "kind" | "page" | "reason" | "sourceHints"
>;

/**
 * Atomic durable ledger of unfinished generation work.
 */
export class PendingWorkStore {
  /**
   * Safe repository file operations.
   */
  private readonly files: AtomicRepositoryFiles;

  /**
   * Timestamp source injected for deterministic tests.
   */
  private readonly now: () => Date;

  /**
   * Mutation tail serializing read-modify-write transactions.
   */
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(rootDir: string, now: () => Date = () => new Date()) {
    this.files = new AtomicRepositoryFiles(rootDir);
    this.now = now;
  }

  /**
   * Loads stable pending items and fails closed on malformed owned state.
   *
   * @returns Pending items sorted by ID.
   */
  async list(): Promise<PendingWorkItem[]> {
    await this.mutationTail;
    const document = await this.readDocument();
    return [...document.items].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  /**
   * Seeds page jobs before fan-out without losing earlier semantic gaps.
   *
   * @param jobs - Complete normalized jobs for the wave.
   */
  async seedJobs(jobs: readonly PageJob[]): Promise<void> {
    await this.mutate((items) => {
      for (const job of jobs) {
        upsert(items, this.createInputFromJob(job), this.now());
      }
    });
  }

  /**
   * Persists a reviewer gap that Claims preflight cannot rediscover.
   *
   * @param gap - Structured unresolved reviewer item.
   */
  async addReviewGap(gap: ReviewGap): Promise<void> {
    await this.mutate((items) => {
      upsert(
        items,
        {
          id: gap.id,
          kind: "review-gap",
          page: gap.page,
          reason: gap.reason,
          sourceHints: gap.sourceHints,
        },
        this.now(),
      );
    });
  }

  /**
   * Persists arbitrary bounded non-page work.
   *
   * @param input - Stable pending item identity and diagnostic.
   */
  async add(input: PendingWorkInput): Promise<void> {
    await this.mutate((items) => upsert(items, input, this.now()));
  }

  /**
   * Clears one durable obligation only after successful commit.
   *
   * @param id - Stable pending item identifier.
   */
  async complete(id: string): Promise<void> {
    await this.mutate((items) => {
      items.delete(id);
    });
  }

  /**
   * Clears several obligations after one repair satisfies them.
   *
   * @param ids - Stable pending item identifiers.
   */
  async completeMany(ids: readonly string[]): Promise<void> {
    await this.mutate((items) => {
      for (const id of ids) {
        items.delete(id);
      }
    });
  }

  /**
   * Creates the durable representation of one page job.
   *
   * @param job - Normalized page job.
   * @returns Pending-work input.
   */
  private createInputFromJob(job: PageJob): PendingWorkInput {
    return {
      id: job.id,
      kind: "page",
      page: job.page,
      reason: job.reasons.join(", ").slice(0, 1_000),
      sourceHints: job.sourceHints,
    };
  }

  /**
   * Serializes one atomic read-modify-write transaction.
   *
   * @param operation - Synchronous mutation over ID-keyed items.
   */
  private async mutate(
    operation: (items: Map<string, PendingWorkItem>) => void,
  ): Promise<void> {
    const run = this.mutationTail.then(async () => {
      const current = await this.readDocument();
      const items = new Map(current.items.map((item) => [item.id, item]));
      operation(items);
      const next = PendingWorkDocumentSchema.parse({
        schemaVersion: 1,
        items: [...items.values()].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      });
      await this.files.replaceText(
        PENDING_WORK_PATH,
        `${JSON.stringify(next, null, 2)}\n`,
      );
    });
    this.mutationTail = run.catch(() => undefined);
    return run;
  }

  /**
   * Reads and validates the owned pending document.
   *
   * @returns Existing or empty V1 document.
   */
  private async readDocument(): Promise<PendingWorkDocument> {
    const raw = await this.files.readText(PENDING_WORK_PATH);
    if (raw === null) {
      return { schemaVersion: 1, items: [] };
    }
    try {
      return PendingWorkDocumentSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new GenerationPersistenceError(
        `Invalid ${PENDING_WORK_PATH}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

/**
 * Inserts or refreshes one pending record.
 *
 * @param items - Mutable item map.
 * @param input - Stable identity and current diagnostic.
 * @param now - Transaction timestamp.
 */
function upsert(
  items: Map<string, PendingWorkItem>,
  input: PendingWorkInput,
  now: Date,
): void {
  const existing = items.get(input.id);
  if (
    existing &&
    (existing.kind !== input.kind || existing.page !== input.page)
  ) {
    throw new GenerationPersistenceError(
      `Pending work id ${input.id} cannot change kind or page ownership.`,
    );
  }
  const timestamp = now.toISOString();
  items.set(
    input.id,
    PendingWorkItemSchema.parse({
      ...input,
      attempts: (existing?.attempts ?? 0) + 1,
      firstSeenAt: existing?.firstSeenAt ?? timestamp,
      lastSeenAt: timestamp,
    }),
  );
}
