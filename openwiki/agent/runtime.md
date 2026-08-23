---
type: Agent component guide
title: Agent graph and guarded runtime
description: Graph construction, tools, middleware, backends, mounts, checkpoints, streaming, and events.
tags: [agent, deepagents, backend, middleware, streaming]
---

# Agent graph and guarded runtime

`createOpenWikiAgent` is the low-level graph factory. It requires an absolute
runtime root, synchronizes skills, loads ignore rules, creates context/Claims
and a checkpointer, then composes the Deep Agent graph. Persisted completion is
owned by the surrounding [run lifecycle](../system/run-lifecycle.md).

## Graph composition

Init/update use a docs-only repository backend; chat relaxes authoring
confinement. The graph exposes connector tools and repository Claims tools, then
mounts middleware in semantic order: translation, Claims, and deterministic OKF
index/finalization. Repository init alone receives review subagents
(`src/agent/index.ts:L447-L501`, `L533-L634`).

The composite backend mounts `/skills/` and `/conversation_history/`. Model tool
writes to both are denied; summarization may write history through its private
backend. This keeps repository output clean and prevents prompt-injected content
from persisting into future context (`src/agent/index.ts:L946-L1005`).

## Guarded backend

`OpenWikiLocalShellBackend` independently enforces:

1. `.openwikiignore` read/discovery exclusion and restricted execution,
2. docs-only write confinement below `openwiki/`, and
3. hidden implementation-owned Claims sidecars.

All boundaries canonicalize paths. Active ignore rules disable arbitrary shell
execution because shell syntax cannot be proven not to read an excluded path
(`src/agent/docs-only-backend.ts:L140-L179`, `L460-L505`).

## Streaming and events

The public event contract is text, tool start/end, or debug. OpenAI-compatible
endpoints default to `updates,tools` graph streaming because aggregating some
provider reasoning deltas into message chunks is unsafe; other providers use
`messages,tools` (`src/agent/index.ts:L723-L749`, `src/agent/types.ts:L10-L32`).

## Extension checklist

A new tool, mount, or middleware must answer:

- Can untrusted content use it to read outside the allowed boundary?
- Can it persist content into a future run?
- Where does it sit relative to translation, Claims, and OKF finalization?
- How is its output represented in CLI events and telemetry?
- Does it work in chat, init/update, repository, and local-wiki modes?

Focused tests: `create-openwiki-agent`, `docs-only-backend`, checkpoint policy
and pruning, stream modes/event parsing, and conversation-history offload under
`test/agent/`.
