/**
 * Atomic page write: prose and Claims, or neither.
 *
 * Every arrangement that let these two happen separately has failed. Authors
 * returned propositions for the coordinator to establish, and the payload
 * overflowed a tool result, the page path was spelled two ways, and one
 * unresolvable symbol atomically discarded a page's whole claim set. Then
 * authors were given resolve_claims and told to call it, and a graded run wrote
 * 68 pages, established zero claims, and put `Evidence: repo://...` in the
 * Markdown instead - the tool was on the surface and simply never called.
 *
 * Exposure is not enforcement. So writing a page and grounding it become one
 * operation that cannot half-succeed: claims resolve first, and the Markdown is
 * written only if they did. An author cannot produce ungrounded prose because
 * there is no call that does it.
 *
 * The failure is loud in both directions. Evidence the resolver refuses returns
 * the resource it refused with nothing written, so the author - which is holding
 * the file - fixes the anchor and calls again. And a page that never called this
 * at all has no prose, which the pool sees as an author that did nothing rather
 * than as a page that needs re-authoring.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { ClaimSession } from "../claims/brains/code/session.js";
import type { ClaimOperation } from "../claims/core/types.js";

/** Backend capability this needs: one page write. */
interface PageWriteBackend {
  write(
    filePath: string,
    content: string,
  ): { error?: string } | Promise<{ error?: string }>;
}

const EvidenceSchema = z
  .string()
  .min(1)
  .describe("repo://path or repo://path#symbol");

const WriteClaimedPageSchema = z.object({
  page: z.string().min(1).describe("The page path you were assigned."),
  markdown: z
    .string()
    .min(1)
    .describe("The complete page, including its front matter."),
  claims: z
    .array(
      z.object({
        statement: z.string().min(1),
        evidence: z.array(EvidenceSchema).min(1),
      }),
    )
    .min(1)
    .describe("Every material proposition the page states."),
});

/**
 * Normalizes an author-supplied evidence resource.
 *
 * Line ranges, triple slashes, and trailing slashes are syntax the resolver
 * rejects and the author did not mean, so they are corrected rather than
 * bounced: 15 of 66 claim failures in one run were exactly these.
 *
 * @param resource - Resource as written.
 * @returns Normalized resource.
 */
export function normalizeEvidence(resource: string): string {
  return resource
    .trim()
    .replace(/^repo:\/{3,}/u, "repo://")
    .replace(/#L\d+(?:-L?\d+)?$/u, "")
    .replace(/\/+$/u, "");
}

/**
 * Creates the atomic write tool for page authors.
 *
 * @param session - Run-scoped claim state.
 * @param backend - Wiki filesystem backend.
 * @returns The `write_claimed_page` tool.
 */
export function createWriteClaimedPageTool(
  session: ClaimSession,
  backend: PageWriteBackend,
) {
  return tool(
    async (rawInput) => {
      const input = WriteClaimedPageSchema.parse(rawInput);
      const page = `/${input.page.replace(/^\/+/u, "").replace(/^openwiki\//u, "openwiki/")}`;
      const absolute = page.startsWith("/openwiki/")
        ? page
        : `/openwiki/${page.replace(/^\/+/u, "")}`;

      const operations: ClaimOperation[] = input.claims.map((claim) => ({
        op: "add",
        statement: claim.statement,
        evidence: claim.evidence.map((resource) => ({
          resource: normalizeEvidence(resource),
        })),
      }));

      // Claims first: prose written before them could survive their failure,
      // which is the divergence this exists to make impossible.
      try {
        await session.resolveClaims({ page: absolute, operations });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({
          written: false,
          claimsEstablished: 0,
          error: message,
          hint: "Nothing was written. Fix the evidence this names - cite the symbol the file declares, or the file itself - and call again with the same markdown.",
        });
      }

      const result = await backend.write(absolute, input.markdown);
      if (result.error) {
        return JSON.stringify({
          written: false,
          claimsEstablished: operations.length,
          error: result.error,
        });
      }
      return JSON.stringify({
        written: true,
        page: absolute,
        claimsEstablished: session.inspectClaims(absolute).length,
      });
    },
    {
      name: "write_claimed_page",
      description:
        "Write your assigned page and establish its Claims in one operation. This is the only way to create your page: there is no separate write. Pass the complete Markdown and every material proposition it states, each with repo://path or repo://path#symbol evidence. Claims resolve first and the page is written only if they do, so a rejected resource means nothing was written - fix that one anchor, citing the file if a symbol will not resolve, and call again with the same markdown.",
      schema: WriteClaimedPageSchema,
    },
  );
}
