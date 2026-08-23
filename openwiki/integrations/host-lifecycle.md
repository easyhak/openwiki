---
type: Agent integration guide
title: Host-authored lifecycle and MCP boundary
description: Protocol tools, repository validation, serialized sessions, transactional init, retryable finish, and transport errors.
tags: [integration, mcp, lifecycle, rollback, retry]
---

# Host-authored lifecycle and MCP boundary

The coding-agent integration keeps deterministic repository setup and
finalization inside OpenWiki while delegating investigation and Markdown edits
to the host agent. MCP is a transport adapter over a transport-neutral session
manager; it does not expose generic repository read or write tools.

## Protocol

The integration exposes five strict tools. Context retrieval is read-only and
session-independent; the other four form the v1 authoring lifecycle:

| Tool                      | Responsibility                                                  |
| ------------------------- | --------------------------------------------------------------- |
| `openwiki_context`        | Rank task contracts, source/tests, invariants, and impact edges |
| `openwiki_begin`          | Validate the Git root and prepare an init/update session        |
| `openwiki_inspect_claims` | Read selected Claim sets without creating a write obligation    |
| `openwiki_resolve_claims` | Apply typed page-local Claim operations                         |
| `openwiki_finish`         | Run deterministic finalization and complete the session         |

Context accepts an absolute Git-root candidate and exact task without a run ID.
Begin accepts repository `init` or `update`; lifecycle calls after begin require
a UUID run ID.
Known domain errors retain bounded codes and messages. Unknown exceptions are
replaced by a generic transport-safe error so secrets and repository content do
not leak (`repo://src/integrations/core/protocol.ts#L14-L96`,
`repo://src/integrations/mcp/server.ts#L42-L99`).

The root must be an absolute Git worktree. The filesystem root and the current
user's home are refused even if they are Git repositories
(`repo://src/integrations/core/repository-root.ts#L20-L34`,
`repo://src/integrations/core/repository-root.ts#L117-L132`).

## Session state machine

One manager owns at most one active session and serializes every lifecycle
operation. Begin resolves setup, creates a recoverable init replacement,
captures run context and snapshots, prepares Claims and OKF, writes interrupted
metadata, then publishes the active session. On begin failure it restores the
previous session and rolls back init; incomplete rollback becomes an aggregate
error (`repo://src/integrations/core/session-manager.ts#L297-L418`).

Finish orders cleanup, deterministic wiki finalizers, deleted-page
reconciliation, Claims finalization, complete metadata, and finally init commit.
A failure before commit leaves the session active, so the host can repair files
and call finish again. Existing-wiki init therefore retains its backup until all
finalizers and metadata succeed (`repo://src/integrations/core/session-manager.ts#L421-L465`).

Current Claims warnings are returned beside `{status: "complete"}` and do not
fail finish. A future strict policy must fail before complete metadata and init
commit to preserve both retryable finish and transactional rollback.

A later begin deliberately supersedes an interrupted run. It commits any
retained init backup while keeping the authored state, then prepares the new
session (`repo://src/integrations/core/session-manager.ts#L562-L583`).

## Proof and extension seam

Adding an integration tool requires protocol schema/union changes, manager or
service logic, MCP registration and transport tests, installed skill
instructions, managed agent guidance, and package inventory tests.

```sh
pnpm exec vitest run test/integrations/protocol.test.ts \
  test/integrations/context-retrieval.test.ts \
  test/integrations/repository-root.test.ts \
  test/integrations/session-manager.test.ts \
  test/integrations/mcp-server.test.ts \
  test/integrations/mcp-stdio.test.ts \
  test/agent/wiki-replacement.test.ts
```
