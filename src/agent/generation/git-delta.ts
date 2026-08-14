import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OpenWikiIgnore } from "../openwiki-ignore.js";

/**
 * Promise-based process execution used only with fixed Git arguments.
 */
const execFileAsync = promisify(execFile);

/**
 * Maximum buffered output for one Git inventory command.
 */
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Reports that a trustworthy repository delta could not be collected.
 */
export class GitDeltaCollectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitDeltaCollectionError";
  }
}

/**
 * One current repository path changed since the last recorded run.
 */
export interface GitChange {
  /**
   * Git status such as M, A, D, R, or ?.
   */
  status: string;

  /**
   * Current repository-relative path.
   */
  path: string;

  /**
   * Previous path for a rename.
   *
   * @default undefined for non-renames.
   */
  previousPath?: string;
}

/**
 * Deterministic repository delta supplied to update planning.
 */
export interface GitDelta {
  /**
   * Whether comparison used the last recorded head or a current full scan.
   */
  mode: "incremental" | "full-scan";

  /**
   * Stable filtered changed paths.
   */
  changes: GitChange[];
}

/**
 * Collects committed and worktree changes without reading file contents.
 *
 * A missing/unreachable base enters full-scan mode rather than failing. All
 * OpenWiki outputs and ignored paths are excluded before model planning.
 *
 * @param cwd - Absolute repository root.
 * @param previousHead - Last recorded Git head.
 * @param openWikiIgnore - Active repository read boundary.
 * @returns Stable current delta.
 */
export async function collectGitDelta(
  cwd: string,
  previousHead: string | undefined,
  openWikiIgnore: OpenWikiIgnore,
): Promise<GitDelta> {
  const baseReachable = previousHead
    ? (await runGit(cwd, ["cat-file", "-e", `${previousHead}^{commit}`])).ok
    : false;
  let mode: GitDelta["mode"] = baseReachable ? "incremental" : "full-scan";
  let committed: GitChange[];
  if (baseReachable) {
    const diff = await runGit(cwd, [
      "diff",
      "--name-status",
      "--find-renames",
      "-z",
      `${previousHead}..HEAD`,
    ]);
    if (diff.ok) {
      committed = parseNameStatus(diff.stdout);
    } else {
      mode = "full-scan";
      committed = await collectFullScan(cwd, diff.error);
    }
  } else {
    committed = await collectFullScan(cwd);
  }
  const status = await runGit(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (!status.ok) {
    throw gitCommandFailure("status", status.error);
  }
  const worktree = parseShortStatus(status.stdout);
  const byIdentity = new Map<string, GitChange>();
  for (const change of mergeCollectedChanges(mode, committed, worktree)) {
    const paths = [change.path, change.previousPath].filter(
      (value): value is string => Boolean(value),
    );
    if (
      paths.some(isOpenWikiPath) ||
      paths.some((value) => openWikiIgnore.ignores(value))
    ) {
      continue;
    }
    byIdentity.set(
      `${change.status}:${change.previousPath ?? ""}:${change.path}`,
      change,
    );
  }
  return {
    mode,
    changes: [...byIdentity.values()].sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.status.localeCompare(right.status),
    ),
  };
}

/**
 * Combines committed/full-scan inventory with current worktree status.
 *
 * In incremental mode distinct committed and worktree statuses can both be
 * meaningful. In full-scan mode every current path is already represented as
 * added, so only deletions and renames replace that inventory; ordinary
 * modifications and untracked status would otherwise duplicate the same path.
 *
 * @param mode - Delta collection mode.
 * @param committed - Incremental changes or full current inventory.
 * @param worktree - Current porcelain status changes.
 * @returns Changes before boundary filtering and stable sorting.
 */
function mergeCollectedChanges(
  mode: GitDelta["mode"],
  committed: readonly GitChange[],
  worktree: readonly GitChange[],
): GitChange[] {
  if (mode === "incremental") return [...committed, ...worktree];
  const byPath = new Map(committed.map((change) => [change.path, change]));
  for (const change of worktree) {
    if (change.status === "D" || change.previousPath !== undefined) {
      byPath.set(change.path, change);
    } else if (!byPath.has(change.path)) {
      byPath.set(change.path, change);
    }
  }
  return [...byPath.values()];
}

/**
 * Captured outcome of one fixed Git command.
 */
interface GitCommandResult {
  /**
   * Whether Git exited successfully.
   */
  ok: boolean;

  /**
   * Complete standard output decoded by Node.
   */
  stdout: string;

  /**
   * Original command failure when `ok` is false.
   */
  error?: unknown;
}

/**
 * Runs one fixed Git command and preserves normal command failures as data.
 */
async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync("git", ["--no-pager", ...args], {
      cwd,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    const failure = error as { stdout?: unknown };
    return {
      ok: false,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      error,
    };
  }
}

/**
 * Collects a complete tracked/untracked inventory or fails closed.
 *
 * @param cwd - Absolute repository root.
 * @param cause - Earlier incremental failure that forced the fallback.
 * @returns Full-scan paths represented as current additions.
 */
async function collectFullScan(
  cwd: string,
  cause?: unknown,
): Promise<GitChange[]> {
  const inventory = await runGit(cwd, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (!inventory.ok) {
    throw gitCommandFailure(
      "full repository inventory",
      inventory.error,
      cause,
    );
  }
  return parseFullScan(inventory.stdout);
}

/**
 * Parses `git diff --name-status` output.
 */
function parseNameStatus(output: string): GitChange[] {
  const fields = splitNul(output);
  const changes: GitChange[] = [];
  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++];
    const first = fields[index++];
    if (!rawStatus || first === undefined) {
      throw malformedGitOutput("diff --name-status");
    }
    const status = rawStatus[0];
    if (status === "R" || status === "C") {
      const second = fields[index++];
      if (second === undefined) {
        throw malformedGitOutput("diff --name-status rename");
      }
      changes.push({ status, previousPath: first, path: second });
    } else {
      changes.push({ status, path: first });
    }
  }
  return changes;
}

/**
 * Parses a full tracked/untracked inventory as added/current paths.
 */
function parseFullScan(output: string): GitChange[] {
  return splitNul(output).map((path) => ({ status: "A", path }));
}

/**
 * Parses `git status --short` output including renames.
 */
function parseShortStatus(output: string): GitChange[] {
  const fields = splitNul(output);
  const changes: GitChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record.length < 4 || record[2] !== " ") {
      throw malformedGitOutput("status --porcelain=v1");
    }
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const status = worktreeStatus === " " ? indexStatus : worktreeStatus;
    const path = record.slice(3);
    if (/[RC]/u.test(`${indexStatus}${worktreeStatus}`)) {
      const previousPath = fields[++index];
      if (previousPath === undefined) {
        throw malformedGitOutput("status --porcelain=v1 rename");
      }
      changes.push({ status, previousPath, path });
    } else {
      changes.push({ status, path });
    }
  }
  return changes;
}

/**
 * Splits NUL-delimited Git output without altering legal path bytes.
 *
 * @param output - Complete command output.
 * @returns Fields excluding the conventional trailing empty value.
 */
function splitNul(output: string): string[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

/**
 * Determines whether a path is OpenWiki-owned output.
 */
function isOpenWikiPath(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "openwiki" || normalized.startsWith("openwiki/");
}

/**
 * Creates a bounded systemic failure for an unusable Git command.
 *
 * @param operation - Human-readable collection operation.
 * @param error - Current Git failure.
 * @param fallbackCause - Optional incremental failure preceding full scan.
 * @returns Typed collection error.
 */
function gitCommandFailure(
  operation: string,
  error: unknown,
  fallbackCause?: unknown,
): GitDeltaCollectionError {
  const cause = fallbackCause
    ? new AggregateError(
        [fallbackCause, error],
        `Incremental and fallback Git collection failed during ${operation}.`,
      )
    : error;
  return new GitDeltaCollectionError(
    `Unable to collect Git ${operation}; update planning cannot safely continue.`,
    { cause },
  );
}

/**
 * Creates a typed parse failure for structurally invalid Git output.
 *
 * @param operation - Git output format being parsed.
 * @returns Typed collection error.
 */
function malformedGitOutput(operation: string): GitDeltaCollectionError {
  return new GitDeltaCollectionError(`Malformed Git ${operation} output.`);
}
