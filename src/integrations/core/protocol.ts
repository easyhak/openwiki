import { z } from "zod";
import {
  InspectClaimsInputSchema as ClaimsInspectPayloadInput,
  ResolveClaimsInputSchema as ClaimsResolvePayloadInput,
} from "../../claims/brains/code/tools.js";

const HOST_ID_PATTERN = /^[a-z0-9-]{1,64}$/u;

/**
 * Lifecycle modes supported by host-authored repository runs.
 */
export type HostRunMode = "init" | "update";

/**
 * Stable names in the complete host integration tool set.
 */
export type ProtocolToolName =
  | "openwiki_context"
  | "openwiki_begin"
  | "openwiki_inspect_claims"
  | "openwiki_resolve_claims"
  | "openwiki_finish";

/**
 * Validated request accepted by `openwiki_begin`.
 */
export interface BeginRequest {
  /**
   * Absolute path inside the Git repository to document.
   */
  root: string;

  /**
   * Lifecycle mode selected for the run.
   */
  mode: HostRunMode;

  /**
   * Optional requested BCP-47 wiki language.
   *
   * @default undefined - inherit the prior language or use English.
   */
  language?: string;
}

/**
 * Validated run selector accepted by `openwiki_finish`.
 */
export interface RunRequest {
  /**
   * Opaque identifier returned by the matching begin request.
   */
  runId: string;
}

/**
 * Validated task-oriented context request.
 */
export interface ContextRequest {
  /**
   * Absolute path inside the Git repository to query.
   */
  root: string;

  /**
   * Exact coding task supplied by the host.
   */
  task: string;

  /**
   * Optional follow-up question or subsystem focus.
   */
  focus?: string;

  /**
   * Optional repository-relative paths already known to be changing.
   */
  changedPaths?: string[];

  /**
   * Maximum number of behavior contracts to return.
   *
   * @default 8
   */
  maxContracts: number;

  /**
   * Approximate maximum serialized response characters.
   *
   * @default 12000
   */
  maxChars: number;

  /**
   * Whether strong direct matches may add one-hop related contracts.
   *
   * @default true
   */
  includeRelationships: boolean;
}

/**
 * Validated input accepted by `openwiki_begin`.
 */
export const BeginInput: z.ZodType<BeginRequest> = z
  .object({
    root: z.string().trim().min(1),
    mode: z.enum(["init", "update"]),
    language: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * Validated run selector accepted by `openwiki_finish`.
 */
export const RunInput: z.ZodType<RunRequest> = z
  .object({
    runId: z.string().uuid(),
  })
  .strict();

const RepositoryRelativePath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !/^[A-Za-z]:[\\/]/u.test(value) &&
      !value.split(/[\\/]/u).includes("..") &&
      !value.includes("\0"),
    "Changed paths must be safe repository-relative paths",
  );

/**
 * Validated input accepted by `openwiki_context`.
 */
export const ContextInput: z.ZodType<ContextRequest> = z
  .object({
    root: z.string().trim().min(1),
    task: z.string().trim().min(1).max(4_000),
    focus: z.string().trim().min(1).max(2_000).optional(),
    changedPaths: z.array(RepositoryRelativePath).max(50).optional(),
    maxContracts: z.number().int().min(1).max(20).default(8),
    maxChars: z.number().int().min(4_000).max(30_000).default(12_000),
    includeRelationships: z.boolean().default(true),
  })
  .strict();

/**
 * Validated request accepted by `openwiki_inspect_claims`.
 */
export const InspectClaimsInput = z
  .object({
    runId: z.string().uuid(),
    ...ClaimsInspectPayloadInput.shape,
  })
  .strict()
  .refine(({ ids, pages }) => (ids === undefined) !== (pages === undefined), {
    message: "Pass exactly one of ids or pages",
  });

/**
 * Validated request accepted by `openwiki_resolve_claims`.
 */
export const ResolveClaimsInput = z
  .object({
    runId: z.string().uuid(),
    ...ClaimsResolvePayloadInput.shape,
  })
  .strict();

/**
 * Strict host Claims inspection request inferred from the shared schema.
 */
export type InspectClaimsRequest = z.infer<typeof InspectClaimsInput>;

/**
 * Strict host Claims mutation request inferred from the shared schema.
 */
export type ResolveClaimsRequest = z.infer<typeof ResolveClaimsInput>;

/**
 * Validates the bounded identifier used for host metadata and provenance.
 *
 * @param value - Candidate host identifier.
 * @returns Whether the identifier is safe and protocol-compatible.
 */
export function isValidHostId(value: string): boolean {
  return HOST_ID_PATTERN.test(value);
}

/**
 * Transport-neutral tool exposed by the host lifecycle core.
 */
export interface ProtocolTool {
  /**
   * Stable transport-visible tool name.
   */
  name: ProtocolToolName;

  /**
   * Human-readable model guidance for the tool.
   */
  description: string;

  /**
   * Runtime input validator and JSON Schema source.
   */
  schema: z.ZodType;

  /**
   * Executes the validated transport-neutral operation.
   *
   * @param input - Untrusted candidate input to validate at the boundary.
   * @returns Structured JSON-compatible operation result.
   */
  handle(input: unknown): Promise<unknown>;
}
