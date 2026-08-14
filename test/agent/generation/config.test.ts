import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_GENERATION_CONCURRENCY,
  GENERATION_ARCHITECTURE_ENV_KEY,
  GENERATION_CONCURRENCY_ENV_KEY,
  GENERATION_RECURSION_LIMIT,
  MAX_CLAIM_RECONCILER_INVOCATIONS,
  MAX_GENERATION_CONCURRENCY,
  MAX_INIT_QA_REPAIR_WAVES,
  MAX_PAGE_AUTHOR_INVOCATIONS,
  MAX_PAGE_ELAPSED_MS,
  MAX_PLANNER_INVOCATIONS,
  MAX_SKELETON_CRITIC_INVOCATIONS,
  MAX_UNKNOWN_UNKNOWN_PASSES,
  MAX_UPDATE_REPAIR_WAVES,
  SOURCE_RESEARCH_TIMEOUT_MS,
  TOOL_FREE_AUTHOR_TIMEOUT_MS,
  resolveGenerationArchitecture,
  resolveGenerationConcurrency,
} from "../../../src/agent/generation/config.ts";

const originalArchitecture = process.env[GENERATION_ARCHITECTURE_ENV_KEY];
const originalConcurrency = process.env[GENERATION_CONCURRENCY_ENV_KEY];

beforeEach(() => {
  delete process.env[GENERATION_ARCHITECTURE_ENV_KEY];
  delete process.env[GENERATION_CONCURRENCY_ENV_KEY];
});

afterEach(() => {
  restoreEnvironment(GENERATION_ARCHITECTURE_ENV_KEY, originalArchitecture);
  restoreEnvironment(GENERATION_CONCURRENCY_ENV_KEY, originalConcurrency);
});

describe("generation configuration", () => {
  test("keeps explicit loop bounds separate from the recursion fuse", () => {
    expect(GENERATION_RECURSION_LIMIT).toBe(10_000);
    expect(MAX_PLANNER_INVOCATIONS).toBe(2);
    expect(MAX_CLAIM_RECONCILER_INVOCATIONS).toBe(3);
    expect(MAX_PAGE_AUTHOR_INVOCATIONS).toBe(3);
    expect(MAX_SKELETON_CRITIC_INVOCATIONS).toBe(2);
    expect(MAX_UNKNOWN_UNKNOWN_PASSES).toBe(1);
    expect(MAX_INIT_QA_REPAIR_WAVES).toBe(2);
    expect(MAX_UPDATE_REPAIR_WAVES).toBe(1);
  });

  test("keeps the registered timeout budgets", () => {
    expect(SOURCE_RESEARCH_TIMEOUT_MS).toBe(5 * 60 * 1_000);
    expect(TOOL_FREE_AUTHOR_TIMEOUT_MS).toBe(3 * 60 * 1_000);
    expect(MAX_PAGE_ELAPSED_MS).toBe(12 * 60 * 1_000);
  });

  test("defaults to the legacy control arm", () => {
    expect(resolveGenerationArchitecture()).toBe("legacy");
  });

  test.each(["legacy", "langgraph"] as const)(
    "accepts the %s environment arm",
    (architecture) => {
      process.env[GENERATION_ARCHITECTURE_ENV_KEY] = ` ${architecture} `;

      expect(resolveGenerationArchitecture()).toBe(architecture);
    },
  );

  test("prefers an explicit architecture over the environment", () => {
    process.env[GENERATION_ARCHITECTURE_ENV_KEY] = "langgraph";

    expect(resolveGenerationArchitecture("legacy")).toBe("legacy");
  });

  test.each(["other", "Legacy", "langgraph-now"])(
    "rejects invalid architecture value %s",
    (architecture) => {
      process.env[GENERATION_ARCHITECTURE_ENV_KEY] = architecture;

      expect(() => resolveGenerationArchitecture()).toThrow(
        GENERATION_ARCHITECTURE_ENV_KEY,
      );
    },
  );

  test("defaults generation concurrency to four", () => {
    expect(DEFAULT_GENERATION_CONCURRENCY).toBe(4);
    expect(MAX_GENERATION_CONCURRENCY).toBe(8);
    expect(resolveGenerationConcurrency()).toBe(4);
  });

  test.each([1, 4, 8])("accepts explicit concurrency %i", (concurrency) => {
    expect(resolveGenerationConcurrency(concurrency)).toBe(concurrency);
  });

  test.each(["1", "4", " 8 "])(
    "accepts environment concurrency %s",
    (concurrency) => {
      process.env[GENERATION_CONCURRENCY_ENV_KEY] = concurrency;

      expect(resolveGenerationConcurrency()).toBe(Number(concurrency));
    },
  );

  test("prefers explicit concurrency over the environment", () => {
    process.env[GENERATION_CONCURRENCY_ENV_KEY] = "8";

    expect(resolveGenerationConcurrency(2)).toBe(2);
  });

  test.each([0, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid explicit concurrency %s",
    (concurrency) => {
      expect(() => resolveGenerationConcurrency(concurrency)).toThrow(
        GENERATION_CONCURRENCY_ENV_KEY,
      );
    },
  );

  test.each(["0", "9", "1.5", "many", "Infinity"])(
    "rejects invalid environment concurrency %s",
    (concurrency) => {
      process.env[GENERATION_CONCURRENCY_ENV_KEY] = concurrency;

      expect(() => resolveGenerationConcurrency()).toThrow(
        GENERATION_CONCURRENCY_ENV_KEY,
      );
    },
  );
});

/**
 * Restores one process environment value after an isolated configuration test.
 *
 * @param key - Environment key to restore.
 * @param value - Original value, or undefined when absent.
 */
function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
