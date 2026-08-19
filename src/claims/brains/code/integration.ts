import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AnyAgentMiddleware } from "langchain";
import { createClaimsReadNoteMiddleware } from "./middleware.js";
import type { ClaimsRuntime } from "./runtime.js";
import {
  createClaimsDeleteFileTool,
  createClaimsTools,
  createCompleteClaimsReviewTool,
  type ClaimsDeletionBackend,
} from "./tools.js";

export interface ClaimsIntegrationOptions {
  /**
   * Exposes the explicit page-review completion gate used by Claims migration.
   */
  includeReviewCompletion?: boolean;
}

/**
 * Agent-facing pieces of the repository Claims subsystem.
 */
export interface ClaimsIntegration {
  /**
   * Claims-aware tools added to the repository agent.
   */
  tools: StructuredToolInterface[];

  /**
   * Middleware that surfaces lazy claim debt on relevant page reads.
   */
  middleware: AnyAgentMiddleware[];
}

/**
 * Composes the complete agent-facing Claims integration in one place.
 *
 * @param runtime - Prepared run-scoped Claims state.
 * @param backend - Guarded backend used for page deletion.
 * @returns Claims tools and middleware for `createDeepAgent`.
 */
export function createClaimsIntegration(
  runtime: ClaimsRuntime,
  backend: ClaimsDeletionBackend,
  options: ClaimsIntegrationOptions = {},
): ClaimsIntegration {
  return {
    tools: [
      ...(options.includeReviewCompletion
        ? []
        : [createClaimsDeleteFileTool(runtime.session, backend)]),
      ...createClaimsTools(runtime.session),
      ...(options.includeReviewCompletion
        ? [createCompleteClaimsReviewTool(runtime.session)]
        : []),
    ],
    middleware: [createClaimsReadNoteMiddleware(runtime.session)],
  };
}
