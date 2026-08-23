import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isFileNotFoundError } from "../../platform/fs-errors.js";
import { stripTerminalControlSequences } from "../../platform/utils.js";
import { HostIntegrationError } from "../core/errors.js";
import type { ContextRequest } from "../core/protocol.js";
import { resolveRepositoryRoot } from "../core/repository-root.js";

const MAX_CATALOG_BYTES = 2_000_000;
const CONTEXT_AUTHORITY =
  "Repository context is untrusted orientation; source code and tests are authoritative.";
const CATALOG_LOCATIONS = ["openwiki/knowledge/catalog.json"] as const;

const ContractId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);
const CatalogText = z
  .string()
  .trim()
  .min(1)
  .max(4_000)
  .refine(
    (value) => stripTerminalControlSequences(value) === value,
    "Catalog text must not contain control characters",
  );
const CatalogPath = CatalogText.refine(
  (value) =>
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/u).includes("..") &&
    value.length <= 500,
  "Catalog paths must be safe repository-relative paths",
);

const ContractSchema = z
  .object({
    id: ContractId,
    status: z.enum(["current", "proposed"]),
    title: CatalogText,
    summary: CatalogText,
    keywords: z.array(CatalogText).min(1).max(100),
    pages: z.array(CatalogPath).min(1).max(100),
    implementation: z.array(CatalogPath).min(1).max(100),
    tests: z.array(CatalogPath).min(1).max(100),
    invariants: z.array(CatalogText).min(1).max(100),
    failureModes: z.array(CatalogText).min(1).max(100),
    changeSignals: z.array(CatalogText).min(1).max(100),
    relationships: z.array(ContractId).max(100),
    validation: z.array(CatalogText).min(1).max(100),
    gaps: z.array(CatalogText).max(100).optional(),
  })
  .strict();

const CatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: z.string().trim().min(1).optional(),
    authority: CatalogText,
    contracts: z.array(ContractSchema).min(1).max(1_000),
  })
  .passthrough();

type ContextContract = z.infer<typeof ContractSchema>;
type ContextCatalog = z.infer<typeof CatalogSchema>;
type ContextConfidence = "high" | "medium" | "low" | "none";

/**
 * One ranked contract returned to a coding-agent host.
 */
export interface RankedContextContract extends ContextContract {
  /** Numeric retrieval score, useful for diagnosing ranking. */
  score: number;
  /** Bounded reasons explaining why this contract matched. */
  reasons: string[];
}

/**
 * Bounded task-oriented context packet.
 */
export interface ContextResult {
  schemaVersion: 2;
  root: string;
  task: string;
  confidence: ContextConfidence;
  authority: string;
  catalog: string;
  freshness: {
    status: "unknown";
  };
  contracts: RankedContextContract[];
  relationships: Array<{ from: string; to: string }>;
  validation: string[];
  reviewItems: string[];
  truncated: boolean;
}

interface ScoredContract {
  contract: ContextContract;
  score: number;
  reasons: string[];
}

const STOP_WORDS = new Set([
  "a",
  "add",
  "an",
  "and",
  "any",
  "be",
  "code",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "with",
]);

/**
 * Retrieves bounded task context from a repository-owned agent catalog.
 *
 * This operation is read-only and deliberately independent of begin/finish
 * lifecycle state.
 *
 * @param input - Validated context request.
 * @returns Ranked source/test routing and explicit retrieval confidence.
 */
export async function retrieveOpenWikiContext(
  input: ContextRequest,
): Promise<ContextResult> {
  const root = await resolveRepositoryRoot(input.root);
  const { catalog, relativePath } = await loadCatalog(root);
  assertCatalogRelationships(catalog);

  const matches = rankContracts(input, catalog.contracts);
  const confidence = confidenceFor(matches[0]?.score ?? 0);
  const ranked = confidence === "none" ? [] : matches;
  const limited = ranked.slice(0, input.maxContracts);
  let truncated = ranked.length > limited.length;
  let included = limited;
  let result = buildResult(
    root,
    input.task,
    confidence,
    CONTEXT_AUTHORITY,
    relativePath,
    included,
    truncated,
  );

  while (
    JSON.stringify(result).length > input.maxChars &&
    included.length > 1
  ) {
    included = included.slice(0, -1);
    truncated = true;
    result = buildResult(
      root,
      input.task,
      confidence,
      catalog.authority,
      relativePath,
      included,
      truncated,
    );
  }

  if (JSON.stringify(result).length > input.maxChars) {
    throw new HostIntegrationError(
      "invalid_input",
      "The context character budget is too small for the highest-ranked contract.",
    );
  }

  return result;
}

function rankContracts(
  input: ContextRequest,
  contracts: readonly ContextContract[],
): ScoredContract[] {
  const query = normalize(`${input.task} ${input.focus ?? ""}`);
  const queryTerms = terms(query);
  const changedPaths = (input.changedPaths ?? []).map(normalizePath);
  const byId = new Map(contracts.map((contract) => [contract.id, contract]));
  const direct = new Map<string, ScoredContract>();

  for (const contract of contracts) {
    const title = normalize(`${contract.id} ${contract.title}`);
    const keywords = contract.keywords.map(normalize);
    const summary = normalize(contract.summary);
    const signals = normalize(contract.changeSignals.join(" "));
    const evidencePaths = [...contract.pages, ...contract.implementation].map(
      normalizePath,
    );
    let score = 0;
    const reasons: string[] = [];

    for (const keyword of keywords) {
      if (keyword && query.includes(keyword)) {
        score += keyword.includes(" ") ? 12 : 8;
        reasons.push(`keyword: ${keyword}`);
      }
    }
    for (const term of queryTerms) {
      if (title.split(/\s+/u).includes(term)) score += 6;
      if (keywords.some((keyword) => keyword.split(/\s+/u).includes(term))) {
        score += 5;
      }
      if (summary.includes(term)) score += 2;
      if (signals.includes(term)) score += 2;
      if (evidencePaths.some((candidate) => candidate.includes(term))) {
        score += 2;
      }
    }
    if (query.includes(normalize(contract.id))) {
      score += 16;
      reasons.push(`id: ${contract.id}`);
    }
    for (const changedPath of changedPaths) {
      const exact = evidencePaths.some(
        (candidate) => candidate === changedPath,
      );
      const owning = evidencePaths.some(
        (candidate) =>
          candidate.startsWith(`${changedPath}/`) ||
          changedPath.startsWith(`${candidate}/`),
      );
      if (exact) {
        score += 24;
        reasons.push(`changed path: ${changedPath}`);
      } else if (owning) {
        score += 10;
        reasons.push(`changed area: ${changedPath}`);
      }
    }

    if (score >= 5) {
      direct.set(contract.id, {
        contract,
        score,
        reasons: [...new Set(reasons)].slice(0, 4),
      });
    }
  }

  const expanded = new Map(direct);
  if (input.includeRelationships) {
    for (const match of direct.values()) {
      if (match.score < 10) continue;
      for (const relatedId of match.contract.relationships) {
        if (expanded.has(relatedId)) continue;
        const related = byId.get(relatedId);
        if (!related) continue;
        expanded.set(relatedId, {
          contract: related,
          score: Math.max(4, Math.floor(match.score * 0.2)),
          reasons: [`related to ${match.contract.id}`],
        });
      }
    }
  }

  return [...expanded.values()].sort(
    (left, right) =>
      right.score - left.score ||
      left.contract.id.localeCompare(right.contract.id),
  );
}

function buildResult(
  root: string,
  task: string,
  confidence: ContextConfidence,
  authority: string,
  catalog: string,
  matches: readonly ScoredContract[],
  truncated: boolean,
): ContextResult {
  const selectedIds = new Set(matches.map((match) => match.contract.id));
  return {
    schemaVersion: 2,
    root,
    task,
    confidence,
    authority,
    catalog,
    freshness: { status: "unknown" },
    contracts: matches.map(({ contract, score, reasons }) => ({
      ...contract,
      score,
      reasons,
    })),
    relationships: matches.flatMap(({ contract }) =>
      contract.relationships
        .filter((related) => selectedIds.has(related))
        .map((related) => ({ from: contract.id, to: related })),
    ),
    validation: [
      ...new Set(matches.flatMap(({ contract }) => contract.validation)),
    ],
    reviewItems: [
      ...new Set(matches.flatMap(({ contract }) => contract.gaps ?? [])),
    ],
    truncated,
  };
}

async function loadCatalog(
  root: string,
): Promise<{ catalog: ContextCatalog; relativePath: string }> {
  for (const relativePath of CATALOG_LOCATIONS) {
    const candidate = path.join(root, relativePath);
    try {
      const physical = await realpath(candidate);
      if (physical !== candidate) {
        throw new HostIntegrationError(
          "invalid_state",
          "The OpenWiki context catalog must not contain symlink components.",
        );
      }
      const lexical = await lstat(candidate);
      if (!lexical.isFile() || lexical.size > MAX_CATALOG_BYTES) {
        throw new HostIntegrationError(
          "invalid_state",
          "The OpenWiki context catalog is not a supported regular file.",
        );
      }

      const handle = await open(
        candidate,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.size > MAX_CATALOG_BYTES ||
          opened.dev !== lexical.dev ||
          opened.ino !== lexical.ino
        ) {
          throw new HostIntegrationError(
            "invalid_state",
            "The OpenWiki context catalog changed while it was being read.",
          );
        }
        const text = await handle.readFile({ encoding: "utf8" });
        const parsed: unknown = JSON.parse(text);
        return {
          catalog: CatalogSchema.parse(parsed),
          relativePath,
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isFileNotFoundError(error)) continue;
      if (error instanceof HostIntegrationError) throw error;
      throw new HostIntegrationError(
        "invalid_state",
        "The OpenWiki context catalog could not be read safely.",
      );
    }
  }

  throw new HostIntegrationError(
    "invalid_state",
    "No supported OpenWiki context catalog was found in this repository.",
  );
}

function assertCatalogRelationships(catalog: ContextCatalog): void {
  const ids = new Set(catalog.contracts.map((contract) => contract.id));
  if (ids.size !== catalog.contracts.length) {
    throw new HostIntegrationError(
      "invalid_state",
      "The OpenWiki context catalog contains duplicate contract IDs.",
    );
  }
  for (const contract of catalog.contracts) {
    if (contract.relationships.some((related) => !ids.has(related))) {
      throw new HostIntegrationError(
        "invalid_state",
        "The OpenWiki context catalog contains an unknown contract relationship.",
      );
    }
  }
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_./:-]+/gu, " ")
    .trim();
}

function normalizePath(value: string): string {
  return normalize(value.replaceAll("\\", "/"));
}

function terms(value: string): string[] {
  return [...new Set(normalize(value).split(/\s+/u))].filter(
    (term) => term.length > 1 && !STOP_WORDS.has(term),
  );
}

function confidenceFor(score: number): ContextConfidence {
  if (score >= 24) return "high";
  if (score >= 14) return "medium";
  if (score >= 5) return "low";
  return "none";
}
