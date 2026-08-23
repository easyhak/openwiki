---
type: Agent testing guide
title: Testing strategy and validation selection
description: How tests mirror ownership, which suites prove cross-cutting behavior, and how to choose narrow validation.
tags: [testing, vitest, validation, fixtures]
---

# Testing strategy and validation selection

Tests generally mirror source ownership under `test/<domain>/`; the important
exceptions are cross-system lifecycle tests and the separate evaluation
projects. Vitest is the unit/integration runner, TypeScript typechecks both Node
and browser compilations, and CI additionally verifies formatting, lint, build,
CLI smoke, Windows behavior, and package integrity.

## Select tests by contract, not filename alone

| Changed behavior               | Minimum proof surface                                                          |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Agent init/update ordering     | `test/agent/claims-run-lifecycle.test.ts`, run metadata/no-op tests            |
| Model provider resolution      | provider-specific test + `create-model` + model resolution                     |
| Backend/ignore/security        | docs-only backend + ignore + redaction negative cases                          |
| Claims mutation/store/evidence | owning Claims test plus lifecycle integration when completion semantics change |
| CLI option or command          | parser + startup + runner; component tests only if rendering changed           |
| Connector                      | source adapter test + registry/config + ingestion when orchestration changes   |
| Host integration               | protocol/session manager + MCP transport + installer if shipped config changes |
| OKF/finalization               | owning OKF test + agent wiki finalizer/lifecycle                               |
| Scheduler                      | parser/operation tests plus launchd-specific proof when applicable             |
| Visualizer                     | graph/server/static export; browser client tests for UI state                  |

## Test design conventions

- Filesystem tests use isolated temporary roots and clean them in teardown.
- Provider/network behavior is mocked unless a test is explicitly live/e2e.
- Failure tests assert durable state—not only the thrown message—when rollback,
  retry, or interrupted metadata is part of the contract.
- Security tests include alternative path spellings, containment escapes,
  secret-bearing payloads, and unknown input.
- Build scripts are executed against temporary copies rather than mutating the
  repository.

## Validation ladder

1. Run the smallest owning test file during implementation.
2. Add direct caller/downstream contract tests for cross-boundary changes.
3. Run `pnpm run typecheck` and ESLint/Prettier on changed files.
4. Use `pnpm run build` for compilation, packaging, browser assets, or emitted
   entrypoint changes.
5. Use the full `pnpm test` only when change breadth justifies it.

Live tests and evals require credentials and are not ordinary correctness gates.
See [evals](evals.md) for LEDGER and DeepSWE.
