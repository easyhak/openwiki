import { describe, expect, test } from "vitest";
import { createOpenWikiAuthoringPoolMiddleware } from "../../src/agent/authoring-pool.ts";

/** Claim session stub: records what each page established. */
function stubSession(claimsByPage: Record<string, number> = {}) {
  return {
    inspectClaims: (page: string) =>
      Array.from({ length: claimsByPage[page] ?? 0 }, (_, i) => ({ id: `c${i}` })),
  } as unknown as Parameters<typeof createOpenWikiAuthoringPoolMiddleware>[0];
}

/** Wires the middleware to a scripted task tool, as the agent supplies it. */
function authorPagesWith(
  respond: (description: string) => Promise<unknown>,
  session?: Parameters<typeof createOpenWikiAuthoringPoolMiddleware>[0],
  record?: { inFlight: number; peak: number },
) {
  const middleware = createOpenWikiAuthoringPoolMiddleware(session);
  const seen: string[] = [];
  const task = {
    name: "task",
    invoke: async (input: unknown) => {
      const { description } = input as { description: string };
      seen.push(description);
      if (record) {
        record.inFlight += 1;
        record.peak = Math.max(record.peak, record.inFlight);
      }
      try {
        return await respond(description);
      } finally {
        if (record) record.inFlight -= 1;
      }
    },
  };
  const tools = (
    middleware as { tools: { invoke: (i: unknown) => Promise<unknown> }[] }
  ).tools;
  (
    middleware as {
      wrapModelCall: (r: unknown, h: (r: unknown) => unknown) => unknown;
    }
  ).wrapModelCall({ tools: [task] }, (r) => r);
  return {
    seen,
    run: async (input: unknown) =>
      JSON.parse(String(await tools[0].invoke(input))) as Record<
        string,
        unknown
      >,
  };
}

const ok = () => Promise.resolve("Wrote the page and established its claims.");

describe("author_pages", () => {
  test("counts claims from the store, not from what the author says", async () => {
    // Asking the author to report its own count put the same payload through
    // the same seam under a different name. A report can disagree with the
    // store; the store cannot disagree with itself.
    const h = authorPagesWith(
      ok,
      stubSession({ "/openwiki/a.md": 41, "/openwiki/b.md": 12 }),
    );
    const out = await h.run({
      assignments: [
        { page: "a.md", brief: "a" },
        { page: "openwiki/b.md", brief: "b" },
      ],
    });
    expect(out.authored).toBe(2);
    expect(out.claimsEstablished).toBe(53);
    expect(out.pagesWithNoClaims).toEqual([]);
  });

  test("surfaces a page that wrote prose it never grounded", async () => {
    const h = authorPagesWith(ok, stubSession({ "/openwiki/a.md": 30 }));
    const out = await h.run({
      assignments: [
        { page: "a.md", brief: "a" },
        { page: "b.md", brief: "b" },
      ],
    });
    expect(out.claimsEstablished).toBe(30);
    expect(out.pagesWithNoClaims).toEqual(["/openwiki/b.md"]);
  });

  test("one author's failure costs its page, not the pool", async () => {
    const h = authorPagesWith(
      (d) =>
        d === "b" ? Promise.reject(new Error("author died")) : ok(),
      stubSession({ "/openwiki/a.md": 5, "/openwiki/c.md": 5 }),
    );
    const out = await h.run({
      assignments: [
        { page: "a.md", brief: "a" },
        { page: "b.md", brief: "b" },
        { page: "c.md", brief: "c" },
      ],
    });
    expect(out.authored).toBe(2);
    expect((out.failed as { page: string }[])[0].page).toBe("/openwiki/b.md");
  });

  test("refills as authors settle instead of waiting for a batch", async () => {
    // A fixed slice waits for its slowest member; a pool keeps the limit
    // saturated while work remains.
    const record = { inFlight: 0, peak: 0 };
    const h = authorPagesWith(
      (d) =>
        new Promise((resolve) =>
          setTimeout(() => resolve("done"), d === "slow" ? 40 : 1),
        ),
      stubSession(),
      record,
    );
    const out = await h.run({
      assignments: [
        { page: "slow.md", brief: "slow" },
        ...Array.from({ length: 8 }, (_, i) => ({
          page: `p${i}.md`,
          brief: `p${i}`,
        })),
      ],
      concurrency: 2,
    });
    expect(out.authored).toBe(9);
    expect(record.peak).toBeLessThanOrEqual(2);
  });

  test("never runs two authors for one page", async () => {
    // Two authors on one page race on write_file and the loser's work is gone.
    const h = authorPagesWith(ok, stubSession());
    const out = await h.run({
      assignments: [
        { page: "a.md", brief: "first" },
        { page: "a.md", brief: "again" },
      ],
    });
    expect(h.seen).toEqual(["first"]);
    expect(out.duplicatePagesIgnored).toEqual(["a.md"]);
  });
});
