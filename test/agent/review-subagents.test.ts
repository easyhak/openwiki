import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createDeepAgent } from "deepagents";
import { describe, expect, test } from "vitest";
import { resolveSkeletonCriticSubagents } from "../../src/agent/skeleton-critic.ts";
import { resolveWikiQaSubagents } from "../../src/agent/wiki-qa-subagents.ts";

describe("repository review subagents", () => {
  test("enables all reviewers only for repository init", () => {
    expect(
      [
        ...resolveSkeletonCriticSubagents("init", "repository"),
        ...resolveWikiQaSubagents("init", "repository"),
      ].map((subagent) => subagent.name),
    ).toEqual([
      "skeleton-critic",
      "wiki-question-finder",
      "wiki-answer-verifier",
    ]);

    for (const [command, mode] of [
      ["update", "repository"],
      ["chat", "repository"],
      ["init", "local-wiki"],
    ] as const) {
      expect(resolveSkeletonCriticSubagents(command, mode)).toEqual([]);
      expect(resolveWikiQaSubagents(command, mode)).toEqual([]);
    }
  });

  test("makes reviewers read-only and keeps Claims and Markdown with the parent", () => {
    const reviewers = [
      ...resolveSkeletonCriticSubagents("init", "repository"),
      ...resolveWikiQaSubagents("init", "repository"),
    ];

    expect(reviewers.every((reviewer) => !reviewer.name.includes("_"))).toBe(
      true,
    );
    for (const reviewer of reviewers) {
      expect(reviewer.permissions).toEqual([
        { operations: ["write"], paths: ["/**"], mode: "deny" },
      ]);
      expect(reviewer.systemPrompt).toContain("read-only");
      expect(reviewer.systemPrompt).toContain("parent agent");
    }

    expect(reviewers[0]?.systemPrompt).toContain("/openwiki/_plan.md");
    expect(reviewers[0]?.systemPrompt).not.toContain("_skeleton.md");
  });

  test("constructs a real DeepAgents graph with hyphenated reviewer names", () => {
    const reviewers = [
      ...resolveSkeletonCriticSubagents("init", "repository"),
      ...resolveWikiQaSubagents("init", "repository"),
    ];

    expect(() =>
      createDeepAgent({
        model: new FakeListChatModel({ responses: ["done"] }),
        subagents: reviewers,
      }),
    ).not.toThrow();
  });
});
