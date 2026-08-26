---
type: orientation-guide
title: OpenWiki Quickstart
description: Entry-point orientation for a coding agent working on the OpenWiki CLI codebase, with a task-routing map into the architecture, workflow, concept, operations, integration, and testing pages.
tags: [openwiki, quickstart, cli, orientation, task-routing, deepagents]
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-f317ee207e1653d2033c81a4
    resource: repo://CONTRIBUTING.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-6cb3236b8c1412a26d832fcf
    resource: repo://src/agent/repository-runner.ts
  - id: openwiki-source-5c43e3fe562cf274dd6a5564
    resource: repo://src/cli/cli.tsx
  - id: openwiki-source-3fc16f0371ced4d94330f06c
    resource: repo://src/cli/commands.ts
  - id: openwiki-source-7c5ecb56558cc061dab24f9d
    resource: repo://src/generation/repository-run.ts
  - id: openwiki-source-610ff51ff8da46ab065496a5
    resource: repo://src/visualize/client.ts
  - id: openwiki-source-b0d5ccee7e5f7532bd8ed3f5
    resource: repo://src/visualize/page.ts
  - id: openwiki-source-ec5a58d1a89689ead79b8150
    resource: repo://test/agent/repository-runner.test.ts
  - id: openwiki-source-e3be493bc871948f42420690
    resource: repo://test/visualize/client-interaction.test.ts
generated: { by: "openwiki/0.4.0", at: "2026-08-26T21:08:39.375Z" }
verified:
  - by: openwiki/0.4.0
    at: 2026-08-26T21:08:39.375Z
---

# OpenWiki Quickstart

OpenWiki is a command-line tool that writes and maintains a Markdown wiki for a
codebase or for personal knowledge. A [Deep Agents](https://github.com/langchain-ai/deepagentsjs)
documentation agent reads your sources, synthesizes a linked wiki you own, and
keeps it current as those sources change. It is built for agents to read as
memory and ships an interactive visualizer for humans to explore.

This page orients a coding agent to the codebase and routes you to the page that
matches your task. Read this first, then follow the links below.

## What OpenWiki is

OpenWiki is published as the `openwiki` npm package, a Node.js (22+) CLI whose
binary resolves to `dist/cli/cli.js`. Its purpose, per the package manifest, is
"a CLI that uses a DeepAgents documentation agent to generate and maintain an
OpenWiki for a codebase." The runtime is a DeepAgents documentation agent driven
by one of several model providers, wrapped by a CLI that can run interactively
(an Ink TUI) or one-shot (print mode).

The CLI has two operating modes:

- **Code** _(default)_ — documents the current repository and writes the wiki to
  `openwiki/` inside the repo.
- **Personal** — documents your connected sources and writes to
  `~/.openwiki/wiki`.

## Developer workflow

OpenWiki is a pnpm + TypeScript project. The commands you will use most:

```sh
pnpm install          # install dependencies
pnpm run build        # tsc (server + client) then copy visualizer assets
pnpm run dev          # run the CLI from source via tsx (src/cli/cli.tsx)
pnpm run coverage     # run the Vitest suite with coverage
pnpm test             # typecheck + build + coverage (the full CI-equivalent gate)
```

`pnpm run dev` executes the TypeScript entrypoint directly with `tsx`, while the
shipped binary runs the compiled `dist/cli/cli.js`. Before opening a PR, run
`pnpm run format`, `pnpm run lint`, and `pnpm test`; `format` and `lint` mirror
the per-PR checks and `test` typechecks, builds, and runs Vitest with coverage.

To exercise the CLI against another local repository, link the package globally
(`pnpm link --global`) or alias `openwiki` to `node /path/to/openwiki/dist/cli/cli.js`,
then run it from the target repo's working directory.

## Entrypoint and control flow

The process entrypoint is `src/cli/cli.tsx`. It installs a crash guard before any
run so escaped rejections are recorded with telemetry, parses the argument vector
into a command, and dispatches:

- `integrations` and `mcp` commands go to the host-integration surface
  (`runIntegrationsCommand` / `runMcpCommand`).
- All other commands run through the native pipeline, which loads environment,
  resolves the startup command, and then either prints a startup error, runs
  non-interactively in print mode, or renders the interactive Ink `App`.

The `dev` script points at this same `.tsx` file, so behavior is identical
between `pnpm run dev` and the built binary.

## Fault-tolerance notes

Two recent fixes change how the system behaves under worker and UI failure, and
both have dedicated pages with the full lifecycle and test coverage:

- **Failing page workers are skipped, not fatal.** When a repository page worker
  throws before submitting, or exits without submitting, the runner restores the
  page snapshot, marks the job `skipped` (without advancing the pending
  checkpoint), emits a deferred warning that the page will be reconsidered on the
  next update, and continues the run. The run therefore completes with the rest
  of the plan rather than aborting. See
  [Repository Generation Lifecycle](/openwiki/workflows/repository-generation.md)
  for the full durable flow and the skip/restore semantics, and
  [Testing Guide](/openwiki/testing/overview.md) for the
  `restores and leaves a page pending when its worker does not submit` test.
- **Visualizer graph clicks are isolated.** The visualizer's hint/legend overlay
  is anchored inside the `#graph` panel (`position: relative`), so it can never
  cover the page index or reader. Background (blank-canvas) clicks are a no-op —
  the only former path to the empty reader state — so a stray click no longer
  wipes the page the user is reading. See
  [Interactive Visualizer](/openwiki/integrations/visualizer.md) for the overlay
  anchoring, the deliberate absence of an `onBackgroundClick` handler (issue
  #670), and the `client-interaction` regression tests.

## Task-routing map

Find your task on the left, then read the page on the right.

### Understand the system

| I want to…                                                                                         | Read                                                                             |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Get the top-level picture of how the CLI, agent, modes, and finalization fit together              | [Architecture Overview](/openwiki/architecture/overview.md)                      |
| Understand how the DeepAgents documentation agent is built (models, backends, prompts, middleware) | [Agent Runtime, Models, and Middleware](/openwiki/architecture/agent-runtime.md) |
| Find which subsystem lives where under `/src`                                                      | [Source Map](/openwiki/architecture/source-map.md)                               |

### Learn the core concepts

| I want to…                                                                       | Read                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Understand the two operating modes and where each writes its state               | [Code vs Personal Modes](/openwiki/concepts/two-modes.md)                |
| Understand grounded Claims: material facts tied to versioned repository evidence | [Grounded Claims](/openwiki/concepts/grounded-claims.md)                 |
| See what OKF output looks like (frontmatter, provenance, validated Mermaid)      | [Open Knowledge Format Output](/openwiki/concepts/okf-output.md)         |
| Choose a model provider and configure its credentials                            | [Model Providers and Credentials](/openwiki/concepts/model-providers.md) |

### Follow a workflow end to end

| I want to…                                                                                              | Read                                                                             |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Set up OpenWiki for the first time (provider/model, credentials, repo setup)                            | [Onboarding and Setup](/openwiki/workflows/onboarding.md)                        |
| Trace the resumable page-job generation flow (`begin → submit_plan → next_page → submit_page → finish`) | [Repository Generation Lifecycle](/openwiki/workflows/repository-generation.md)  |
| Understand how failing/non-submitting page workers are skipped, not fatal                                | [Repository Generation Lifecycle](/openwiki/workflows/repository-generation.md)  |
| Understand how Claims are reconciled on update and how a page submits its full Claim set                | [Claims Reconciliation on Update](/openwiki/workflows/claims-reconciliation.md)  |
| Understand deterministic finalization, index/provenance sync, and link validation                       | [Wiki Finalization and Link Integrity](/openwiki/workflows/wiki-finalization.md) |
| Trace how personal-mode ingestion pulls connector sources and updates the brain                         | [Personal Mode Ingestion](/openwiki/workflows/personal-ingestion.md)             |

### Operate and configure it

| I want to…                                                                                   | Read                                                                   |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Look up CLI commands and flags (init/update, mode, print, integrations, visualize, schedule) | [CLI Commands and Flags](/openwiki/operations/cli-reference.md)        |
| Configure environment variables and the local state directory                                | [Configuration and Environment](/openwiki/operations/configuration.md) |
| Set up scheduled self-update in CI and the docs-PR workflow                                  | [CI Scheduling and Self-Update](/openwiki/operations/ci-scheduling.md) |
| Understand opt-out telemetry and diagnostics                                                 | [Telemetry and Diagnostics](/openwiki/operations/telemetry.md)         |

### Integrate with other tools

| I want to…                                                                                                        | Read                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Run OpenWiki inside Codex, Claude Code, or OpenCode                                                               | [Coding-Agent Integrations (Codex/Claude/OpenCode)](/openwiki/integrations/coding-agents.md) |
| Use or add a source connector (Custom MCP, Notion, Slack, Gmail, X, Web Search, Hacker News, LangSmith, git-repo) | [Source Connectors](/openwiki/integrations/connectors.md)                                    |
| Publish or explore the wiki as an interactive graph                                                               | [Interactive Visualizer](/openwiki/integrations/visualizer.md)                               |
| Understand the graph overlay anchoring and why background clicks no longer clear the reader                       | [Interactive Visualizer](/openwiki/integrations/visualizer.md)                               |

### Test your changes

| I want to…                                                                | Read                                           |
| ------------------------------------------------------------------------- | ---------------------------------------------- |
| Understand the test layout and how to run and scope tests                 | [Testing Guide](/openwiki/testing/overview.md) |
| Find the skip-failed-worker regression test (`restores and leaves a page pending when its worker does not submit`) | [Testing Guide](/openwiki/testing/overview.md) |
| Find the visualizer background-click regression tests (issue #670)         | [Testing Guide](/openwiki/testing/overview.md) |

## Where OpenWiki keeps its state

- **Repository (code) wiki:** written to `openwiki/` in the repo, alongside the
  structured Claims sidecar under `openwiki/.claims/` and in-progress run state
  in `openwiki/.run.json`.
- **Local state:** credentials, the personal wiki, connector data, conversation
  history, and skills live under `~/.openwiki` by default; set
  `OPENWIKI_CONFIG_DIR` to relocate to a different writable directory.

On a persistent checkout, an interrupted `openwiki --init` can resume the durable
page queue by rerunning the same command; ephemeral CI runners start fresh after
failure unless their workspace is preserved. A page worker that fails or exits
without submitting is skipped for the current run and reconsidered on the next
update, so an interruption does not abort the whole generation.
