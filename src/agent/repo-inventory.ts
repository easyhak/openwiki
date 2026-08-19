/**
 * Survey targets: the directories a plan must account for.
 *
 * The first version of this tried to decide what a component IS - manifests,
 * container definitions, migration lineages - and could not. Against
 * LangChainPlus it returned 213 units, counting every CI workflow file and
 * every benchmark fixture's Dockerfile, and `submit_plan` rejected three
 * ledgers in a row because no correct ledger was expressible. No rule
 * distinguishes issuebench/tasks/coding-dense/environment/Dockerfile from
 * smith-go/Dockerfile; that is a judgement about what the repository means.
 *
 * So this stops judging and enumerates only what it can be certain of: the
 * directories. Completeness is the part code must own, because a forgotten
 * subtree is invisible - nothing downstream can tell it apart from a subtree
 * that does not exist. Which of a directory's contents deserve pages, and how
 * many, is left to a surveyor that reads it.
 *
 * Test directories are excluded as survey targets, not as evidence. Nothing
 * here restricts what an author reads: a page's tests are among the best
 * evidence it has, and the page contract asks for them by name. What is
 * excluded is treating a test tree as a subject needing its own pages.
 */

import path from "node:path";

/** Directories that are never a subject, and expensive to walk. */
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "openwiki",
]);

/**
 * Directory names that mark a test tree.
 *
 * Name-based, which is a rule - but a far safer one than "is this a component".
 * Being wrong here costs a directory being surveyed as evidence rather than as
 * a subject, and its contents still reach pages through the tests their authors
 * are told to read.
 */
const TEST_DIRECTORIES = new Set([
  "test",
  "tests",
  "testdata",
  "__tests__",
  "spec",
  "specs",
  "fixtures",
  "e2e",
  "benchmarks",
  "__mocks__",
]);

/** One directory a surveyor must account for. */
export interface SurveyTarget {
  /** Repository-rooted path, "/" for the root's own files. */
  path: string;
  /** Immediate child directories, so a surveyor knows its subtree's shape. */
  children: string[];
}

/** Backend capability needed to enumerate. */
export interface ListingBackend {
  ls(dirPath: string): Promise<{
    error?: string;
    files?: { path: string; is_dir?: boolean }[];
  }>;
}

/**
 * Reports whether a directory name marks a test tree.
 *
 * @param name - Bare directory name.
 * @returns Whether it should be surveyed as evidence rather than as a subject.
 */
export function isTestDirectory(name: string): boolean {
  return TEST_DIRECTORIES.has(name.toLowerCase());
}

/**
 * Enumerates the top-level directories a plan must account for.
 *
 * Top-level rather than recursive: a surveyor owns its subtree and decides how
 * many pages it decomposes into, which is the judgement this deliberately does
 * not make. Recursing would recreate the problem it was written to solve, by
 * asserting that every nested directory is separately significant.
 *
 * @param backend - Filesystem backend rooted at the repository.
 * @returns Targets sorted by path, so two runs over one tree agree exactly.
 */
export async function collectSurveyTargets(
  backend: ListingBackend,
): Promise<SurveyTarget[]> {
  const root = await backend.ls("/");
  const targets: SurveyTarget[] = [];
  let rootHasFiles = false;

  for (const entry of root.files ?? []) {
    const name = path.posix.basename(entry.path.replace(/\/+$/u, ""));
    if (!entry.is_dir) {
      rootHasFiles = true;
      continue;
    }
    if (SKIP_DIRECTORIES.has(name) || isTestDirectory(name)) {
      continue;
    }
    // Dotted directories are tooling, with one exception: .github carries the
    // repository's whole operational surface.
    if (name.startsWith(".") && name !== ".github") {
      continue;
    }
    const listed = await backend.ls(`/${name}`);
    const children = (listed.files ?? [])
      .filter((child) => child.is_dir)
      .map((child) => path.posix.basename(child.path.replace(/\/+$/u, "")))
      .filter((child) => !SKIP_DIRECTORIES.has(child))
      .sort();
    targets.push({ path: `/${name}`, children });
  }

  // The root's own manifests and configuration are a subject too, and belong to
  // no directory, so they get a target rather than falling between them.
  if (rootHasFiles) {
    targets.push({ path: "/", children: [] });
  }
  targets.sort((left, right) => left.path.localeCompare(right.path));
  return targets;
}
