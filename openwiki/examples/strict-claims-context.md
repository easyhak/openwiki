---
type: Proposed context example
title: Example context packet for strict Claims finalization
description: How an agent-native wiki should orient a not-yet-implemented cross-cutting change.
tags: [claims, strict-mode, example, proposed]
---

# Example: “Add opt-in strict Claims finalization”

This is a hypothetical retrieval result for a requested feature. The source in
this checkout has best-effort Claims finalization only; it does not define
`OPENWIKI_CLAIMS_STRICT`.

## Current contracts to preserve

- Recoverable page-local finalization problems become warnings; containment and
  security failures remain fatal.
- Repository init retains a replacement backup until finalization succeeds and
  rolls back on fatal failure.
- MCP finish writes complete metadata and commits init only after Claims; a
  pre-commit failure leaves the active session retryable.
- Claims sidecars remain schema version 1 with no policy field.
- Default behavior must remain best-effort.

## Likely implementation route

1. Parse the opt-in environment setting at a centralized configuration boundary
   with exact value `1` semantics.
2. Let existing page-local finalization collect warnings unchanged.
3. At the runtime orchestration boundary, convert stale/unresolved-Claim
   warnings into a failure only when strict mode is enabled.
4. Place that gate before complete metadata/replacement commit in native and
   host-authored paths.
5. Keep warning data/session state intact so MCP finish can be repaired and
   retried.

## Primary evidence to inspect

- `src/claims/brains/code/session.ts` — warning production and eligible writes.
- `src/claims/brains/code/runtime.ts` — finalization orchestration and warning sink.
- `src/agent/index.ts` — native run completion and init rollback.
- `src/integrations/core/session-manager.ts` — finish order and retry boundary.
- `src/claims/brains/code/types.ts`, `store.ts` — sidecar compatibility.

## Proof obligations

- Default init/update and MCP finish still complete with the same warnings.
- Strict native init failure restores the pre-init wiki exactly.
- Strict native update fails before complete metadata and remains retryable.
- Strict MCP finish fails before complete metadata/commit and succeeds on retry
  after Claim debt is resolved.
- Unrelated warning categories and fatal security errors retain their semantics.
- No sidecar bytes/schema change solely because strict mode is enabled.

Focused suites: `test/claims/brains/code/runtime.test.ts`,
`test/agent/claims-run-lifecycle.test.ts`, and
`test/integrations/session-manager.test.ts`.

## Review item

The exact warning taxonomy is the key source question: strict mode should fail
for stale/unresolved Claim debt, not indiscriminately for every recoverable
warning. Inspect structured warning types before choosing a matching mechanism.
