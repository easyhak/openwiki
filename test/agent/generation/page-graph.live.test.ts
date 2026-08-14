import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ClaimsStore } from "../../../src/claims/brains/code/store.ts";
import { RepositoryEvidenceResolver } from "../../../src/claims/evidence/repository/resolver.ts";
import { OpenWikiLocalShellBackend } from "../../../src/agent/docs-only-backend.ts";
import { createModel } from "../../../src/agent/index.ts";
import type { PageJob } from "../../../src/agent/generation/contracts.ts";
import { PageCommitter } from "../../../src/agent/generation/page-commit.ts";
import { createPageGraphRunner } from "../../../src/agent/generation/page-graph.ts";
import { PendingWorkStore } from "../../../src/agent/generation/pending-work-store.ts";
import { createGenerationSpecialists } from "../../../src/agent/generation/specialists.ts";
import type { OpenWikiProvider } from "../../../src/config/constants.ts";

describe.skipIf(process.env.OPENWIKI_LIVE_PAGE_GRAPH !== "1")(
  "standalone PageGraph (live)",
  () => {
    test(
      "researches and authors one isolated repository page",
      async () => {
        const rootDir = await mkdtemp(
          path.join(tmpdir(), "openwiki-page-graph-live-"),
        );
        try {
          await mkdir(path.join(rootDir, "src"), { recursive: true });
          await writeFile(
            path.join(rootDir, "src/runtime.ts"),
            `export function runRuntime(request: string): string {
  return \`processed: \${request}\`;
}
`,
            "utf8",
          );
          const job: PageJob = {
            id: "job_runtime_live",
            page: "/openwiki/architecture/runtime.md",
            operation: "create",
            reasons: ["live-vertical-slice"],
            sourceHints: ["src/runtime.ts#runRuntime"],
            wave: 0,
            priority: 500,
          };
          const claimsStore = new ClaimsStore(rootDir);
          const pending = new PendingWorkStore(rootDir);
          await pending.seedJobs([job]);
          const provider = (process.env.OPENWIKI_PROVIDER ??
            "anthropic") as OpenWikiProvider;
          const modelId = process.env.OPENWIKI_MODEL_ID ?? "claude-sonnet-5";
          const backend = new OpenWikiLocalShellBackend({
            rootDir,
            virtualMode: true,
            docsOnly: true,
          });
          const specialists = createGenerationSpecialists(
            createModel(provider, modelId, 0),
            backend,
          );
          const runner = createPageGraphRunner({
            rootDir,
            claimsStore,
            resolver: new RepositoryEvidenceResolver({ rootDir }),
            specialists,
            committer: new PageCommitter(rootDir, claimsStore, pending),
          });

          const result = await runner.run(job);

          expect(result).toMatchObject({
            page: job.page,
            status: "committed",
            reconcilerInvocations: 1,
            authorInvocations: 1,
          });
          const pageClaims = await claimsStore.loadPage(job.page);
          expect(pageClaims).not.toBeNull();
          expect(
            pageClaims?.claims.some((claim) =>
              /runRuntime|request/iu.test(claim.statement),
            ),
          ).toBe(true);
        } finally {
          await rm(rootDir, { force: true, recursive: true });
        }
      },
      15 * 60_000,
    );
  },
);
