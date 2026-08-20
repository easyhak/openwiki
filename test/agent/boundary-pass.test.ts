import { describe, expect, test } from "vitest";
import { createOpenWikiBoundaryMiddleware } from "../../src/agent/boundary-pass.ts";
import { createPlanStore, type PlannedPage } from "../../src/agent/plan-store.ts";

function storeWith(
  pages: { path: string; edges: { page: string; relationship: string }[] }[],
) {
  const store = createPlanStore();
  const map = new Map<string, PlannedPage>();
  for (const p of pages) {
    map.set(p.path.replace(/^\/+/u, ""), {
      path: p.path,
      responsibility: "r",
      entrypoint: "e",
      sources: ["s"],
      tests: ["t"],
      edges: p.edges,
    });
  }
  store.set({ entries: [], pages: map });
  return store;
}

function wire(store: ReturnType<typeof createPlanStore>) {
  const middleware = createOpenWikiBoundaryMiddleware(store);
  const briefs: string[] = [];
  const tools = (
    middleware as { tools: { invoke: (i: unknown) => Promise<unknown> }[] }
  ).tools;
  (
    middleware as {
      wrapModelCall: (r: unknown, h: (r: unknown) => unknown) => unknown;
    }
  ).wrapModelCall(
    {
      tools: [
        {
          name: "task",
          invoke: (input: unknown) => {
            briefs.push((input as { description: string }).description);
            return Promise.resolve("done");
          },
        },
      ],
    },
    (r) => r,
  );
  return {
    briefs,
    run: async () =>
      JSON.parse(String(await tools[0].invoke({}))) as Record<string, unknown>,
  };
}

describe("reconcile_boundaries", () => {
  test("reviews each page against the pages it relates to", async () => {
    // No author can do this: its neighbours are half-written while it works and
    // it is told not to read them, so a fact about the pair has no writer.
    const h = wire(
      storeWith([
        {
          path: "openwiki/api.md",
          edges: [{ page: "openwiki/db.md", relationship: "writes runs" }],
        },
        { path: "openwiki/db.md", edges: [] },
      ]),
    );
    const out = await h.run();
    expect(out.reconciled).toBe(1);
    expect(out.pagesWithoutEdges).toBe(1);
    expect(h.briefs[0]).toContain("/openwiki/api.md");
    expect(h.briefs[0]).toContain("/openwiki/db.md - writes runs");
    expect(h.briefs[0]).toContain("in which direction");
  });

  test("does nothing without a plan", async () => {
    const h = wire(createPlanStore());
    expect((await h.run()).reconciled).toBe(0);
  });
});
