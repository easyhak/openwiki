import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { discoverSharedContracts } from "../../src/agent/concept-discovery.js";

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "concepts-"));
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  }
  return root;
}

// Five manifests, so areas come from what the repository declares.
const MANIFESTS = {
  "api-go/go.mod": "module github.com/acme/api-go\n",
  "api-py/pyproject.toml": "[project]\nname='api_py'\n",
  "web/package.json": '{"name":"@acme/web"}\n',
  "worker/go.mod": "module github.com/acme/worker\n",
  "lib/pyproject.toml": "[project]\nname='lib'\n",
};

describe("shared contract discovery", () => {
  test("finds a table two areas write, and names both", async () => {
    const root = await repo({
      ...MANIFESTS,
      "api-py/schema.sql": "CREATE TABLE sessions (id uuid);\n",
      "api-go/write.go": 'db.Exec("INSERT INTO sessions (id) VALUES ($1)")\n',
      "api-py/write.py": 'cur.execute("insert into sessions (id) values (%s)")\n',
      "web/read.ts": 'const q = "select id from sessions where id = $1";\n',
      "api-py/tests/test_sessions.py": 'q = "select id from sessions"\n',
    });
    const found = await discoverSharedContracts(root);
    const table = found.find((c) => c.name === "sessions");
    expect(table).toBeDefined();
    expect(table?.kind).toBe("divided-state");
    expect(table?.writers).toEqual(["api-go", "api-py"]);
    expect(table?.consumers).toEqual(["web"]);
    // The test that exercises it travels with it: that is where a validation
    // answer comes from, and an author given only its own subtree never sees it.
    expect(table?.tests?.[0]).toContain("test_sessions.py");
  });

  test("ignores a table only one area touches", async () => {
    const root = await repo({
      ...MANIFESTS,
      "api-py/schema.sql": "CREATE TABLE private_notes (id uuid);\n",
      "api-py/write.py": 'cur.execute("insert into private_notes (id) values (%s)")\n',
      "api-py/read.py": 'cur.execute("select id from private_notes")\n',
    });
    const found = await discoverSharedContracts(root);
    expect(found.find((c) => c.name === "private_notes")).toBeUndefined();
  });

  test("only counts tables the schema declares", async () => {
    // Without a CREATE TABLE anywhere, `from x` in a Python import is not a table.
    const root = await repo({
      ...MANIFESTS,
      "api-py/app.py": "from typing import Any\nq = 'select 1 from typing'\n",
      "api-go/app.go": 'db.Exec("update typing set x = 1")\n',
    });
    const found = await discoverSharedContracts(root);
    expect(found.find((c) => c.name === "typing")).toBeUndefined();
  });

  test("a schema-qualified name does not yield an empty table", async () => {
    // "create table public." leaves an empty final segment, and an empty name
    // matches every unqualified table reference in the repository at once.
    const root = await repo({
      ...MANIFESTS,
      "api-py/schema.sql": "CREATE TABLE public. (id int);\n",
      "api-go/w.go": 'db.Exec("insert into whatever values (1)")\n',
      "api-py/r.py": 'cur.execute("select id from whatever")\n',
    });
    const found = await discoverSharedContracts(root);
    expect(found.every((c) => c.name.trim().length > 0)).toBe(true);
  });

  test("finds one route implemented in two languages", async () => {
    const root = await repo({
      ...MANIFESTS,
      "api-go/routes.go": 'r.Get("/v1/runs/stats", handler)\n',
      "api-py/routes.py": 'app.get("/v1/runs/stats")\n',
    });
    const found = await discoverSharedContracts(root);
    const route = found.find((c) => c.name === "/v1/runs/stats");
    expect(route?.kind).toBe("parallel-impl");
    expect(route?.signal).toBe("go+python");
    expect(route?.areas).toEqual(["api-go", "api-py"]);
  });

  test("resolves imports through declared module names, not file paths", async () => {
    const root = await repo({
      ...MANIFESTS,
      "worker/main.go": [
        'import (',
        '  "github.com/acme/api-go/store"',
        '  "github.com/acme/api-go/model"',
        '  "github.com/acme/api-go/queue"',
        ')',
      ].join("\n"),
    });
    const found = await discoverSharedContracts(root);
    const edge = found.find((c) => c.kind === "cross-area-import");
    expect(edge?.name).toBe("worker -> api-go");
    expect(edge?.signal).toBe("3 imports");
  });

  test("is deterministic and bounded", async () => {
    const root = await repo({
      ...MANIFESTS,
      "api-py/schema.sql": "CREATE TABLE runs (id int);\nCREATE TABLE feedback (id int);\n",
      "api-go/w.go": 'db.Exec("insert into runs values (1)"); db.Exec("insert into feedback values (1)")\n',
      "api-py/w.py": 'cur.execute("insert into runs values (1)")\ncur.execute("insert into feedback values (1)")\n',
      "web/r.ts": 'const x = "select id from runs"; const y = "select id from feedback";\n',
    });
    const first = await discoverSharedContracts(root);
    const second = await discoverSharedContracts(root);
    expect(second.map((c) => c.name)).toEqual(first.map((c) => c.name));
    expect((await discoverSharedContracts(root, { limit: 1 })).length).toBe(1);
  });
});
