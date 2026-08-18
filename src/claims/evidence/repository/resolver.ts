import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { OpenWikiIgnore } from "../../../agent/openwiki-ignore.js";
import {
  EvidenceResolutionError,
  EvidenceResourceError,
  EvidenceSecurityError,
} from "../../core/errors.js";
import {
  formatRepositoryEvidenceResource,
  parseRepositoryEvidenceResource,
} from "./resource.js";
import type { EvidenceResolver, ResolvedEvidence } from "../../core/types.js";

/**
 * Number of complete lines hashed on either side of a selected range.
 */
const RANGE_CONTEXT_LINES = 3;

/**
 * Prefix for line-range versions carrying resolver-owned relocation metadata.
 */
const RANGE_VERSION_PREFIX = "repo-lines-v1:sha256:";

/**
 * Compact relocation metadata encoded into an opaque evidence version.
 */
interface RangeVersionMetadata {
  /** Selected line count. */
  n: number;
  /** First selected line hash. */
  f: string;
  /** Last selected line hash. */
  l: string;
  /** Number of preceding context lines. */
  bn: number;
  /** Preceding context hash. */
  b: string;
  /** Number of following context lines. */
  an: number;
  /** Following context hash. */
  a: string;
}

/**
 * Parsed prior line-range version.
 */
interface ParsedRangeVersion {
  /** Hash of the complete selected source range. */
  contentHash: string;
  /** Resolver-owned relocation metadata. */
  metadata: RangeVersionMetadata;
}

/**
 * Zero-based half-open line range inside split source text.
 */
interface ResolvedLineRange {
  /** First selected line index. */
  start: number;
  /** Index immediately after the last selected line. */
  end: number;
}

/**
 * Repository evidence resolver options.
 */
export interface RepositoryEvidenceResolverOptions {
  /**
   * Absolute repository root.
   */
  rootDir: string;

  /**
   * Read-boundary rules shared with the OpenWiki agent.
   *
   * @default an inactive rule set that permits every safe repository path.
   */
  openWikiIgnore?: OpenWikiIgnore;
}

/**
 * Resolves and versions `repo://` evidence without model involvement.
 */
export class RepositoryEvidenceResolver implements EvidenceResolver {
  /**
   * Absolute repository root.
   */
  private readonly rootDir: string;

  /**
   * Lazily resolved physical repository root.
   *
   * @default undefined until the first existing evidence file is resolved.
   */
  private realRootDirPromise?: Promise<string>;

  /**
   * Repository read-boundary rules.
   */
  private readonly openWikiIgnore: OpenWikiIgnore;

  constructor(options: RepositoryEvidenceResolverOptions) {
    if (!path.isAbsolute(options.rootDir)) {
      throw new EvidenceResourceError(
        "Repository evidence root must be absolute.",
      );
    }

    this.rootDir = path.resolve(options.rootDir);
    this.openWikiIgnore = options.openWikiIgnore ?? new OpenWikiIgnore([]);
  }

  /**
   * Resolves the current line range or whole-file representation.
   *
   * @param resource - Canonical `repo://` resource.
   * @param previousVersion - Prior opaque version used to relocate a range.
   * @returns Current evidence, or `null` when the file/range no longer exists.
   */
  async resolve(
    resource: string,
    previousVersion?: string,
  ): Promise<ResolvedEvidence | null> {
    const parsed = parseRepositoryEvidenceResource(resource);
    const canonicalResource = formatRepositoryEvidenceResource(parsed);
    if (this.openWikiIgnore.ignores(parsed.path)) {
      throw new EvidenceResourceError(
        `Evidence path is excluded by .openwikiignore: ${parsed.path}`,
      );
    }

    const absolutePath = this.resolveSafePath(parsed.path);
    let source: string;
    try {
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new EvidenceSecurityError(
          `Evidence cannot reference a symbolic link: ${parsed.path}`,
        );
      }
      if (!metadata.isFile()) {
        return null;
      }
      const realRootDir = await this.getRealRootDir();
      const physicalPath = await realpath(absolutePath);
      const expectedPhysicalPath = path.resolve(realRootDir, parsed.path);
      if (
        !isPathInside(realRootDir, physicalPath) ||
        physicalPath !== expectedPhysicalPath
      ) {
        throw new EvidenceSecurityError(
          `Evidence path traverses a symbolic link or filesystem alias: ${parsed.path}`,
        );
      }
      source = await readFile(physicalPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      if (error instanceof EvidenceResolutionError) {
        throw error;
      }
      throw new EvidenceResolutionError(
        `Unable to read evidence ${parsed.path}: ${toErrorMessage(error)}`,
      );
    }

    if (!parsed.range) {
      return wholeFileEvidence(canonicalResource, source);
    }
    return lineRangeEvidence({
      resource: canonicalResource,
      source,
      startLine: parsed.range.startLine,
      endLine: parsed.range.endLine,
      previousVersion,
    });
  }

  /**
   * Resolves a repository-relative path while enforcing root containment.
   *
   * @param relativePath - Normalized repository-relative POSIX path.
   * @returns Absolute contained filesystem path.
   */
  private resolveSafePath(relativePath: string): string {
    const absolutePath = path.resolve(this.rootDir, relativePath);
    const relative = path.relative(this.rootDir, absolutePath);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new EvidenceResourceError(
        `Evidence path escapes the repository: ${relativePath}`,
      );
    }
    return absolutePath;
  }

  /**
   * Resolves and caches the physical repository root for symlink checks.
   *
   * @returns Canonical filesystem path for the repository root.
   */
  private async getRealRootDir(): Promise<string> {
    this.realRootDirPromise ??= realpath(this.rootDir).catch(
      (error: unknown) => {
        throw new EvidenceSecurityError(
          `Unable to resolve repository root ${this.rootDir}: ${toErrorMessage(error)}`,
        );
      },
    );
    return this.realRootDirPromise;
  }
}

/**
 * Resolves a language-agnostic line range, using its prior opaque version as a
 * compact text anchor when edits moved or resized the selected source.
 *
 * @param input - Current source, requested range, and optional prior version.
 * @returns Current range evidence, or `null` when it cannot be located safely.
 */
function lineRangeEvidence(input: {
  resource: string;
  source: string;
  startLine: number;
  endLine: number;
  previousVersion?: string;
}): ResolvedEvidence | null {
  const lines = splitSourceLines(input.source);
  const hintedRange = toResolvedRange(
    input.startLine,
    input.endLine,
    lines.length,
  );
  const previousVersion = input.previousVersion;
  const previous = parseRangeVersion(previousVersion);

  if (!previous || !previousVersion) {
    return hintedRange
      ? buildLineRangeEvidence(input.resource, lines, hintedRange)
      : null;
  }

  const exactRange = locateExactRange(lines, hintedRange, previous);
  if (exactRange) {
    return {
      evidence: {
        resource: input.resource,
        version: previousVersion,
      },
      content: rangeContent(lines, exactRange),
    };
  }

  const relocatedRange = locateRangeByContext(lines, previous.metadata);
  return relocatedRange
    ? buildLineRangeEvidence(input.resource, lines, relocatedRange)
    : null;
}

/**
 * Splits source into exact lines, retaining line terminators in range content.
 * A terminal newline does not create a phantom additional source line.
 *
 * @param source - Complete source text.
 * @returns Exact source lines in order.
 */
function splitSourceLines(source: string): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline + 1;
    lines.push(source.slice(start, end));
    start = end;
  }
  return lines;
}

/**
 * Converts an inclusive one-based range to zero-based half-open indexes.
 *
 * @param startLine - First requested source line.
 * @param endLine - Last requested source line.
 * @param lineCount - Current source line count.
 * @returns Current indexes, or `null` when the request is out of bounds.
 */
function toResolvedRange(
  startLine: number,
  endLine: number,
  lineCount: number,
): ResolvedLineRange | null {
  return endLine <= lineCount ? { start: startLine - 1, end: endLine } : null;
}

/**
 * Builds current evidence and relocation metadata for one selected range.
 *
 * @param resource - Canonical repository resource.
 * @param lines - Exact current source lines.
 * @param range - Selected current range.
 * @returns Persistable range evidence.
 */
function buildLineRangeEvidence(
  resource: string,
  lines: readonly string[],
  range: ResolvedLineRange,
): ResolvedEvidence {
  const content = rangeContent(lines, range);
  return {
    evidence: {
      resource,
      version: formatRangeVersion(content, lines, range),
    },
    content,
  };
}

/**
 * Locates unchanged selected text at its original hint or elsewhere in a file.
 *
 * @param lines - Exact current source lines.
 * @param hintedRange - Current location implied by the persisted URI.
 * @param previous - Prior selected-content fingerprint and anchors.
 * @returns Unique unchanged range, or `null`.
 */
function locateExactRange(
  lines: readonly string[],
  hintedRange: ResolvedLineRange | null,
  previous: ParsedRangeVersion,
): ResolvedLineRange | null {
  if (
    hintedRange &&
    hintedRange.end - hintedRange.start === previous.metadata.n &&
    hash(rangeContent(lines, hintedRange)) === previous.contentHash
  ) {
    return hintedRange;
  }

  const matches: ResolvedLineRange[] = [];
  const lineHashes = lines.map((line) => hash(line));
  const { n, f, l } = previous.metadata;
  for (let start = 0; start + n <= lines.length; start += 1) {
    const end = start + n;
    if (lineHashes[start] !== f || lineHashes[end - 1] !== l) {
      continue;
    }
    const candidate = { start, end };
    if (hash(rangeContent(lines, candidate)) === previous.contentHash) {
      matches.push(candidate);
    }
  }
  if (matches.length === 1) {
    return matches[0];
  }
  const anchored = matches.filter((candidate) =>
    matchesRangeContext(lines, candidate, previous.metadata),
  );
  return anchored.length === 1 ? anchored[0] : null;
}

/**
 * Relocates changed selected text between its unchanged exterior anchors.
 * Ambiguous anchor pairs deliberately resolve to `null`.
 *
 * @param lines - Exact current source lines.
 * @param metadata - Prior relocation metadata.
 * @returns Unique non-empty current range, or `null`.
 */
function locateRangeByContext(
  lines: readonly string[],
  metadata: RangeVersionMetadata,
): ResolvedLineRange | null {
  const starts = findContextBoundaries(
    lines,
    metadata.bn,
    metadata.b,
    "before",
  );
  const ends = findContextBoundaries(lines, metadata.an, metadata.a, "after");
  const candidates: ResolvedLineRange[] = [];
  for (const start of starts) {
    for (const end of ends) {
      if (end > start) {
        candidates.push({ start, end });
        if (candidates.length > 1) {
          return null;
        }
      }
    }
  }
  return candidates[0] ?? null;
}

/**
 * Finds selection boundaries immediately after or before a context window.
 *
 * @param lines - Exact current source lines.
 * @param contextLineCount - Number of lines in the prior context.
 * @param contextHash - Hash of the prior context.
 * @param side - Whether matches precede or follow the selected range.
 * @returns Candidate zero-based selection boundaries.
 */
function findContextBoundaries(
  lines: readonly string[],
  contextLineCount: number,
  contextHash: string,
  side: "before" | "after",
): number[] {
  if (contextLineCount === 0) {
    return [side === "before" ? 0 : lines.length];
  }
  const boundaries: number[] = [];
  for (let start = 0; start + contextLineCount <= lines.length; start += 1) {
    if (
      hash(lines.slice(start, start + contextLineCount).join("")) ===
      contextHash
    ) {
      boundaries.push(side === "before" ? start + contextLineCount : start);
    }
  }
  return boundaries;
}

/**
 * Checks whether a candidate still has both prior exterior anchors.
 *
 * @param lines - Exact current source lines.
 * @param range - Candidate unchanged range.
 * @param metadata - Prior relocation metadata.
 * @returns Whether both anchors still surround the candidate.
 */
function matchesRangeContext(
  lines: readonly string[],
  range: ResolvedLineRange,
  metadata: RangeVersionMetadata,
): boolean {
  const beforeMatches =
    metadata.bn === 0
      ? range.start === 0
      : range.start >= metadata.bn &&
        hash(lines.slice(range.start - metadata.bn, range.start).join("")) ===
          metadata.b;
  const afterMatches =
    metadata.an === 0
      ? range.end === lines.length
      : range.end + metadata.an <= lines.length &&
        hash(lines.slice(range.end, range.end + metadata.an).join("")) ===
          metadata.a;
  return beforeMatches && afterMatches;
}

/**
 * Extracts exact source text for a line range.
 *
 * @param lines - Exact source lines.
 * @param range - Selected indexes.
 * @returns Concatenated source bytes represented as text.
 */
function rangeContent(
  lines: readonly string[],
  range: ResolvedLineRange,
): string {
  return lines.slice(range.start, range.end).join("");
}

/**
 * Formats a range content hash plus compact relocation metadata.
 *
 * @param content - Exact selected text.
 * @param lines - Exact complete source lines.
 * @param range - Selected current range.
 * @returns Opaque persistable evidence version.
 */
function formatRangeVersion(
  content: string,
  lines: readonly string[],
  range: ResolvedLineRange,
): string {
  const beforeStart = Math.max(0, range.start - RANGE_CONTEXT_LINES);
  const afterEnd = Math.min(lines.length, range.end + RANGE_CONTEXT_LINES);
  const metadata: RangeVersionMetadata = {
    n: range.end - range.start,
    f: hash(lines[range.start]),
    l: hash(lines[range.end - 1]),
    bn: range.start - beforeStart,
    b: hash(lines.slice(beforeStart, range.start).join("")),
    an: afterEnd - range.end,
    a: hash(lines.slice(range.end, afterEnd).join("")),
  };
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString(
    "base64url",
  );
  return `${RANGE_VERSION_PREFIX}${hash(content)}:${encoded}`;
}

/**
 * Parses and validates prior range relocation metadata.
 * Unknown version algorithms intentionally fall back to the URI's line hint.
 *
 * @param value - Optional prior evidence version.
 * @returns Validated range version, or `null`.
 */
function parseRangeVersion(
  value: string | undefined,
): ParsedRangeVersion | null {
  if (!value?.startsWith(RANGE_VERSION_PREFIX)) {
    return null;
  }
  const body = value.slice(RANGE_VERSION_PREFIX.length);
  const separator = body.indexOf(":");
  if (separator === -1) {
    return null;
  }
  const contentHash = body.slice(0, separator);
  if (!isHash(contentHash)) {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(body.slice(separator + 1), "base64url").toString("utf8"),
    );
    if (!isRangeVersionMetadata(decoded)) {
      return null;
    }
    return { contentHash, metadata: decoded };
  } catch {
    return null;
  }
}

/**
 * Validates decoded range relocation metadata strictly.
 *
 * @param value - Unknown decoded JSON.
 * @returns Whether the value is safe relocation metadata.
 */
function isRangeVersionMetadata(value: unknown): value is RangeVersionMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 7 &&
    Number.isSafeInteger(record.n) &&
    (record.n as number) > 0 &&
    Number.isSafeInteger(record.bn) &&
    (record.bn as number) >= 0 &&
    (record.bn as number) <= RANGE_CONTEXT_LINES &&
    Number.isSafeInteger(record.an) &&
    (record.an as number) >= 0 &&
    (record.an as number) <= RANGE_CONTEXT_LINES &&
    isHash(record.f) &&
    isHash(record.l) &&
    isHash(record.b) &&
    isHash(record.a)
  );
}

/**
 * Builds explicit whole-file evidence.
 *
 * @param resource - Canonical whole-file repository resource.
 * @param source - Complete source text.
 * @returns Whole-file-backed resolved evidence.
 */
function wholeFileEvidence(resource: string, source: string): ResolvedEvidence {
  return {
    evidence: {
      resource,
      version: version("repo-file-v1", source),
    },
    content: source,
  };
}

/**
 * Determines whether a physical path remains inside a physical root.
 *
 * @param rootDir - Canonical root directory.
 * @param candidate - Canonical candidate path.
 * @returns Whether the candidate is contained by the root.
 */
function isPathInside(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Creates an algorithm-prefixed SHA-256 evidence version.
 *
 * @param algorithm - Stable resolver algorithm identifier.
 * @param content - Canonical representation to hash.
 * @returns Persistable opaque evidence version.
 */
function version(algorithm: string, content: string): string {
  return `${algorithm}:sha256:${hash(content)}`;
}

/**
 * Hashes exact text with SHA-256.
 *
 * @param content - Text to fingerprint.
 * @returns Lowercase hexadecimal digest.
 */
function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Validates one SHA-256 hexadecimal digest.
 *
 * @param value - Unknown candidate digest.
 * @returns Whether the value is a canonical digest.
 */
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/**
 * Determines whether a filesystem error means the evidence disappeared.
 *
 * @param error - Unknown filesystem failure.
 * @returns Whether the error represents a missing path.
 */
function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Converts an unknown error into diagnostic text.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable error detail.
 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
