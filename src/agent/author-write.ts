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

const EstablishClaimsSchema = z.object({
  page: z.string().min(1).describe("The page path you were assigned."),
  claims: z
    .array(
      z.object({
        statement: z.string().min(1),
        evidence: z.array(EvidenceSchema).min(1),
      }),
    )
    .min(1),
});

const WritePageSchema = z.object({
  page: z.string().min(1).describe("The page path you were assigned."),
  markdown: z
    .string()
    .min(1)
    .describe("The complete page, including its front matter."),
});

/**
 * Resolves an author-supplied page path to the one form the claim store takes.
 *
 * @param page - Page path as the author wrote it.
 * @returns Absolute /openwiki path ending in .md.
 */
function canonicalPage(page: string): string {
  const bare = page
    .trim()
    .replace(/^\/+/u, "")
    .replace(/^openwiki\//u, "");
  const withExtension = /\.md$/iu.test(bare) ? bare : `${bare}.md`;
  return `/openwiki/${withExtension}`;
}

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
 * Creates the author's two-step write: claims, then prose.
 *
 * One atomic call made an author emit a 1,500-word page and forty claims with
 * evidence in a single completion, and the page lost. Measured on clean
 * single-draft runs: 1,142 mean words against 1,439 with a separate write, and
 * the share of the grader's required facts absent rose from 47% to 54% - every
 * claim role worse, including the two an author reads straight off its own
 * subtree, which denser grounding would not have touched.
 *
 * Splitting them keeps the invariant and drops the competition. establish_claims
 * takes the propositions; write_page refuses a page with no claims. Prose still
 * cannot exist ungrounded, because there is no call that writes it alone, and
 * each output gets a completion to itself. It also restores claim-first order:
 * derive the propositions, then write the page from them.
 *
 * @param session - Run-scoped claim state.
 * @param backend - Wiki filesystem backend.
 * @returns The two tools an author writes through.
 */
export function createAuthorWriteTools(
  session: ClaimSession,
  backend: PageWriteBackend,
) {
  const establishClaims = tool(
    async (rawInput) => {
      const input = EstablishClaimsSchema.parse(rawInput);
      const page = canonicalPage(input.page);
      const operations: ClaimOperation[] = input.claims.map((claim) => ({
        op: "add",
        statement: claim.statement,
        evidence: claim.evidence.map((resource) => ({
          resource: normalizeEvidence(resource),
        })),
      }));
      try {
        await session.resolveClaims({ page, operations });
      } catch (error) {
        return JSON.stringify({
          established: 0,
          error: error instanceof Error ? error.message : String(error),
          hint: "Nothing was established. Fix the resource this names - cite the symbol the file declares, or the file itself - and call again.",
        });
      }
      return JSON.stringify({
        page,
        established: session.inspectClaims(page).length,
      });
    },
    {
      name: "establish_claims",
      description:
        "Establish your page's material propositions, before writing it. Each is one concise atomic proposition with repo://path or repo://path#symbol evidence - no line ranges, no directories, and a symbol the file actually declares; cite the file when unsure. Call it in batches as you work rather than once at the end. write_page refuses a page with no claims, so this comes first.",
      schema: EstablishClaimsSchema,
    },
  );

  const writePage = tool(
    async (rawInput) => {
      const input = WritePageSchema.parse(rawInput);
      const page = canonicalPage(input.page);
      const established = session.inspectClaims(page).length;
      if (established === 0) {
        return JSON.stringify({
          written: false,
          error:
            "This page has no claims. Call establish_claims for it first: a page's prose has to be grounded in propositions, and nothing here writes ungrounded prose.",
        });
      }
      const result = await backend.write(page, input.markdown);
      return result.error
        ? JSON.stringify({ written: false, error: result.error })
        : JSON.stringify({ written: true, page, claims: established });
    },
    {
      name: "write_page",
      description:
        "Write your assigned page. It refuses a page with no established claims, so call establish_claims first and write the prose from those propositions. Pass the complete Markdown including its front matter.",
      schema: WritePageSchema,
    },
  );

  return [establishClaims, writePage];
}
