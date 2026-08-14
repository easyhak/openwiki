import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  collectGitDelta,
  GitDeltaCollectionError,
} from "../../../src/agent/generation/git-delta.ts";
import { OpenWikiIgnore } from "../../../src/agent/openwiki-ignore.ts";

const execFileAsync = promisify(execFile);

describe("collectGitDelta", () => {
  let rootDir: string;
  let initialHead: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-git-delta-"));
    await git("init", "--initial-branch=main");
    await write(
      ".gitignore",
      ".env\n.env.*\n*.pem\n*.key\n*.crt\ncredentials.json\nnode_modules/\n.DS_Store\n",
    );
    await write("src/original.ts", "export const original = true;\n");
    await write("src/modified.ts", "export const version = 1;\n");
    await write("src/deleted.ts", "export const removed = true;\n");
    await write("src/ leading.ts", "export const leading = true;\n");
    await write("ignored/private.ts", "export const privateValue = true;\n");
    await write("openwiki/generated.md", "# Generated\n");
    await stageAndCommit("initial fixture");
    initialHead = await head();
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  test("parses committed, worktree, rename, whitespace, and newline paths", async () => {
    await rename(
      path.join(rootDir, "src/original.ts"),
      path.join(rootDir, "src/renamed -> file.ts"),
    );
    await write("src/modified.ts", "export const version = 2;\n");
    await rm(path.join(rootDir, "src/deleted.ts"));
    await write("src/line\nbreak.ts", "export const newline = true;\n");
    await write("ignored/private.ts", "changed but ignored\n");
    await write("openwiki/generated.md", "# Changed but owned\n");
    await stageAndCommit("current fixture");
    await write("src/modified.ts", "export const version = 3;\n");
    await write("src/work tree.ts", "export const dirty = true;\n");

    const delta = await collectGitDelta(
      rootDir,
      initialHead,
      new OpenWikiIgnore(["ignored/"]),
    );

    expect(delta.mode).toBe("incremental");
    expect(delta.changes).toEqual(
      expect.arrayContaining([
        { status: "D", path: "src/deleted.ts" },
        { status: "A", path: "src/line\nbreak.ts" },
        { status: "M", path: "src/modified.ts" },
        {
          status: "R",
          previousPath: "src/original.ts",
          path: "src/renamed -> file.ts",
        },
        { status: "?", path: "src/work tree.ts" },
      ]),
    );
    expect(
      delta.changes.filter((change) => change.path === "src/modified.ts"),
    ).toHaveLength(1);
    expect(
      delta.changes.some((change) => change.path === "src/ leading.ts"),
    ).toBe(false);
    expect(
      delta.changes.some(
        (change) =>
          change.path.startsWith("openwiki/") ||
          change.path.startsWith("ignored/"),
      ),
    ).toBe(false);
  });

  test("preserves a staged worktree rename without arrow parsing", async () => {
    await rename(
      path.join(rootDir, "src/original.ts"),
      path.join(rootDir, "src/status -> rename.ts"),
    );
    await stageAll();

    const delta = await collectGitDelta(
      rootDir,
      initialHead,
      new OpenWikiIgnore([]),
    );

    expect(delta.changes).toContainEqual({
      status: "R",
      previousPath: "src/original.ts",
      path: "src/status -> rename.ts",
    });
  });

  test("uses the current worktree column for a staged-then-deleted path", async () => {
    await write("src/modified.ts", "export const version = 2;\n");
    await stageAll();
    await rm(path.join(rootDir, "src/modified.ts"));

    const delta = await collectGitDelta(
      rootDir,
      initialHead,
      new OpenWikiIgnore([]),
    );

    expect(delta.changes).toContainEqual({
      status: "D",
      path: "src/modified.ts",
    });
  });

  test("falls back to one deduplicated full inventory for a missing base", async () => {
    await write("src/untracked.ts", "export const untracked = true;\n");

    const delta = await collectGitDelta(
      rootDir,
      "0000000000000000000000000000000000000000",
      new OpenWikiIgnore(["ignored/"]),
    );

    expect(delta.mode).toBe("full-scan");
    expect(delta.changes).toContainEqual({
      status: "A",
      path: "src/ leading.ts",
    });
    expect(delta.changes).toContainEqual({
      status: "A",
      path: "src/untracked.ts",
    });
    expect(
      delta.changes.filter((change) => change.path === "src/untracked.ts"),
    ).toHaveLength(1);
    expect(
      delta.changes.some(
        (change) =>
          change.path.startsWith("openwiki/") ||
          change.path.startsWith("ignored/"),
      ),
    ).toBe(false);
  });

  test("fails closed when the directory is not a Git repository", async () => {
    const notRepository = await mkdtemp(
      path.join(tmpdir(), "openwiki-not-git-"),
    );
    try {
      await expect(
        collectGitDelta(notRepository, undefined, new OpenWikiIgnore([])),
      ).rejects.toBeInstanceOf(GitDeltaCollectionError);
    } finally {
      await rm(notRepository, { force: true, recursive: true });
    }
  });

  /**
   * Writes one repository fixture, creating its parent directory.
   */
  async function write(relativePath: string, content: string): Promise<void> {
    const absolute = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }

  /**
   * Runs one Git fixture command with fixed local author identity.
   */
  async function git(...args: string[]): Promise<string> {
    const result = await execFileAsync(
      "git",
      [
        "-c",
        "user.name=OpenWiki Test",
        "-c",
        "user.email=openwiki-test@example.invalid",
        ...args,
      ],
      { cwd: rootDir },
    );
    return result.stdout.trim();
  }

  /**
   * Stages the isolated fixture and verifies no secret-like file was selected.
   */
  async function stageAll(): Promise<void> {
    await git("add", "--all");
    const staged = await git("diff", "--cached", "--name-only", "-z");
    const secretPath = staged
      .split("\0")
      .find((file) =>
        /(?:^|\/)(?:\.env(?:\..*)?|credentials\.json)$|\.(?:pem|key|crt)$/iu.test(
          file,
        ),
      );
    if (secretPath) {
      throw new Error(`Unsafe secret-like fixture path staged: ${secretPath}`);
    }
  }

  /**
   * Creates one isolated fixture commit after the staging safety check.
   */
  async function stageAndCommit(message: string): Promise<void> {
    await stageAll();
    await git("commit", "--quiet", "-m", message);
  }

  /**
   * Returns the current fixture commit.
   */
  async function head(): Promise<string> {
    return git("rev-parse", "HEAD");
  }
});
