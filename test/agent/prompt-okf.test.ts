import { describe, expect, test } from "vitest";
import { createSystemPrompt } from "../../src/agent/prompt.ts";

describe("createSystemPrompt OKF guidance", () => {
  test("keeps init requirements compact and update preservation explicit", () => {
    const init = createSystemPrompt("init", "repository");
    const update = createSystemPrompt("update", "repository");

    expect(init).toContain("Only `type` is required by OKF");
    // The optional OKF fields left init with the prompt trim: `timestamp` is
    // derivable and the formatter writes it, so spending init's budget on it
    // bought nothing. update still documents the full set.
    expect(update).toContain("timestamp: <Optional ISO 8601 datetime>");
    expect(init).toContain("index.md and log.md are reserved");
    expect(init).not.toContain(
      "Preserve all existing producer-defined front matter fields",
    );
    expect(update).toContain(
      "Preserve all existing producer-defined front matter fields",
    );
    expect(update).toContain(
      "`index.md` and `log.md` are reserved OKF documents",
    );
    expect(init).not.toContain("Required fields are: `title`");
    expect(init).not.toContain(
      "do not add front matter fields outside the formatter above",
    );
  });
});
