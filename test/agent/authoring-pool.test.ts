import { describe, expect, test } from "vitest";
import { createOpenWikiAuthoringPoolMiddleware } from "../../src/agent/authoring-pool.ts";

/** Minimal stand-in for the subagent task tool the middleware dispatches through. */
function fakeTaskTool(
  respond: (description: string) => Promise<unknown>,
  record?: { inFlight: number; peak: number },
) {
  return {
    name: "task",
    invoke: async (input: unknown) => {
      const { description } = input as { description: string };
      if (record) {
        record.inFlight += 1;
        record.peak = Math.max(record.peak, record.inFlight);
      }
      try {
        return await respond(description);
      } finally {
        if (record) {
          record.inFlight -= 1;
        }
      }
    },
  };
}

/** Builds the middleware with a task tool injected the way the agent supplies it. */
function authorPagesWith(
  task: ReturnType<typeof fakeTaskTool>,
): (input: unknown) => Promise<Record<string, unknown>> {
  const middleware = createOpenWikiAuthoringPoolMiddleware();
  const tools = (middleware as { tools: { invoke: (i: unknown) => unknown }[] })
    .tools;
  const wrap = (
    middleware as {
      wrapModelCall: (
        request: unknown,
        handler: (request: unknown) => unknown,
      ) => unknown;
    }
  ).wrapModelCall;
  wrap({ tools: [task] }, (request) => request);
  return async (input: unknown) =>
    JSON.parse(String(await tools[0].invoke(input))) as Record<string, unknown>;
}

const report = (page: string, count: number) =>
  JSON.stringify({
    page,
    propositions: Array.from({ length: count }, (_, index) => ({
      statement: `fact ${index}`,
      evidence: ["repo://src/a.ts"],
    })),
    undocumented: [],
  });

describe("author_pages", () => {
  test("authors every assignment and totals their propositions", async () => {
    const authorPages = authorPagesWith(
      fakeTaskTool((description) => Promise.resolve(report(description, 3))),
    );
    const output = await authorPages({
      assignments: [
        { page: "a.md", brief: "a.md" },
        { page: "b.md", brief: "b.md" },
      ],
    });
    expect(output.authored).toBe(2);
    expect(output.propositionTotal).toBe(6);
    expect(output.failed).toEqual([]);
  });

  test("one author's failure costs its page, not the pool", async () => {
    const authorPages = authorPagesWith(
      fakeTaskTool((description) =>
        description === "b.md"
          ? Promise.reject(new Error("author died"))
          : Promise.resolve(report(description, 2)),
      ),
    );
    const output = await authorPages({
      assignments: [
        { page: "a.md", brief: "a.md" },
        { page: "b.md", brief: "b.md" },
        { page: "c.md", brief: "c.md" },
      ],
    });
    expect(output.authored).toBe(2);
    expect(output.failed).toHaveLength(1);
    expect((output.failed as { page: string }[])[0].page).toBe("b.md");
  });

  test("refills as authors settle instead of waiting for a batch", async () => {
    // The failure this replaces: a fixed slice of N waits for its slowest
    // member, so one slow author idles the rest of the slice. A pool should keep
    // the limit saturated while work remains.
    const record = { inFlight: 0, peak: 0 };
    const authorPages = authorPagesWith(
      fakeTaskTool(
        (description) =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve(report(description, 1)),
              description === "slow.md" ? 40 : 1,
            ),
          ),
        record,
      ),
    );
    const assignments = [
      { page: "slow.md", brief: "slow.md" },
      ...Array.from({ length: 8 }, (_, index) => ({
        page: `p${index}.md`,
        brief: `p${index}.md`,
      })),
    ];
    const output = await authorPages({ assignments, concurrency: 2 });
    expect(output.authored).toBe(9);
    // Never exceeds the limit, and the fast items flow through beside the slow one.
    expect(record.peak).toBeLessThanOrEqual(2);
  });

  test("never runs two authors for one page", async () => {
    const seen: string[] = [];
    const authorPages = authorPagesWith(
      fakeTaskTool((description) => {
        seen.push(description);
        return Promise.resolve(report(description, 1));
      }),
    );
    const output = await authorPages({
      assignments: [
        { page: "a.md", brief: "a.md" },
        { page: "a.md", brief: "a.md again" },
      ],
    });
    expect(seen).toEqual(["a.md"]);
    expect(output.duplicatePagesIgnored).toEqual(["a.md"]);
  });

  test("reports an author that returned no parseable report", async () => {
    const authorPages = authorPagesWith(
      fakeTaskTool(() => Promise.resolve("I could not find the evidence.")),
    );
    const output = await authorPages({
      assignments: [{ page: "a.md", brief: "a.md" }],
    });
    expect(output.authored).toBe(0);
    expect((output.failed as { error: string }[])[0].error).toContain(
      "no parseable report",
    );
  });

  test("establishes claims under an absolute wiki path", async () => {
    // The claim store throws unless the page starts with /openwiki/, and that
    // throw is recoverable, so a relative assignment path failed every page's
    // claims quietly while its Markdown wrote fine. A run saw claimsFailed on
    // all of them and re-authored the whole wiki to redo Claims.
    const pages: string[] = [];
    const session = {
      resolveClaims: (input: { page: string }) => {
        pages.push(input.page);
        return Promise.resolve({ page: input.page, results: [] });
      },
    } as unknown as Parameters<
      typeof createOpenWikiAuthoringPoolMiddleware
    >[0];
    const middleware = createOpenWikiAuthoringPoolMiddleware(session);
    const tools = (
      middleware as { tools: { invoke: (i: unknown) => Promise<unknown> }[] }
    ).tools;
    const task = {
      name: "task",
      invoke: () => Promise.resolve(report("a.md", 2)),
    };
    (
      middleware as {
        wrapModelCall: (r: unknown, h: (r: unknown) => unknown) => unknown;
      }
    ).wrapModelCall({ tools: [task] }, (r) => r);
    await tools[0].invoke({
      assignments: [{ page: "architecture/a.md", brief: "b" }],
    });
    expect(pages).toEqual(["/openwiki/architecture/a.md"]);
  });

  test("reads a report the author wrapped in prose", async () => {
    const authorPages = authorPagesWith(
      fakeTaskTool((description) =>
        Promise.resolve(`Here is the page.\n\n${report(description, 2)}\n`),
      ),
    );
    const output = await authorPages({
      assignments: [{ page: "a.md", brief: "a.md" }],
    });
    expect(output.authored).toBe(1);
    expect(output.propositionTotal).toBe(2);
  });
});
