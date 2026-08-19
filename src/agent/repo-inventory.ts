/**
 * Deterministic repository inventory.
 *
 * Step 1 asked the model to enumerate the repository inside the REPL, and it
 * enumerated differently every run. That is the wrong job for a model: finding
 * every package manifest is a glob, not a judgement, and the judgement that
 * follows - which units share a page - is worthless if the list underneath it
 * moves. So the enumeration happens here and returns stable unit IDs, which
 * `submit_plan` then requires a disposition for.
 *
 * What counts as a unit is deliberately mechanical: a manifest, a workspace
 * member, a container or compose service, a migration lineage, a CI workflow.
 * These are the things a repository declares about itself, so a unit exists
 * because the repository says so rather than because a model noticed it. That
 * makes the floor derivable rather than a page count someone chose - and a page
 * count chosen from one repository's median would be pure overfitting to it.
 */

import path from "node:path";
import { tool } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import { z } from "zod";
/**
 * The one backend capability this needs.
 *
 * Narrower than AnyBackendProtocol, whose V1 arm has no `ls` at all - and the
 * inventory has no business reading or writing anything.
 */
interface ListingBackend {
  ls(dirPath: string): Promise<{
    error?: string;
    files?: { path: string; is_dir?: boolean }[];
  }>;
}

/** Directories never worth enumerating, and expensive to walk. */
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

/** Deepest directory level walked, which bounds the cost on a large monorepo. */
const MAX_DEPTH = 6;

/**
 * Manifest filenames that declare a package, and the kind of unit each implies.
 *
 * A manifest is the strongest signal a repository gives that something is a
 * separately buildable, separately ownable component - which is exactly the
 * granularity a canonical page wants.
 */
const MANIFESTS: Record<string, string> = {
  "package.json": "javascript-package",
  "pyproject.toml": "python-package",
  "setup.py": "python-package",
  "go.mod": "go-module",
  "Cargo.toml": "rust-crate",
  "deno.json": "deno-package",
  "pom.xml": "java-module",
  "build.gradle": "java-module",
  "build.gradle.kts": "java-module",
  "Gemfile": "ruby-package",
  "composer.json": "php-package",
  "*.csproj": "dotnet-project",
};

/** Files that declare a deployable image or process, rather than a package. */
const DEPLOYABLES: Record<string, string> = {
  Dockerfile: "container-image",
  "docker-compose.yml": "compose-stack",
  "docker-compose.yaml": "compose-stack",
  "docker-bake.hcl": "image-build-matrix",
  Procfile: "process-manifest",
  "process-compose.yaml": "process-manifest",
  "process-compose.yml": "process-manifest",
};

/** One mechanically discovered unit. */
export interface InventoryUnit {
  /** Stable identifier derived from kind and path, so plans can reference it. */
  id: string;
  kind: string;
  path: string;
}

/**
 * Walks the repository and returns every mechanically discoverable unit.
 *
 * @param backend - Filesystem backend rooted at the repository.
 * @returns Units sorted by id, so two runs over one tree agree exactly.
 */
export async function collectInventory(
  backend: ListingBackend,
): Promise<InventoryUnit[]> {
  const units: InventoryUnit[] = [];
  const seen = new Set<string>();

  const add = (kind: string, filePath: string) => {
    // Rooted at "/" so an ID reads as a location a person can go look at, and
    // so the repository root itself is "/" rather than an empty string.
    const directory = path.posix.dirname(`/${filePath.replace(/^\/+/u, "")}`);
    const id = `${kind}:${directory}`;
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    units.push({ id, kind, path: filePath });
  };

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      return;
    }
    let entries: { name: string; isDirectory: boolean }[];
    try {
      entries = await listDirectory(backend, directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) {
          // Migration lineages hide under dotted tooling directories often
          // enough to be worth the one exception.
          if (entry.name !== ".github") {
            continue;
          }
        }
        if (entry.name === "versions" && directory.endsWith("alembic")) {
          add("migration-lineage", full);
          continue;
        }
        if (entry.name === "migrations") {
          add("migration-lineage", full);
          continue;
        }
        await walk(full, depth + 1);
        continue;
      }
      const kind =
        MANIFESTS[entry.name] ??
        (entry.name.endsWith(".csproj") ? MANIFESTS["*.csproj"] : undefined) ??
        DEPLOYABLES[entry.name];
      if (kind) {
        add(kind, full);
        continue;
      }
      if (directory === ".github/workflows" && /\.ya?ml$/u.test(entry.name)) {
        // Workflows are one unit each: each is an independently triggered
        // operational surface, and a wiki that documents "CI" documents none.
        units.push({
          id: `ci-workflow:/${full.replace(/^\/+/u, "")}`,
          kind: "ci-workflow",
          path: full,
        });
      }
    }
  };

  await walk("", 0);
  units.sort((left, right) => left.id.localeCompare(right.id));
  return units;
}

/**
 * Lists one directory through whichever listing shape the backend exposes.
 *
 * @param backend - Filesystem backend.
 * @param directory - Repository-relative directory, "" for the root.
 * @returns Entries with their directory flag.
 */
async function listDirectory(
  backend: ListingBackend,
  directory: string,
): Promise<{ name: string; isDirectory: boolean }[]> {
  const result = await backend.ls(`/${directory}`);
  if (result.error || !result.files) {
    return [];
  }
  return result.files.map((file) => ({
    name: path.posix.basename(file.path.replace(/\/$/u, "")),
    isDirectory: file.is_dir === true,
  }));
}

/**
 * Creates the inventory middleware.
 *
 * @param backend - Repository filesystem backend.
 * @returns Middleware exposing `inventory_repository`.
 */
export function createOpenWikiInventoryMiddleware(
  backend: ListingBackend,
) {
  const inventory = tool(
    async () => {
      const units = await collectInventory(backend);
      const byKind: Record<string, number> = {};
      for (const unit of units) {
        byKind[unit.kind] = (byKind[unit.kind] ?? 0) + 1;
      }
      return JSON.stringify({ total: units.length, byKind, units });
    },
    {
      name: "inventory_repository",
      description:
        "Enumerate every mechanically discoverable unit of this repository - package manifests, container and compose definitions, migration lineages, CI workflows - as stable unit IDs. Call this once, before planning. Every returned unit needs a disposition in submit_plan, so this is the floor the plan is measured against rather than a suggestion.",
      schema: z.object({}),
    },
  );

  return createMiddleware({
    name: "OpenWikiInventoryMiddleware",
    tools: [inventory],
  });
}
