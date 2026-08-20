/**
 * Contracts between areas, found from the repository rather than asked for.
 *
 * Every page in a directory-shaped plan is about one area, so a fact about two
 * areas has no home: which of the services that write a table is authoritative,
 * which language's implementation of a route actually serves it, what one area
 * imports from another. An author is given its own subtree and cannot see the
 * other side, and the planner is the only participant that ever holds both.
 *
 * So the plan needs units that are not directories, and they are discovered here
 * instead of proposed: each candidate is a piece of evidence - a table two areas
 * write, a route implemented twice - that either gets a page or gets an explicit
 * reason for having none.
 *
 * Nothing here calls a model. It is a pure function of the repository, so the
 * same tree always yields the same candidates, and the set cannot be narrowed by
 * an agent that would rather answer fewer of them.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Directories that hold no documentable subject. */
const SKIP_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", "vendor", ".venv",
  "venv", "__pycache__", ".next", ".turbo", ".cache", "coverage", "openwiki",
]);

/** Files whose contents describe a subject rather than being one. */
const TEST_FILE = /(_test\.|\.test\.|\.spec\.|^test_|^conftest\.py$)/u;

const SOURCE_EXTENSIONS = new Set([
  ".go", ".py", ".ts", ".tsx", ".js", ".jsx", ".rs", ".java", ".kt", ".rb",
  ".php", ".cs", ".sql", ".proto",
]);

/** Files that declare what an area is called, for resolving imports into it. */
const MANIFESTS = new Set([
  "go.mod", "package.json", "pyproject.toml", "setup.py", "Cargo.toml",
  "pom.xml", "build.gradle", "composer.json", "Gemfile",
]);

/**
 * The schema is the authority on what a table is called.
 *
 * Table names inferred from query text alone are unusable: `from` appears in
 * Python imports and in prose, so the candidates come out as module names and
 * English words. Only names something declares with CREATE TABLE are considered.
 */
const DDL = /create\s+table\s+(?:if\s+not\s+exists\s+)?["`[]?([a-z_][a-z0-9_.]{2,60})/giu;
const DDL_MIGRATION = /create_table\(\s*['"]([a-z_][a-z0-9_]{2,60})['"]/giu;

const WRITES = /\b(?:insert\s+into|update|delete\s+from|upsert\s+into)\s+(?:only\s+)?["`[]?([a-z_][a-z0-9_.]{3,60})/giu;
const READS = /\b(?:from|join)\s+(?:only\s+)?["`[]?([a-z_][a-z0-9_.]{3,60})/giu;
const SQL_PRESENT = /\b(?:select|insert\s+into|update|delete\s+from|create\s+table)\b/iu;

/** Routed paths, which are the one literal two languages share deliberately. */
const ROUTE = /^\/(?:v\d+|api)(?:\/[a-z0-9_\-{}:.]+){1,6}\/?$/iu;
const STRING_LITERAL = /"([^"\\\n]{3,120})"|`([^`\\\n]{3,120})`|'([^'\\\n]{3,120})'/gu;

const GO_IMPORT = /^\s*(?:[\w.]+\s+)?"([^"]+)"\s*$/u;
const PY_IMPORT = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/u;
const TS_IMPORT = /^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/u;

/** Words the query patterns match but that name nothing shared. */
const NOT_A_TABLE = new Set([
  "select", "where", "values", "table", "index", "using", "order", "group",
  "limit", "offset", "returning", "conflict", "exists", "null", "true", "false",
  "case", "when", "then", "else", "dual", "this", "that", "only", "both",
]);

/** How many manifests a repository needs before they define its areas. */
const MANIFESTS_DEFINE_AREAS = 5;

/** One contract two or more areas are party to. */
export interface ContractCandidate {
  kind: "divided-state" | "parallel-impl" | "cross-area-import";
  /** What the contract is about: a table, a route, or an import edge. */
  name: string;
  /** Why it qualifies, in a few words. */
  signal: string;
  /** Areas party to it. */
  areas: string[];
  /** Areas that write the state, for divided-state. */
  writers?: string[];
  /** Areas that only read it. */
  consumers?: string[];
  /** Paths an author needs, at most a handful per party. */
  evidence: string[];
  /** Tests that exercise it, which is where a validation answer comes from. */
  tests: string[];
  /** Ranking weight; higher is a sharper contract. */
  weight: number;
}

interface Survey {
  files: string[];
  areaOf: (file: string) => string;
  declared: Map<string, string>;
}

function walkable(name: string): boolean {
  if (SKIP_DIRECTORIES.has(name)) return false;
  return !name.startsWith(".") || name === ".github";
}

function languageOf(file: string): string {
  const extension = path.posix.extname(file);
  if ([".ts", ".tsx", ".js", ".jsx"].includes(extension)) return "ts";
  return { ".go": "go", ".py": "python", ".sql": "sql" }[extension] ?? extension;
}

/**
 * Lists source files and works out which area each belongs to.
 *
 * Areas come from what the repository declares about itself - a module, a
 * package - and fall back to its top directories when it declares too few to
 * partition anything.
 *
 * @param rootDir - Absolute repository root.
 * @returns Source files, an area lookup, and the names areas are imported by.
 */
async function survey(rootDir: string): Promise<Survey> {
  const files: string[] = [];
  const manifestDirs: string[] = [];
  const declared = new Map<string, string>();

  const walk = async (relative: string): Promise<void> => {
    const entries = await fs.readdir(path.join(rootDir, relative), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (walkable(entry.name)) await walk(child);
        continue;
      }
      if (MANIFESTS.has(entry.name)) {
        manifestDirs.push(relative);
        await declareFrom(rootDir, relative, entry.name, declared);
      }
      if (SOURCE_EXTENSIONS.has(path.posix.extname(entry.name))) files.push(child);
    }
  };
  await walk("");

  const roots = [...new Set(manifestDirs)].sort((a, b) => a.length - b.length);
  const byManifest = roots.length >= MANIFESTS_DEFINE_AREAS;
  const areaOf = (file: string): string => {
    if (byManifest) {
      let owner = "";
      for (const root of roots) {
        if (root === "" || file.startsWith(`${root}/`)) {
          if (root.length >= owner.length) owner = root;
        }
      }
      return owner || "/";
    }
    const parts = file.split("/");
    return parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0] ?? "/";
  };
  return { files, areaOf, declared };
}

/**
 * Records the name an area is imported by, from the manifest that declares it.
 *
 * An import names a module or a package, never a file, so resolving one against
 * file paths matches almost nothing.
 *
 * @param rootDir - Absolute repository root.
 * @param relative - Directory holding the manifest.
 * @param manifest - Manifest file name.
 * @param declared - Map to record into.
 */
async function declareFrom(
  rootDir: string,
  relative: string,
  manifest: string,
  declared: Map<string, string>,
): Promise<void> {
  const record = (name: string | undefined): void => {
    if (!name) return;
    const existing = declared.get(name);
    if (existing === undefined || relative.length > existing.length) {
      declared.set(name, relative || "/");
    }
  };
  try {
    const text = await fs.readFile(path.join(rootDir, relative, manifest), "utf8");
    if (manifest === "go.mod") {
      const line = text.split("\n").find((one) => one.startsWith("module "));
      record(line?.split(/\s+/u)[1]?.trim());
    } else if (manifest === "package.json") {
      record((JSON.parse(text) as { name?: string }).name);
    } else {
      record(path.posix.basename(relative).replace(/-/gu, "_"));
    }
  } catch {
    // A manifest we cannot read still marks an area; only its name is lost.
  }
}

export interface DiscoveryOptions {
  /** Highest number of candidates to return. */
  limit?: number;
}

/**
 * Finds the contracts between areas of one repository.
 *
 * @param rootDir - Absolute repository root.
 * @param options - Result bound.
 * @returns Candidates, sharpest first.
 */
export async function discoverSharedContracts(
  rootDir: string,
  options: DiscoveryOptions = {},
): Promise<ContractCandidate[]> {
  const { files, areaOf, declared } = await survey(rootDir);

  const ddlTables = new Set<string>();
  const writers = new Map<string, Set<string>>();
  const readers = new Map<string, Set<string>>();
  const tableEvidence = new Map<string, Set<string>>();
  const tableTests = new Map<string, Set<string>>();
  const routes = new Map<string, Map<string, Set<string>>>();
  const importEdges = new Map<string, number>();
  const importEvidence = new Map<string, Set<string>>();

  const add = (
    into: Map<string, Set<string>>,
    key: string,
    value: string,
  ): void => {
    const existing = into.get(key);
    if (existing) existing.add(value);
    else into.set(key, new Set([value]));
  };

  for (const file of files) {
    const area = areaOf(file);
    const isTest = TEST_FILE.test(path.posix.basename(file));
    const language = languageOf(file);
    let text: string;
    try {
      text = await fs.readFile(path.join(rootDir, file), "utf8");
    } catch {
      continue;
    }

    for (const pattern of [DDL, DDL_MIGRATION]) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        // A qualified name can end in a separator, which yields an empty segment
        // that then matches every unqualified reference in the repository.
        const table = match[1]!.toLowerCase().split(".").pop()!.trim();
        if (table) ddlTables.add(table);
      }
    }

    if (SQL_PRESENT.test(text)) {
      for (const [pattern, into] of [
        [WRITES, writers],
        [READS, readers],
      ] as const) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const table = match[1]!.toLowerCase().split(".").pop()!;
          if (NOT_A_TABLE.has(table)) continue;
          if (isTest) {
            add(tableTests, table, file);
            continue;
          }
          add(into, table, area);
          const seen = tableEvidence.get(table);
          if (!seen || seen.size < 8) add(tableEvidence, table, file);
        }
      }
    }

    STRING_LITERAL.lastIndex = 0;
    for (const match of text.matchAll(STRING_LITERAL)) {
      const value = match[1] ?? match[2] ?? match[3];
      if (!value || !ROUTE.test(value)) continue;
      let byLanguage = routes.get(value);
      if (!byLanguage) {
        byLanguage = new Map();
        routes.set(value, byLanguage);
      }
      add(byLanguage, language, file);
    }

    if (!isTest) {
      for (const line of text.split("\n")) {
        let target: string | undefined;
        if (language === "go") target = GO_IMPORT.exec(line)?.[1];
        else if (language === "python") {
          const found = PY_IMPORT.exec(line);
          target = found?.[1] ?? found?.[2];
        } else if (language === "ts") target = TS_IMPORT.exec(line)?.[1];
        if (!target) continue;
        const other = resolveImport(target, area, declared, areaOf);
        if (!other) continue;
        const edge = `${area} -> ${other}`;
        importEdges.set(edge, (importEdges.get(edge) ?? 0) + 1);
        const seen = importEvidence.get(edge);
        if (!seen || seen.size < 4) add(importEvidence, edge, file);
      }
    }
  }

  const candidates: ContractCandidate[] = [];

  // Divided state. Two areas writing one table is the sharper case: something
  // has to say which is authoritative, and a page about either one alone never
  // does. A writer set disjoint from its readers is the same fact one step
  // weaker - the reader depends on a shape it does not control.
  for (const table of ddlTables) {
    const wrote = writers.get(table);
    const read = readers.get(table);
    if (!wrote?.size || !read?.size) continue;
    const consumers = [...read].filter((area) => !wrote.has(area)).sort();
    if (wrote.size < 2 && consumers.length === 0) continue;
    const areas = [...new Set([...wrote, ...read])].sort();
    candidates.push({
      kind: "divided-state",
      name: table,
      signal: wrote.size > 1 ? "written by several areas" : "written by one, read by others",
      areas,
      writers: [...wrote].sort(),
      consumers,
      evidence: [...(tableEvidence.get(table) ?? [])].sort().slice(0, 8),
      tests: [...(tableTests.get(table) ?? [])].sort().slice(0, 3),
      weight: (wrote.size > 1 ? 80 : 50) + 10 * areas.length,
    });
  }

  // One route, two languages: only one of them serves it, and which one is a
  // fact no page about either language's area contains.
  for (const [route, byLanguage] of routes) {
    const languages = [...byLanguage.keys()].filter((one) =>
      ["go", "python", "ts"].includes(one),
    );
    if (languages.length < 2) continue;
    const paths = [...byLanguage.values()].flatMap((set) => [...set]);
    candidates.push({
      kind: "parallel-impl",
      name: route,
      signal: languages.sort().join("+"),
      areas: [...new Set(paths.map(areaOf))].sort(),
      evidence: paths.filter((file) => !TEST_FILE.test(path.posix.basename(file))).sort().slice(0, 6),
      tests: paths.filter((file) => TEST_FILE.test(path.posix.basename(file))).sort().slice(0, 3),
      weight: 40 + 10 * languages.length,
    });
  }

  for (const [edge, count] of importEdges) {
    if (count < 3) continue;
    candidates.push({
      kind: "cross-area-import",
      name: edge,
      signal: `${count} imports`,
      areas: edge.split(" -> "),
      evidence: [...(importEvidence.get(edge) ?? [])].sort(),
      tests: [],
      weight: Math.min(count, 30),
    });
  }

  candidates.sort(
    (a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
  return options.limit ? candidates.slice(0, options.limit) : candidates;
}

/**
 * Resolves an import target to the area that declares it.
 *
 * Trailing segments are stripped until a declared name matches, which is a walk
 * of the target's own depth rather than of every name in the repository.
 *
 * @param target - Import string as written.
 * @param area - Area doing the importing.
 * @param declared - Names areas are imported by.
 * @param areaOf - Area lookup, for mapping a declaring directory to its area.
 * @returns The other area, or undefined when the import stays inside this one.
 */
function resolveImport(
  target: string,
  area: string,
  declared: Map<string, string>,
  areaOf: (file: string) => string,
): string | undefined {
  let candidate = target.replace(/^[./]+/u, "");
  for (let depth = 0; depth < 10; depth += 1) {
    if (!candidate) return undefined;
    const directory = declared.get(candidate);
    if (directory !== undefined) {
      const other = directory === "/" ? "/" : areaOf(`${directory}/x`);
      return other === area ? undefined : other;
    }
    const cut = Math.max(candidate.lastIndexOf("."), candidate.lastIndexOf("/"));
    if (cut <= 0) return undefined;
    candidate = candidate.slice(0, cut);
  }
  return undefined;
}

/**
 * One discovery per repository, shared by the tools that need it.
 *
 * Both the plan tool and the authoring gate ask the same question of the same
 * tree, and planning asks it many times. Keyed by root so a process serving more
 * than one repository still answers about the right one.
 */
const shared = new Map<string, Promise<ContractCandidate[]>>();

/**
 * Discovers a repository's contracts once and reuses the result.
 *
 * Failure yields an empty set rather than throwing: discovery informs a plan and
 * must not be able to stop one.
 *
 * @param rootDir - Absolute repository root.
 * @returns Candidates, sharpest first.
 */
export async function sharedContracts(
  rootDir: string,
): Promise<ContractCandidate[]> {
  const existing = shared.get(rootDir);
  if (existing) return existing;
  const pending = discoverSharedContracts(rootDir).catch(() => []);
  shared.set(rootDir, pending);
  return pending;
}
