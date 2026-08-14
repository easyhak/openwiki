import { createHash } from "node:crypto";
import { applyClaimOperations, cloneClaims } from "../../core/mutations.js";
import type {
  Claim,
  ClaimOperation,
  EvidenceResolver,
} from "../../core/types.js";
import type { ClaimProposal } from "../../../agent/generation/contracts.js";

/**
 * Complete-set Claims reconciliation input.
 */
export interface ReconcileClaimSetInput {
  /**
   * Persisted current Claims for one page.
   */
  existing: readonly Claim[];

  /**
   * Model proposal representing the complete desired set.
   */
  proposal: ClaimProposal;

  /**
   * Deterministic repository evidence resolver.
   */
  resolver: EvidenceResolver;

  /**
   * Optional deterministic ID source for tests.
   *
   * @default generic Claims UUID allocation.
   */
  createClaimId?: () => string;
}

/**
 * Resolves a complete proposed Claim set without persistence.
 *
 * Every retained Claim is emitted as an update operation so current evidence
 * versions are refreshed. Missing existing IDs are deletions. New drafts omit
 * IDs and become adds. The generic mutation core preserves atomic validation.
 *
 * @param input - Existing Claims, proposal, and resolver.
 * @returns Complete resolved Claim set.
 */
export async function reconcileCompleteClaimSet(
  input: ReconcileClaimSetInput,
): Promise<Claim[]> {
  if (input.proposal.disposition === "defer") {
    throw new Error(`Deferred Claim proposal: ${input.proposal.reason}`);
  }
  if (
    input.proposal.disposition === "delete" &&
    input.proposal.claims.length > 0
  ) {
    throw new Error("A delete proposal cannot retain Claims.");
  }
  if (
    input.proposal.disposition === "write" &&
    input.proposal.claims.length === 0
  ) {
    throw new Error("A written factual page requires at least one Claim.");
  }
  const existingIds = new Set(input.existing.map((claim) => claim.id));
  const proposedIds = new Set<string>();
  const operations: ClaimOperation[] = [];
  for (const draft of input.proposal.claims) {
    if (draft.id) {
      if (!existingIds.has(draft.id)) {
        throw new Error(`Claim proposal references unknown id ${draft.id}.`);
      }
      if (proposedIds.has(draft.id)) {
        throw new Error(`Claim proposal repeats id ${draft.id}.`);
      }
      proposedIds.add(draft.id);
      operations.push({
        op: "update",
        id: draft.id,
        statement: draft.statement,
        evidence: draft.evidence,
      });
    } else {
      operations.push({
        op: "add",
        statement: draft.statement,
        evidence: draft.evidence,
      });
    }
  }
  for (const claim of input.existing) {
    if (!proposedIds.has(claim.id)) {
      operations.push({ op: "delete", id: claim.id });
    }
  }
  if (operations.length === 0) {
    return [];
  }
  return applyClaimOperations({
    claims: input.existing,
    operations,
    resolver: input.resolver,
    createClaimId: input.createClaimId,
  });
}

/**
 * Hashes complete Claim state for compact graph results.
 *
 * @param claims - Complete resolved Claim set.
 * @returns Algorithm-prefixed stable revision.
 */
export function hashClaimSet(claims: readonly Claim[]): string {
  const canonical = cloneClaims(claims)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((claim) => ({
      ...claim,
      evidence: [...claim.evidence].sort((left, right) =>
        left.resource.localeCompare(right.resource),
      ),
    }));
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;
}
