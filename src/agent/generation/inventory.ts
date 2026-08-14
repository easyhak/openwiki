import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { OpenWikiIgnore } from "../openwiki-ignore.js";
import type { DiscoveryPartition } from "./contracts.js";

/**
 * Manifest names that establish a package or service discovery root.
 */
const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "mix.exs",
]);

/**
 * Directories excluded from deterministic repository inventory.
 */
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".venv",
  "venv",
  "openwiki",
]);

/**
 * Deterministic compact repository inventory.
 */
export interface RepositoryInventory {
  /**
   * Stable manifest-backed discovery partitions.
   */
  partitions: DiscoveryPartition[];

  /**
   * Representative test roots discovered by name.
   */
  testRoots: string[];

  /**
   * Top-level repository entries for coverage synthesis.
   */
  topLevelEntries: string[];
}

/**
 * Inventories package roots without reading source contents.
 *
 * @param rootDir - Absolute repository root.
 * @param openWikiIgnore - Active read boundary.
 * @returns Stable compact inventory.
 */
export async function inventoryRepository(
  rootDir: string,
  openWikiIgnore: OpenWikiIgnore,
): Promise<RepositoryInventory> {
  const manifests: string[] = [];
  const testRoots = new Set<string>();
  const topLevelEntries = (await readdir(rootDir, { withFileTypes: true }))
    .filter((entry) => !EXCLUDED_DIRECTORIES.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  async function walk(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relative = path.posix.join(
        relativeDirectory.replace(/\\/gu, "/"),
        entry.name,
      );
      if (openWikiIgnore.ignores(relative, entry.isDirectory())) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        if (/^(?:test|tests|__tests__|spec|specs)$/iu.test(entry.name)) {
          testRoots.add(relative);
        }
        await walk(path.join(directory, entry.name), relative);
      } else if (entry.isFile() && MANIFEST_NAMES.has(entry.name)) {
        const metadata = await lstat(path.join(directory, entry.name));
        if (!metadata.isSymbolicLink()) manifests.push(relative);
      }
    }
  }
  await walk(rootDir, "");

  const grouped = new Map<string, string[]>();
  for (const manifest of manifests) {
    const directory = path.posix.dirname(manifest);
    const root = directory === "." ? "." : directory.split("/")[0];
    const group = grouped.get(root) ?? [];
    group.push(manifest);
    grouped.set(root, group);
  }
  if (grouped.size === 0) grouped.set(".", []);
  const partitions = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([root, group]): DiscoveryPartition => ({
      id: `partition_${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
      roots: [root],
      manifests: group.sort(),
    }));
  return {
    partitions,
    testRoots: [...testRoots].sort(),
    topLevelEntries,
  };
}
