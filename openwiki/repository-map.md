---
type: Agent source map
title: Repository ownership map
description: Complete component-to-runtime, state, tests, and downstream-consumer map.
tags: [source-map, ownership, change-impact]
---

# Repository ownership map

This map covers every top-level `src/` domain plus root runtime modules,
packaged integration content, build scripts, and evaluations. File-level detail
belongs in the canonical page and catalog contracts.

| Area                        | Owns                                                                         | Durable state / output                        | Principal consumers           | Proof surface                  |
| --------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------- | ------------------------------ |
| `src/agent`                 | model loop, graph, prompts, backend, middleware, finalizers, run transaction | wiki, checkpoints, metadata                   | CLI, ingestion, host concepts | `test/agent`                   |
| `src/auth`                  | OAuth, external CLI auth, token refresh, ngrok                               | saved env, connector auth config              | setup, connectors, CLI        | `test/auth`                    |
| `src/claims`                | Claim model, evidence, tools, preflight, store, finalization                 | `.claims/*.json`                              | agent, OKF, MCP host          | `test/claims`, lifecycle tests |
| `src/cli`                   | grammar, TTY/print startup, dispatch, formatting                             | stdout/stderr and exit status                 | all user workflows            | `test/cli`                     |
| `src/config`                | providers, models, reasoning, env, OpenWiki home                             | `.env`, home paths                            | almost every runtime          | `test/config`                  |
| `src/connectors`            | source registry, HTTP/MCP clients, local tools                               | connector config/raw/state                    | ingestion, agent              | `test/connectors`              |
| `src/ingestion`             | personal fan-out and code-mode setup/context                                 | wiki updates, managed instructions/workflow   | CLI, scheduling               | `test/ingestion`               |
| `src/integrations`          | context retrieval, host protocol/session/MCP, and installer                  | context packets, active session, skill/config | Codex/Claude hosts            | `test/integrations`            |
| `src/mermaid`               | fence parsing and validation/degradation                                     | repaired Markdown                             | wiki finalizer                | `test/mermaid`                 |
| `src/okf`                   | frontmatter, indexes, provenance, Claims projection                          | OKF Markdown metadata                         | authoring/finalization        | `test/okf`, finalizer tests    |
| `src/platform`              | redaction, language, filesystem errors, Windows ACL                          | sanitized values/permissions                  | all boundaries                | `test/platform`                |
| `src/scheduling`            | cron and macOS native schedule/power                                         | LaunchAgent and settings                      | personal ingestion            | `test/scheduling`              |
| `src/setup`                 | credentials UI and onboarding/readiness                                      | onboarding and instructions                   | CLI, code/personal modes      | `test/setup`                   |
| `src/telemetry`             | taxonomy, gates, senders, install identity                                   | bounded events                                | CLI/run wrappers              | `test/telemetry`               |
| `src/visualize`             | graph, loopback server, browser client, export                               | static site / live graph                      | CLI                           | `test/visualize`               |
| `src/model-availability.ts` | fail-open provider model lookup                                              | none                                          | setup/model selection         | focused test                   |
| `src/version.ts`            | version/build-channel identity                                               | event/actor/version strings                   | CLI, OKF, telemetry, install  | focused test                   |
| `integrations/openwiki`     | shipped host skill instructions                                              | package payload                               | installer/host agent          | package/skill tests            |
| `scripts`                   | build-channel stamping and asset/integration copying                         | `dist`, package contents                      | build/release                 | script/package tests           |
| `evals/ledger`              | longitudinal wiki factual-health benchmark                                   | auditable run artifacts                       | evaluators/research           | colocated Vitest suite         |
| `evals/deepswe`             | paired coding-agent experiment                                               | trial/results/feedback                        | research orchestration        | Python unittest suite          |

## High-coupling seams

The strongest change-impact edges are:

- Agent run ↔ Claims runtime ↔ OKF finalizer ↔ metadata/replacement commit.
- Protocol ↔ session manager ↔ MCP schema ↔ installed skill/package receipt.
- Provider registry ↔ credentials/setup ↔ model construction ↔ diagnostics.
- Connector adapter ↔ raw/state tools ↔ ingestion ↔ auth/scheduling.
- Frontmatter helpers ↔ translation ↔ indexes ↔ provenance ↔ Claims projection.
- Visualizer client assets ↔ TypeScript builds ↔ package copying/release.

Use `coverage/manifest.json` as the machine-checkable coverage source. The
validator compares it with the actual top-level tree so a new domain cannot
silently remain undocumented.
