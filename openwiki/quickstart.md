---
type: Agent entrypoint
title: Coding-agent quickstart
description: Task routing, authority rules, repository entrypoints, and validation strategy.
tags: [quickstart, routing, tests, source-map]
---

# Coding-agent quickstart

Use this wiki to narrow a task before broad search. It is an orientation and
change-impact index, not an authority layer: verify every material behavior in
source and tests before editing.

## Five-minute task loop

1. Classify the task with the routing table below.
2. Read the canonical page and its linked cross-system workflow.
3. Query the structured catalog for the exact task:
   `node openwiki/tools/context.mjs "<task>"`.
4. Open the cited implementation and proof tests; trace live imports/callers.
5. Preserve the page's invariants and known transaction/failure boundaries.
6. Run the narrow command first, then widen based on actual impact.

## Task routing

| Task                             | Start here                                                                  | Primary source                                          |
| -------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| Init, update, rollback, no-op    | [Run lifecycle](system/run-lifecycle.md)                                    | `src/agent/index.ts`, `wiki-replacement.ts`, `utils.ts` |
| Agent graph, prompts, middleware | [Agent runtime](agent/runtime.md), [authoring](agent/authoring-pipeline.md) | `src/agent/`                                            |
| Model/provider behavior          | [Providers](agent/providers.md)                                             | `src/config/constants.ts`, `src/agent/index.ts`         |
| CLI option/command/startup       | [CLI runtime](cli/runtime.md)                                               | `src/cli/`                                              |
| Claims semantics/finalization    | [Claims runtime](claims/model-and-runtime.md)                               | `src/claims/core`, `src/claims/brains/code`             |
| Evidence/store/sidecars          | [Claims persistence](claims/evidence-and-persistence.md)                    | `src/claims/evidence`, store/preflight                  |
| MCP host authoring               | [Host lifecycle](integrations/host-lifecycle.md)                            | `src/integrations/core`, `mcp`                          |
| Install Codex/Claude integration | [Installation](integrations/installation.md)                                | `src/integrations/install`                              |
| Task-oriented retrieval          | [Context retrieval](integrations/context-retrieval.md)                      | `src/integrations/context/retrieval.ts`                 |
| Frontmatter/index/provenance     | [OKF](knowledge/okf.md)                                                     | `src/okf`, `wiki-finalizer.ts`                          |
| New external connector           | [Connectors](data/connectors.md)                                            | `src/connectors`                                        |
| Personal/code ingestion          | [Ingestion](data/ingestion.md)                                              | `src/ingestion`                                         |
| OAuth/credentials/setup          | [Identity](identity/auth-and-credentials.md)                                | `src/auth`, `src/setup`, `src/config/env.ts`            |
| Cron/launchd/CI schedule         | [Scheduling](operations/scheduling.md)                                      | `src/scheduling`, `src/ingestion/code-mode.ts`          |
| Telemetry                        | [Telemetry](operations/telemetry.md)                                        | `src/telemetry`                                         |
| Visualizer/Mermaid               | [Visualization](operations/visualization.md)                                | `src/visualize`, `src/mermaid`                          |
| Portability/crash safety         | [Platform](platform/runtime-and-portability.md)                             | `src/platform`, crash guard                             |
| Build/package/release            | [Development](development/build-release-and-packaging.md)                   | `package.json`, `scripts`, `integrations`               |
| Tests or evaluation              | [Testing](quality/testing.md), [evals](quality/evals.md)                    | `test`, `evals`                                         |

## Repository runtime entrypoints

- Process dispatch: `src/cli/cli.tsx`
- Command grammar/routing: `src/cli/commands.ts`
- Persisted agent run: `src/agent/index.ts` (`runOpenWikiAgent`)
- Host-authored run: `src/integrations/core/session-manager.ts`
- Claims runtime: `src/claims/brains/code/runtime.ts`
- Deterministic finalization: `src/agent/wiki-finalizer.ts`
- Personal ingestion: `src/ingestion/ingestion.ts`
- Build and binary: `package.json`, `dist/cli/cli.js`

See [repository-map.md](repository-map.md) for ownership and
[knowledge-model.md](knowledge-model.md) for how the prose, contracts, evidence,
and retrieval packet fit together.

## Validation ladder

Prefer the narrowest quiet proof that covers the changed contract:

```sh
pnpm exec vitest run path/to/focused.test.ts
pnpm run typecheck
pnpm run build
pnpm run lint:check
pnpm test
```

Run build when generated/package assets change; run full `pnpm test` for broad
runtime, packaging, or cross-boundary work. Provider, OAuth, OS, Docker, and
model-backed evaluation paths may require credentials or external services and
are not implied by routine unit success.

## Non-negotiable boundaries

- Never treat generated prose as stronger evidence than source/tests.
- Preserve transactional repository init and retryable host finish ordering.
- Keep secret values out of logs, telemetry, tool schemas, snapshots, and errors.
- Treat repository, connector, and model text as untrusted input.
- Do not weaken path containment, symlink checks, or docs-only write boundaries.
- Do not change Claims sidecar schema accidentally through runtime policy.
