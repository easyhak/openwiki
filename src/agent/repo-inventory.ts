/**
 * The repository's directory tree, and whether a proposed partition covers it.
 *
 * Two rules have now failed here. The first tried to decide what a component IS
 * - manifests, containers, migration lineages - and returned 213 units for one
 * repository, counting every CI workflow and every benchmark fixture's
 * Dockerfile. The second surveyed top-level directories, which is not a rule
 * about repositories at all: it fits a flat monorepo with thirty-four of them
 * and produces one surveyor for the whole codebase in a repository that keeps
 * everything under src/, or one for `packages/` in a repository nested as
 * packages/@org/*.
 *
 * There is no mechanical answer, because the right granularity is a fact about
 * how a particular repository is organised. But there is a mechanical CHECK.
 * So this enumerates the tree and verifies a partition against it, and the
 * partition itself comes from an agent that has looked at the repository.
 *
 * That keeps the property worth having. A subtree nobody surveys is invisible -
 * nothing downstream can tell it apart from a subtree that does not exist - and
 * this makes such a subtree a rejection with its path in the message rather than
 * a silent gap. Choosing granularity is judgement; noticing an omission is not.
 *
 * Test directories are excluded as subjects, never as evidence. Nothing here
 * restricts what an author reads: a page's tests are among its best evidence,
 * and both the page contract and the author prompt ask for them by name.
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

/** Backend capability needed to enumerate. */
export interface ListingBackend {
  ls(dirPath: string): Promise<{
    error?: string;
    files?: { path: string; is_dir?: boolean }[];
  }>;
}

/**
 * Deepest level walked. Bounds the cost on a large tree while going deep enough
 * that a nested layout - packages/@org/name - is visible to partition against.
 */
const MAX_DEPTH = 4;

/**
 * Reports whether a directory name marks a test tree.
 *
 * @param name - Bare directory name.
 * @returns Whether it should be evidence rather than a subject.
 */
export function isTestDirectory(name: string): boolean {
  return TEST_DIRECTORIES.has(name.toLowerCase());
}

/**
 * Enumerates every directory a survey must account for.
 *
 * @param backend - Filesystem backend rooted at the repository.
 * @returns Repository-rooted paths, sorted, so two runs agree exactly.
 */
export async function collectDirectoryTree(
  backend: ListingBackend,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      return;
    }
    const listed = await backend.ls(directory === "" ? "/" : directory);
    for (const entry of listed.files ?? []) {
      if (!entry.is_dir) {
        continue;
      }
      const name = path.posix.basename(entry.path.replace(/\/+$/u, ""));
      if (SKIP_DIRECTORIES.has(name) || isTestDirectory(name)) {
        continue;
      }
      if (name.startsWith(".") && name !== ".github") {
        continue;
      }
      const full = `${directory}/${name}`;
      found.push(full);
      await walk(full, depth + 1);
    }
  };
  await walk("", 0);
  // "/" is the repository's own files - manifests, workspace config - which
  // belong to no subdirectory and would otherwise fall between partitions.
  found.push("/");
  found.sort();
  return found;
}

/**
 * Reports which enumerated directories no proposed root covers.
 *
 * Roots may nest: a directory belongs to its DEEPEST covering root, so
 * proposing `/src` alongside `/src/api` is meaningful rather than a conflict -
 * `/src` takes its own files and whatever `/src/api` does not claim. Rejecting
 * nesting would make a repository with significant files beside significant
 * subdirectories impossible to partition.
 *
 * @param tree - Every directory that must be accounted for.
 * @param roots - Proposed survey roots.
 * @returns Uncovered directories, empty when the partition is complete.
 */
export function uncoveredDirectories(
  tree: readonly string[],
  roots: readonly string[],
): string[] {
  const normalized = roots.map(
    (root) => `/${root.replace(/^\/+/u, "").replace(/\/+$/u, "")}`,
  );
  return tree.filter(
    (directory) =>
      !normalized.some(
        (root) =>
          root === "/" || directory === root || directory.startsWith(`${root}/`),
      ),
  );
}

/**
 * Returns the directories a root owns directly, excluding deeper roots.
 *
 * A surveyor needs to know what it is NOT responsible for, or two surveyors
 * plan the same subtree and their pages collide.
 *
 * @param root - The root being briefed.
 * @param roots - Every proposed root.
 * @returns Deeper roots nested inside this one.
 */
export function nestedRootsWithin(
  root: string,
  roots: readonly string[],
): string[] {
  return roots.filter(
    (candidate) => candidate !== root && candidate.startsWith(`${root}/`),
  );
}
