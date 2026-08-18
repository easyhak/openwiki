/**
 * The init-only subtree surveyor.
 *
 * Planning was the coverage bottleneck, and it was structural rather than a
 * wording problem. One agent produced a ~31-page plan for a 17,444-file
 * monorepo; the critic then added 14 pages as RQ items, so a third of the
 * repository was missing from the first pass; and what survived collapsed 28
 * independently registered Go route families into a single domains page. Both
 * the planner and the critic were doing whole-repository comprehension inside
 * one context, from roughly 28 file reads each.
 *
 * A repository is a tree, so survey it as one: partition at the boundaries the
 * repository already declares - workspace manifests, packages, module roots -
 * dispatch one surveyor per subtree, and merge their returns into the plan. The
 * coordinator then reconciles a union of inventories rather than trying to hold
 * the whole repository at once, and coverage becomes a property of the
 * partition instead of a property of one agent's patience.
 *
 * Surveyors are read-only and never author. They return inventory, not prose:
 * what lives in the subtree, the evidence that establishes it, and how it
 * connects outward. The coordinator owns every page path, every relationship
 * edge that crosses subtrees, and the plan itself, because those are the parts
 * no single surveyor can see.
 */

import {
  createFilesystemMiddleware,
  type AnyBackendProtocol,
  type FsToolName,
  type SubAgent,
} from "deepagents";
import { z } from "zod";
import type { OpenWikiCommand, OpenWikiOutputMode } from "./types.js";

/** Read and search only: a surveyor inventories, it never authors. */
export const SURVEYOR_FILESYSTEM_TOOLS = [
  "read_file",
  "ls",
  "glob",
  "grep",
] as const satisfies readonly FsToolName[];

const SUBTREE_SURVEYOR_DESCRIPTION =
  "Surveys one subtree of the repository and returns its inventory units with evidence, outward relationships, and what it could not establish. Read-only. Dispatch these concurrently from eval, one per subtree, before planning pages.";

const SUBTREE_SURVEYOR_SYSTEM_PROMPT = `You survey exactly one subtree of a repository and report what is in it.

Your assignment names a subtree root and the boundaries of your scope. Nothing outside it is yours to survey; another surveyor owns each neighbouring subtree, and the coordinator owns the whole.

Hard constraints:
- Read and search only. Never create, edit, move, or delete any file, and never write documentation. You produce inventory, not prose.
- Stay inside your assigned subtree for inventory. You may read outside it only to resolve what one of your units connects to, and then only far enough to name that target.
- Never report a secret, credential, token, or .env value. Sample configuration with placeholders is fine.
- Do not invent units, symbols, or relationships. Everything you report must come from a file you inspected.

What counts as an inventory unit:
- A manifest-backed service, application, or package.
- An independently registered API or route family.
- An independently changeable data-model family, schema, or persistence boundary.
- A runtime subsystem with its own lifecycle, such as a worker, scheduler, queue consumer, or background job.
- A major workflow that runs through this subtree, even when it crosses outward.
Split rather than group. Two route families that deploy together are still two units if they can change independently; a single service overview is not a substitute for the domains inside it.

How to survey:
- Start from the subtree's manifests, entrypoints, and registration or composition surfaces to enumerate candidates, then inspect each candidate's primary implementation rather than stopping at its name.
- For each unit, follow at least one call or data path across a boundary in each direction, so its inbound and outbound relationships are evidence-backed rather than guessed.
- Read the focused tests closely enough to say what behaviour and invariants they prove.
- Prefer grep and targeted reads over reading large files whole.

Reporting:
- Return every unit you found, with the evidence paths and symbols that establish it, the focused tests that exercise it, and its outward relationships named as target concepts rather than page paths - you do not know what the coordinator will call those pages.
- Report anything you could not establish from evidence, and why. An honest gap is more useful than a confident guess, because the coordinator reconciles your total against the other subtrees.`;

/** What a surveyor must hand back. Inventory, evidence, and honest gaps. */
const SUBTREE_SURVEYOR_RESPONSE = z.object({
  subtree: z.string().describe("The subtree root you were assigned."),
  units: z
    .array(
      z.object({
        name: z.string().describe("Short, specific name for this unit."),
        kind: z
          .string()
          .describe(
            "service, package, route family, data-model family, runtime subsystem, or workflow.",
          ),
        summary: z
          .string()
          .describe("What it is responsible for, in one or two sentences."),
        evidence: z
          .array(z.string())
          .describe("repo://path or repo://path#symbol resources you inspected."),
        tests: z
          .array(z.string())
          .describe("Focused tests and what they prove."),
        relationships: z
          .array(z.string())
          .describe(
            "Outward connections as source -> relationship meaning -> target concept.",
          ),
      }),
    )
    .describe("Every inventory unit in this subtree."),
  unestablished: z
    .array(z.string())
    .describe("What you could not establish from evidence, and why."),
});

const SUBTREE_SURVEYOR_SUBAGENT: SubAgent = {
  name: "subtree-surveyor",
  description: SUBTREE_SURVEYOR_DESCRIPTION,
  systemPrompt: SUBTREE_SURVEYOR_SYSTEM_PROMPT,
  responseFormat: SUBTREE_SURVEYOR_RESPONSE,
};

/**
 * Returns the init-only subtree surveyor.
 *
 * @param command - Current OpenWiki command.
 * @param outputMode - Current output target.
 * @param backend - Shared wiki backend, whose ignore rules keep a surveyor away
 *   from paths the run is not allowed to inspect.
 * @returns The surveyor for repository init, otherwise no subagents.
 */
export function resolveSubtreeSurveyorSubagents(
  command: OpenWikiCommand,
  outputMode: OpenWikiOutputMode,
  backend: AnyBackendProtocol,
): SubAgent[] {
  if (command !== "init" || outputMode !== "repository") {
    return [];
  }

  return [
    {
      ...SUBTREE_SURVEYOR_SUBAGENT,
      middleware: [
        ...(SUBTREE_SURVEYOR_SUBAGENT.middleware ?? []),
        createFilesystemMiddleware({
          backend,
          tools: [...SURVEYOR_FILESYSTEM_TOOLS],
        }),
      ],
    },
  ];
}
