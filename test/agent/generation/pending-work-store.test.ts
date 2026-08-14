import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PageJob } from "../../../src/agent/generation/contracts.ts";
import { GenerationPersistenceError } from "../../../src/agent/generation/atomic-files.ts";
import {
  PENDING_WORK_PATH,
  PendingWorkStore,
  type PendingWorkInput,
} from "../../../src/agent/generation/pending-work-store.ts";

const page = "/openwiki/architecture/runtime.md";

/**
 * Creates one bounded pending item input.
 *
 * @param id - Stable work identifier.
 * @returns Valid pending work input.
 */
function pendingInput(id: string): PendingWorkInput {
  return {
    id,
    kind: "page",
    page,
    reason: `Reconcile ${id}.`,
    sourceHints: ["src/agent/index.ts"],
  };
}

/**
 * Creates one normalized page job for ledger seeding.
 *
 * @param id - Stable job identifier.
 * @returns Valid page job.
 */
function pageJob(id: string): PageJob {
  return {
    id,
    page,
    operation: "reconcile",
    reasons: ["claim-stale", "source-changed"],
    sourceHints: ["src/agent/index.ts"],
    wave: 0,
    priority: 500,
  };
}

describe("PendingWorkStore", () => {
  let rootDir: string;
  let cleanupDirectories: string[];
  let tick: number;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-pending-work-"));
    cleanupDirectories = [rootDir];
    tick = 0;
  });

  afterEach(async () => {
    await Promise.all(
      cleanupDirectories.map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  /**
   * Creates a store whose clock advances by one second per upsert.
   *
   * @returns Deterministic pending-work store.
   */
  function createStore(): PendingWorkStore {
    return new PendingWorkStore(
      rootDir,
      () => new Date(Date.UTC(2026, 7, 14, 1, 0, tick++)),
    );
  }

  test("loads an empty ledger before its first mutation", async () => {
    await expect(createStore().list()).resolves.toEqual([]);
  });

  test("seeds jobs and refreshes attempts without changing firstSeenAt", async () => {
    const store = createStore();
    const job = pageJob("job_runtime");

    await store.seedJobs([job]);
    const first = (await store.list())[0];
    await store.seedJobs([job]);
    const refreshed = (await store.list())[0];

    expect(first).toMatchObject({
      id: job.id,
      kind: "page",
      page,
      reason: "claim-stale, source-changed",
      attempts: 1,
    });
    expect(refreshed.attempts).toBe(2);
    expect(refreshed.firstSeenAt).toBe(first.firstSeenAt);
    expect(refreshed.lastSeenAt).not.toBe(first.lastSeenAt);
  });

  test("serializes concurrent mutations without losing items", async () => {
    const store = createStore();
    const inputs = Array.from({ length: 30 }, (_, index) =>
      pendingInput(`item_${index.toString().padStart(2, "0")}`),
    );

    await Promise.all(inputs.map((input) => store.add(input)));

    const items = await store.list();
    expect(items).toHaveLength(inputs.length);
    expect(items.map((item) => item.id)).toEqual(
      inputs.map((input) => input.id),
    );
  });

  test("waits for an in-flight mutation before listing", async () => {
    const store = createStore();
    const input = pendingInput("item_wait");
    const adding = store.add(input);

    await expect(store.list()).resolves.toMatchObject([{ id: input.id }]);
    await adding;
  });

  test("completes one or many durable obligations", async () => {
    const store = createStore();
    await Promise.all([
      store.add(pendingInput("item_a")),
      store.add(pendingInput("item_b")),
      store.add(pendingInput("item_c")),
    ]);

    await store.complete("item_a");
    await store.completeMany(["item_b", "missing"]);

    await expect(store.list()).resolves.toMatchObject([{ id: "item_c" }]);
  });

  test("adds reviewer gaps and arbitrary non-page work", async () => {
    const store = createStore();

    await store.addReviewGap({
      id: "gap_runtime",
      page,
      reason: "The reviewer could not establish coverage.",
      sourceHints: ["src/agent/index.ts"],
    });
    await store.add({
      id: "finalizer_links",
      kind: "finalizer",
      reason: "Link validation remains.",
      sourceHints: [],
    });

    await expect(store.list()).resolves.toMatchObject([
      { id: "finalizer_links", kind: "finalizer" },
      { id: "gap_runtime", kind: "review-gap", page },
    ]);
  });

  test("rejects stable IDs that change kind or page ownership", async () => {
    const store = createStore();
    await store.add(pendingInput("collision"));

    await expect(
      store.add({
        ...pendingInput("collision"),
        page: "/openwiki/other.md",
      }),
    ).rejects.toThrow(GenerationPersistenceError);
    await expect(
      store.add({
        ...pendingInput("collision"),
        kind: "translation",
      }),
    ).rejects.toThrow(GenerationPersistenceError);

    await store.add(pendingInput("after_failure"));
    await expect(store.list()).resolves.toHaveLength(2);
  });

  test("fails closed on malformed or unsupported owned JSON", async () => {
    const pendingPath = path.join(rootDir, PENDING_WORK_PATH);
    await mkdir(path.dirname(pendingPath), { recursive: true });
    const store = createStore();

    await writeFile(pendingPath, "{not json", "utf8");
    await expect(store.list()).rejects.toThrow(GenerationPersistenceError);
    await writeFile(
      pendingPath,
      JSON.stringify({ schemaVersion: 2, items: [] }),
      "utf8",
    );
    await expect(store.list()).rejects.toThrow(GenerationPersistenceError);
  });

  test("rejects a symlinked pending-work directory", async () => {
    const outside = await mkdtemp(
      path.join(tmpdir(), "openwiki-pending-outside-"),
    );
    cleanupDirectories.push(outside);
    await mkdir(path.join(rootDir, "openwiki"), { recursive: true });
    await symlink(outside, path.join(rootDir, "openwiki", ".claims"), "dir");
    const store = createStore();

    await expect(store.add(pendingInput("unsafe"))).rejects.toThrow(
      GenerationPersistenceError,
    );
  });
});
