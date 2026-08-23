---
type: Agent subsystem guide
title: Connector registry, acquisition, and source boundaries
description: Connector identity, durable state, raw tools, MCP confinement, HTTP resilience, source adapters, and LangSmith.
tags: [connectors, mcp, ingestion, langsmith, security]
---

# Connector registry, acquisition, and source boundaries

The connector registry is a fixed nine-entry inventory: local Git, Custom MCP,
Notion, X, Gmail, Slack, web search, Hacker News, and LangSmith. A
`ConnectorRuntime` combines declarative identity/mode/credentials with an
`ingest` implementation that returns `success`, `skipped`, or `error`, raw file
paths, and warnings (`repo://src/connectors/types.ts#L1-L82`,
`repo://src/connectors/registry.ts`).

## Mode boundary

Personal connectors acquire external knowledge for the private local wiki.
Their agent tools are withheld entirely from repository output mode. LangSmith
is the deliberate code-mode exception: code orchestration invokes it before the
repository authoring run and passes only its synthesized guidance onward.

Configuration, state, and raw acquisition live under the private OpenWiki home
per connector instance. State is schema v1 and retains summaries for the newest
20 runs. Raw files are private JSON beneath a run directory. Raw-file tools
validate containment and reject symlinks or physical aliases before reading
(`repo://src/connectors/tools.ts#L25-L214`).

## Acquisition contracts

Direct HTTP connectors share bounded timeouts and exponential backoff with
jitter for 429, 5xx, and network failures. `Retry-After` is honored within a
cap. Authentication and other ordinary 4xx responses are returned without
retry so the owning connector can refresh or report them.

Custom MCP and Notion first list tools, then invoke exact discovered names.
Permission is explicit through configured allowlists and MCP `readOnlyHint`;
OpenWiki does not infer safety from a tool's name. Stdio subprocesses receive a
small allowlisted environment instead of inheriting every process secret. HTTP
endpoints, results, and errors are bounded and sanitized
(`repo://src/connectors/mcp-client.ts#L781-L969`).

## Source-specific ownership

| Source                  | Acquisition and notable boundary                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `git-repo`              | Runs bounded Git commands against configured local clones and writes compact manifests; no credentials |
| `custom-mcp` / `notion` | Shared MCP runtime over HTTP or stdio; only configured read-only operations                            |
| `x`                     | X API user-context timelines, mentions, bookmarks, and lists                                           |
| `google`                | Gmail API with access-token refresh on authentication failure                                          |
| `slack`                 | Scoped conversations/messages/search through Slack Web API                                             |
| `web-search`            | Tavily through the LangChain integration                                                               |
| `hackernews`            | Public feeds and search APIs; no credentials                                                           |
| `langsmith`             | Official SDK traces for repository projects; code mode only                                            |

LangSmith reads committed `openwiki/.langsmith.json`, but the file names key
environment variables rather than storing values. API hosts are restricted to
official US/EU/APAC endpoints and key names to the OpenWiki LangSmith namespace,
closing the committed-config secret-exfiltration path. Workspace/project errors
become warnings so one source cannot stop the code run.

## Adding or changing a connector

Update the registry and adapter, instance/config validation, onboarding/auth,
raw/state ownership, ingestion routing, telemetry dimensions, and focused
tests. An adapter unit test alone does not prove the orchestration or secret
boundary.

```sh
pnpm exec vitest run test/connectors test/ingestion/ingestion.test.ts \
  test/ingestion/ingestion-run.test.ts test/ingestion/code-mode.test.ts
```
