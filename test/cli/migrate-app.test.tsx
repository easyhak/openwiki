import React from "react";
import { render } from "ink-testing-library";
import { afterEach, expect, test, vi } from "vitest";
import { MigrateApp } from "../../src/cli/migrate-app.tsx";
import { runClaimsMigration } from "../../src/migrations/claims.ts";
import { stripAnsi as plain } from "./components/ansi.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

async function waitForFrame(
  lastFrame: () => string | undefined,
  text: string,
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const frame = plain(lastFrame());
    if (frame.includes(text)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return plain(lastFrame());
}

test("selects, confirms, and reports a completed Claims migration", async () => {
  const inspect = vi.fn().mockResolvedValue({
    completedPages: ["/openwiki/existing.md"],
    pendingPages: ["/openwiki/pending.md"],
    totalPages: 2,
  });
  const run = vi.fn<typeof runClaimsMigration>((_cwd, options) => {
    options.onEvent?.({
      type: "page_start",
      index: 1,
      page: "/openwiki/pending.md",
      total: 1,
    });
    options.onEvent?.({
      type: "page_complete",
      page: "/openwiki/pending.md",
      claimCount: 3,
      pageUpdated: false,
    });
    return Promise.resolve({
      completed: [
        {
          page: "/openwiki/pending.md",
          claimCount: 3,
          pageUpdated: false,
        },
      ],
      remainingPages: [],
    });
  });
  const view = render(<MigrateApp cwd="/repo" inspect={inspect} run={run} />);

  expect(await waitForFrame(view.lastFrame, "[x] Claims")).toContain(
    "[x] Claims",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write("\r");
  expect(await waitForFrame(view.lastFrame, "Continue? [y/N]")).toContain(
    "analyze 1 wiki page",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write("y");

  const completed = await waitForFrame(
    view.lastFrame,
    "Claims migration complete",
  );
  expect(completed).toContain("1 page migrated");
  expect(completed).toContain("3 claims persisted");
  expect(run).toHaveBeenCalledTimes(1);
});

test("lists every pending page and shows live activity for the current page", async () => {
  const inspect = vi.fn().mockResolvedValue({
    completedPages: [],
    pendingPages: [
      "/openwiki/agent/workflow.md",
      "/openwiki/architecture/overview.md",
      "/openwiki/operations/updates.md",
    ],
    totalPages: 3,
  });
  const run = vi.fn<typeof runClaimsMigration>((_cwd, options) => {
    options.onEvent?.({
      type: "page_start",
      index: 1,
      page: "/openwiki/agent/workflow.md",
      total: 3,
    });
    options.onEvent?.({
      type: "activity",
      page: "/openwiki/agent/workflow.md",
      message: "Reading source evidence",
    });
    return new Promise(() => undefined);
  });
  const view = render(<MigrateApp cwd="/repo" inspect={inspect} run={run} />);

  await waitForFrame(view.lastFrame, "[x] Claims");
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write("\r");
  await waitForFrame(view.lastFrame, "Continue? [y/N]");
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.stdin.write("y");

  const running = await waitForFrame(view.lastFrame, "Reading source evidence");
  expect(running).toContain("Pending (3)");
  expect(running).toContain("agent/workflow.md");
  expect(running).toContain("architecture/overview.md");
  expect(running).toContain("operations/updates.md");
  expect(running).toContain(
    "0:00 elapsed · last activity: Reading source evidence",
  );

  view.unmount();
});
