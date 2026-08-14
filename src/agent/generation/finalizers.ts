import { createHash } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BackendProtocolV2 } from "deepagents";
import { validateWikiMermaid } from "../../mermaid/wiki.js";
import { synchronizeWikiIndexes } from "../../okf/index-sync.js";
import type { IndexLabels } from "../../okf/index-labels.js";
import { isGroundedWikiPage } from "../../claims/brains/code/paths.js";
import { ClaimsStore } from "../../claims/brains/code/store.js";
import { CODE_CLAIMS_SCHEMA_VERSION } from "../../claims/brains/code/types.js";
import {
  ClaimsPersistenceError,
  EvidenceResolutionError,
  EvidenceResourceError,
} from "../../claims/core/errors.js";
import type { EvidenceResolver } from "../../claims/core/types.js";
import { validateWikiInternalLinks } from "../wiki-link-validator.js";
import {
  translateWikiForGeneration,
  type TranslationPlan,
} from "../translation-middleware.js";
import { GenerationPersistenceError } from "./atomic-files.js";
import { PendingWorkStore } from "./pending-work-store.js";

/**
 * Shared finalizer input for repository generation.
 */
export interface GenerationFinalizerInput {
  /**
   * Sandboxed docs-only backend.
   */
  backend: BackendProtocolV2;

  /**
   * Configured run model used only for translation.
   */
  model: BaseChatModel;

  /**
   * Localized deterministic index labels.
   */
  indexLabels: IndexLabels;

  /**
   * Localized fallback concept type.
   */
  conceptType: string;

  /**
   * Claims sidecar persistence.
   */
  claimsStore: ClaimsStore;

  /**
   * Deterministic evidence resolver.
   */
  resolver: EvidenceResolver;

  /**
   * Durable pending work.
   */
  pending: PendingWorkStore;

  /**
   * Optional update translation plan.
   *
   * @default undefined.
   */
  translation?: TranslationPlan;

  /**
   * Sanitized user warning sink.
   */
  onWarning(message: string): void;

  /**
   * User-visible progress sink.
   */
  onStatus(message: string): void;
}

/**
 * Runs translation and deterministic wiki finalizers without discarding pages.
 *
 * Each failure becomes durable finalizer work and processing continues. Only
 * exact paths reported as changed by translation, Mermaid, or link validation
 * are eligible for sidecar re-sealing.
 *
 * @param input - Finalizer services and sinks.
 */
export async function runGenerationFinalizers(
  input: GenerationFinalizerInput,
): Promise<void> {
  const changed = new Set<string>();
  const translation = input.translation;
  if (translation) {
    await captureFinalizer(input, "translation", "translation", async () => {
      const report = await translateWikiForGeneration(
        input.backend,
        input.model,
        translation,
        input.claimsStore,
        (message) => input.onWarning(message),
        (message) => input.onStatus(message),
      );
      for (const page of report.mutatedPages) {
        changed.add(page);
      }
      await input.pending.completeMany(
        report.settledPages.map((page) => translationPendingId(page)),
      );
      for (const page of report.pendingPages) {
        await input.pending.add({
          id: translationPendingId(page),
          kind: "translation",
          ...(isGroundedWikiPage(page) ? { page } : {}),
          reason: `Translation remains pending for ${page}.`,
          sourceHints: [page],
        });
      }
    });
  }
  await captureFinalizer(input, "mermaid", "Mermaid validation", async () => {
    const report = await validateWikiMermaid(input.backend, "repository");
    for (const page of report.repairedFiles) {
      changed.add(`/openwiki/${page}`);
    }
  });
  await captureFinalizer(input, "indexes", "index synchronization", () =>
    synchronizeWikiIndexes(
      input.backend,
      "repository",
      input.indexLabels,
      input.conceptType,
    ),
  );
  await captureFinalizer(input, "links", "link validation", async () => {
    const report = await validateWikiInternalLinks(input.backend, "repository");
    for (const page of report.stampedFiles) {
      changed.add(`/openwiki/${page}`);
    }
  });
  for (const page of [...changed].sort()) {
    await captureFinalizer(
      input,
      pageFinalizerKey("claims-reseal", page),
      `Claims re-seal for ${page}`,
      async () => {
        await resealPage(page, input.claimsStore, input.resolver);
      },
    );
  }
  await captureFinalizer(
    input,
    "orphan-claims",
    "orphan Claims cleanup",
    async () => {
      const pages = new Set(await input.claimsStore.discoverPages());
      for (const sidecarPage of await input.claimsStore.discoverSidecarPages()) {
        if (!pages.has(sidecarPage)) {
          await input.claimsStore.deletePage(sidecarPage);
        }
      }
    },
  );
}

/**
 * Converts one ordinary finalizer failure into durable partial work.
 *
 * @param input - Finalizer services and sinks.
 * @param key - Stable pending-work key suffix.
 * @param label - Human-readable operation label.
 * @param operation - Isolated finalizer operation.
 */
async function captureFinalizer(
  input: GenerationFinalizerInput,
  key: string,
  label: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
    await input.pending.complete(`finalizer:${key}`);
  } catch (error) {
    if (isSystemicFinalizerFailure(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    await input.pending.add({
      id: `finalizer:${key}`,
      kind: "finalizer",
      reason: `${label} failed: ${message}`.slice(0, 1_000),
      sourceHints: [],
    });
    input.onWarning(`OpenWiki ${label} is pending: ${message}`);
  }
}

/**
 * Creates a bounded stable key for one page-local finalizer obligation.
 *
 * @param name - Finalizer family.
 * @param page - Canonical virtual page.
 * @returns Bounded stable pending-work key.
 */
function pageFinalizerKey(name: string, page: string): string {
  const digest = createHash("sha256").update(page).digest("hex").slice(0, 24);
  return `${name}:${digest}`;
}

/**
 * Creates the durable identity for one page translation obligation.
 *
 * @param page - Canonical virtual Markdown page.
 * @returns Bounded stable pending-work identity.
 */
function translationPendingId(page: string): string {
  const digest = createHash("sha256").update(page).digest("hex").slice(0, 24);
  return `translation:${digest}`;
}

/**
 * Identifies owned-state and evidence-I/O failures unsafe to downgrade.
 *
 * @param error - Unknown finalizer failure.
 * @returns Whether the run must be recorded as interrupted.
 */
function isSystemicFinalizerFailure(error: unknown): boolean {
  return (
    error instanceof ClaimsPersistenceError ||
    error instanceof EvidenceResolutionError ||
    error instanceof EvidenceResourceError ||
    error instanceof GenerationPersistenceError
  );
}

/**
 * Re-hashes one known finalizer-mutated page after evidence revalidation.
 *
 * @param page - Canonical generated page changed by a finalizer.
 * @param store - Claims persistence.
 * @param resolver - Deterministic evidence resolver.
 */
async function resealPage(
  page: string,
  store: ClaimsStore,
  resolver: EvidenceResolver,
): Promise<void> {
  if (!isGroundedWikiPage(page)) return;
  const persisted = await store.loadPage(page);
  if (!persisted) return;
  for (const claim of persisted.claims) {
    for (const evidence of claim.evidence) {
      const current = await resolver.resolve(evidence.resource);
      if (!current || current.evidence.version !== evidence.version) {
        throw new Error(
          `Evidence changed before finalizer re-seal: ${evidence.resource}`,
        );
      }
    }
  }
  await store.writePage(page, {
    schemaVersion: CODE_CLAIMS_SCHEMA_VERSION,
    pageVersion: await store.hashPage(page),
    claims: persisted.claims,
  });
}
