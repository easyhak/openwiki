import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AtomicRepositoryFiles,
  GenerationPersistenceError,
} from "../../../src/agent/generation/atomic-files.ts";

describe("AtomicRepositoryFiles", () => {
  let rootDir: string;
  let cleanupDirectories: string[];

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-atomic-files-"));
    cleanupDirectories = [rootDir];
  });

  afterEach(async () => {
    await Promise.all(
      cleanupDirectories.map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  test("round-trips root and nested files and removes idempotently", async () => {
    const files = new AtomicRepositoryFiles(rootDir);

    await files.replaceText("root.txt", "root\n");
    await files.replaceText("nested/page.md", "# Page\n");

    await expect(files.readText("root.txt")).resolves.toBe("root\n");
    await expect(files.readText("nested/page.md")).resolves.toBe("# Page\n");
    await files.remove("root.txt");
    await files.remove("root.txt");
    await expect(files.readText("root.txt")).resolves.toBeNull();
  });

  test.each(["", ".", "..", "../outside", "nested/../outside"])(
    "rejects unsafe relative path %j",
    async (relativePath) => {
      const files = new AtomicRepositoryFiles(rootDir);

      await expect(files.replaceText(relativePath, "unsafe")).rejects.toThrow(
        GenerationPersistenceError,
      );
      await expect(files.readText(relativePath)).rejects.toThrow(
        GenerationPersistenceError,
      );
      await expect(files.remove(relativePath)).rejects.toThrow(
        GenerationPersistenceError,
      );
    },
  );

  test("rejects absolute paths and relative repository roots", async () => {
    const files = new AtomicRepositoryFiles(rootDir);

    await expect(
      files.replaceText(path.join(rootDir, "absolute.txt"), "unsafe"),
    ).rejects.toThrow(GenerationPersistenceError);
    expect(() => new AtomicRepositoryFiles("relative/repository")).toThrow(
      GenerationPersistenceError,
    );
  });

  test("rejects symlinked files and parent directories", async () => {
    const outside = await mkdtemp(
      path.join(tmpdir(), "openwiki-atomic-outside-"),
    );
    cleanupDirectories.push(outside);
    await writeFile(path.join(outside, "outside.txt"), "outside\n", "utf8");
    await symlink(
      path.join(outside, "outside.txt"),
      path.join(rootDir, "linked.txt"),
    );
    await symlink(outside, path.join(rootDir, "linked-directory"), "dir");
    const files = new AtomicRepositoryFiles(rootDir);

    await expect(files.readText("linked.txt")).rejects.toThrow(
      GenerationPersistenceError,
    );
    await expect(files.remove("linked.txt")).rejects.toThrow(
      GenerationPersistenceError,
    );
    await expect(
      files.replaceText("linked-directory/new.txt", "unsafe"),
    ).rejects.toThrow(GenerationPersistenceError);
    await expect(readdir(outside)).resolves.toEqual(["outside.txt"]);
  });

  test("cleans the temporary file when atomic publication fails", async () => {
    const publicationFailure = new Error("rename unavailable");
    const files = new AtomicRepositoryFiles(rootDir, {
      rename: () => Promise.reject(publicationFailure),
    });

    await expect(files.replaceText("page.md", "# Page\n")).rejects.toBe(
      publicationFailure,
    );
    await expect(readdir(rootDir)).resolves.toEqual([]);
    await expect(
      readFile(path.join(rootDir, "page.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects an existing directory as a file target", async () => {
    await mkdir(path.join(rootDir, "page.md"));
    const files = new AtomicRepositoryFiles(rootDir);

    await expect(files.replaceText("page.md", "# Page\n")).rejects.toThrow(
      GenerationPersistenceError,
    );
  });
});
