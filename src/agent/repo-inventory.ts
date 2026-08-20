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
  "tests",
  "spec",
  "specs",
  "fixture",
  "fixtures",
  "e2e",
  "benchmarks",
  "mocks",
]);

/** Backend capability needed to enumerate. */
export interface ListingBackend {
  ls(dirPath: string): Promise<{
    error?: string;
    files?: { path: string; is_dir?: boolean }[];
  }>;
}

/**
 * Depth of the tree shown to the agent when it plans.
 *
 * A display bound, not a correctness one. It exists so the listing stays
 * readable on a large monorepo; coverage checking does not use it and is not
 * limited by it, because a directory the agent never saw still has to be
 * covered by some ancestor entry.
 */
const LISTING_DEPTH = 3;

/**
 * Reports whether a directory name marks a test tree.
 *
 * @param name - Bare directory name.
 * @returns Whether it should be evidence rather than a subject.
 */
export function isTestDirectory(name: string): boolean {
  // Normalized so test_data, test-data, and testdata are one name. A run
  // planned a page for /test_data because only the undelimited spelling was
  // listed, which is a naming accident rather than a judgement.
  return TEST_DIRECTORIES.has(name.toLowerCase().replace(/[-_]/gu, ""));
}

/**
 * Reports whether a directory should be walked at all.
 *
 * @param name - Bare directory name.
 * @returns Whether it is a subject worth accounting for.
 */
function isWalkable(name: string): boolean {
  if (SKIP_DIRECTORIES.has(name) || isTestDirectory(name)) {
    return false;
  }
  // Dotted directories are tooling, with one exception: .github carries the
  // repository's whole operational surface.
  return !name.startsWith(".") || name === ".github";
}

/**
 * Lists the walkable child directories of one directory.
 *
 * @param backend - Filesystem backend.
 * @param directory - Repository-rooted path, "" for the root.
 * @returns Child paths, rooted at "/".
 */
async function childDirectories(
  backend: ListingBackend,
  directory: string,
): Promise<string[]> {
  const listed = await backend.ls(directory === "" ? "/" : directory);
  const children: string[] = [];
  for (const entry of listed.files ?? []) {
    if (!entry.is_dir) {
      continue;
    }
    const name = path.posix.basename(entry.path.replace(/\/+$/u, ""));
    if (isWalkable(name)) {
      children.push(`${directory}/${name}`);
    }
  }
  return children;
}

/**
 * Enumerates directories for the agent to plan against, bounded for readability.
 *
 * @param backend - Filesystem backend rooted at the repository.
 * @returns Repository-rooted paths, sorted, plus "/" for the root's own files.
 */
export async function collectDirectoryTree(
  backend: ListingBackend,
): Promise<string[]> {
  const found: string[] = ["/"];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > LISTING_DEPTH) {
      return;
    }
    for (const child of await childDirectories(backend, directory)) {
      found.push(child);
      await walk(child, depth + 1);
    }
  };
  await walk("", 0);
  found.sort();
  return found;
}

/**
 * Normalizes a supplied directory to a rooted path with no trailing slash.
 *
 * @param directory - Model-supplied path.
 * @returns Rooted path.
 */
function rooted(directory: string): string {
  return `/${directory.replace(/^\/+/u, "").replace(/\/+$/u, "")}`;
}

/**
 * Reports whether any entry covers a directory.
 *
 * @param directory - Rooted directory path.
 * @param entries - Rooted entry directories.
 * @returns Whether the directory falls under an entry.
 */
function isCovered(directory: string, entries: readonly string[]): boolean {
  // "/" covers only itself - the repository's own files, which belong to no
  // subdirectory. If it covered the whole tree the coverage guarantee would be
  // vacuous: a single root entry would satisfy it for every directory in the
  // repository. A plan has to name the areas it documents.
  return entries.some(
    (entry) => directory === entry || directory.startsWith(`${entry}/`),
  );
}

/**
 * Finds directories no entry covers, to any depth.
 *
 * Unbounded in depth but cheap, because coverage is inherited: once a directory
 * is covered every directory beneath it is too, so the walk prunes there and
 * never descends. Under a complete plan it therefore visits only the top of the
 * tree. An uncovered directory is reported and then pruned as well, so a missed
 * subtree yields the one path that names it rather than hundreds of its
 * children.
 *
 * A depth bound here would put a hole in the only guarantee this makes: a
 * service nested deeper than the bound would never be enumerated, so nothing
 * would require the plan to cover it, which is the invisible subtree the check
 * exists to prevent.
 *
 * @param backend - Filesystem backend rooted at the repository.
 * @param entries - Directories the plan claims to cover.
 * @returns Uncovered directories, shallowest first.
 */
export async function findUncoveredDirectories(
  backend: ListingBackend,
  entries: readonly string[],
): Promise<string[]> {
  const covering = entries.map(rooted);
  // The repository's own files belong to no subdirectory, so only an entry on
  // "/" covers them. Without this they would go unaccounted for silently.
  const uncovered: string[] = isCovered("/", covering) ? [] : ["/"];

  const walk = async (directory: string): Promise<void> => {
    const children = await childDirectories(backend, directory);
    for (const child of children) {
      if (!isCovered(child, covering)) {
        // Report the highest uncovered directory and stop. Its children add
        // nothing a reader can act on, and listing them would turn one missed
        // subtree into hundreds of problems.
        uncovered.push(child);
        continue;
      }
      // Covered, so everything beneath it is covered too - unless a deeper
      // entry exists, which means this subtree was partitioned and something
      // inside it may still have been missed.
      if (covering.some((entry) => entry.startsWith(`${child}/`))) {
        await walk(child);
      }
    }
  };
  await walk("");
  return uncovered;
}
