import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

/**
 * Reports malformed or unsafe OpenWiki-owned generation state.
 */
export class GenerationPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GenerationPersistenceError";
  }
}

/**
 * Test seam for the atomic publication boundary.
 */
export interface AtomicRepositoryFilesOptions {
  /**
   * Rename implementation publishing a completed temporary file.
   *
   * @default node:fs/promises rename.
   */
  rename?: typeof rename;
}

/**
 * Safe atomic file operations confined to one absolute repository root.
 */
export class AtomicRepositoryFiles {
  /**
   * Rename implementation publishing a completed temporary file.
   */
  private readonly renameFile: typeof rename;

  /**
   * Lexical absolute repository root.
   */
  private readonly rootDir: string;

  /**
   * Lazily resolved physical repository root.
   *
   * @default undefined until the first operation.
   */
  private realRootPromise?: Promise<string>;

  constructor(rootDir: string, options: AtomicRepositoryFilesOptions = {}) {
    if (!path.isAbsolute(rootDir)) {
      throw new GenerationPersistenceError(
        "Atomic repository root must be absolute.",
      );
    }
    this.rootDir = path.resolve(rootDir);
    this.renameFile = options.rename ?? rename;
  }

  /**
   * Reads one contained regular UTF-8 file.
   *
   * @param relativePath - Repository-relative path.
   * @returns File contents, or `null` when absent.
   */
  async readText(relativePath: string): Promise<string | null> {
    const target = this.resolveLexicalPath(relativePath);
    const physical = await this.resolveExistingRegularFile(target);
    if (!physical) {
      return null;
    }
    return readFile(physical, "utf8");
  }

  /**
   * Atomically replaces one contained UTF-8 file.
   *
   * @param relativePath - Repository-relative path.
   * @param content - Complete replacement contents.
   */
  async replaceText(relativePath: string, content: string): Promise<void> {
    const target = this.resolveLexicalPath(relativePath);
    const directory = await this.ensureContainedDirectory(path.dirname(target));
    const physicalTarget = path.join(directory, path.basename(target));
    await this.assertReplaceableTarget(target);
    const temporary = path.join(
      directory,
      `.${path.basename(target)}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, content, "utf8");
      await this.renameFile(temporary, physicalTarget);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Removes one contained regular file without following aliases.
   *
   * @param relativePath - Repository-relative path.
   */
  async remove(relativePath: string): Promise<void> {
    const target = this.resolveLexicalPath(relativePath);
    const physical = await this.resolveExistingRegularFile(target);
    if (physical) {
      await rm(physical);
    }
  }

  /**
   * Converts a repository-relative path to a safe lexical absolute path.
   *
   * @param relativePath - Candidate repository-relative path.
   * @returns Absolute path strictly below the repository root.
   */
  private resolveLexicalPath(relativePath: string): string {
    const normalized = relativePath.replace(/\\/gu, "/");
    if (
      !normalized ||
      path.posix.isAbsolute(normalized) ||
      normalized
        .split("/")
        .some((segment) => segment === "." || segment === "..")
    ) {
      throw new GenerationPersistenceError(
        `Unsafe repository-relative path: ${relativePath}`,
      );
    }
    const target = path.resolve(this.rootDir, normalized);
    if (!isPathInside(this.rootDir, target)) {
      throw new GenerationPersistenceError(
        `Repository path escapes the root: ${relativePath}`,
      );
    }
    return target;
  }

  /**
   * Resolves an existing regular file and rejects symbolic links or aliases.
   *
   * @param target - Lexical absolute target.
   * @returns Physical path, or `null` when absent.
   */
  private async resolveExistingRegularFile(
    target: string,
  ): Promise<string | null> {
    let metadata;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new GenerationPersistenceError(
        `Owned path is not a regular file: ${this.display(target)}`,
      );
    }
    const physical = await realpath(target);
    await this.assertExpectedPhysicalPath(target, physical);
    return physical;
  }

  /**
   * Rejects an existing target unless it is the expected regular file.
   *
   * @param target - Lexical target location.
   */
  private async assertReplaceableTarget(target: string): Promise<void> {
    await this.resolveExistingRegularFile(target);
  }

  /**
   * Creates a directory after validating every existing ancestor.
   *
   * @param target - Lexical absolute directory.
   * @returns Physical directory path.
   */
  private async ensureContainedDirectory(target: string): Promise<string> {
    const relative = path.relative(this.rootDir, target);
    if (!isPathInsideOrEqual(this.rootDir, target)) {
      throw new GenerationPersistenceError(
        `Owned directory escapes the root: ${relative}`,
      );
    }
    let current = this.rootDir;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let metadata;
      try {
        metadata = await lstat(current);
      } catch (error) {
        if (isMissing(error)) {
          break;
        }
        throw error;
      }
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new GenerationPersistenceError(
          `Owned path is not a directory: ${this.display(current)}`,
        );
      }
      await this.assertExpectedPhysicalPath(current, await realpath(current));
    }
    await mkdir(target, { recursive: true });
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new GenerationPersistenceError(
        `Owned path is not a directory: ${this.display(target)}`,
      );
    }
    const physical = await realpath(target);
    await this.assertExpectedPhysicalPath(target, physical);
    return physical;
  }

  /**
   * Verifies that physical resolution exactly matches the lexical path.
   *
   * @param lexical - Lexical absolute path.
   * @param physical - Resolved physical path.
   */
  private async assertExpectedPhysicalPath(
    lexical: string,
    physical: string,
  ): Promise<void> {
    const realRoot = await this.getRealRoot();
    const expected = path.resolve(
      realRoot,
      path.relative(this.rootDir, lexical),
    );
    if (physical !== expected || !isPathInsideOrEqual(realRoot, physical)) {
      throw new GenerationPersistenceError(
        `Owned path traverses an alias or symbolic link: ${this.display(lexical)}`,
      );
    }
  }

  /**
   * Resolves and caches the physical repository root.
   *
   * @returns Physical root.
   */
  private async getRealRoot(): Promise<string> {
    this.realRootPromise ??= realpath(this.rootDir);
    return this.realRootPromise;
  }

  /**
   * Formats one absolute path without exposing a parent directory.
   *
   * @param target - Absolute path.
   * @returns Repository-relative diagnostic path.
   */
  private display(target: string): string {
    return path.relative(this.rootDir, target).replace(/\\/gu, "/");
  }
}

/**
 * Determines whether a path is strictly below a root.
 *
 * @param root - Absolute root.
 * @param candidate - Absolute candidate.
 * @returns Whether the candidate remains below the root.
 */
function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Determines whether a path is a root or remains strictly below it.
 *
 * @param root - Absolute root.
 * @param candidate - Absolute candidate.
 * @returns Whether the candidate is the root or one of its descendants.
 */
function isPathInsideOrEqual(root: string, candidate: string): boolean {
  return (
    path.resolve(candidate) === path.resolve(root) ||
    isPathInside(root, candidate)
  );
}

/**
 * Determines whether an unknown filesystem failure means absence.
 *
 * @param error - Unknown failure.
 * @returns Whether the error code is ENOENT.
 */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
