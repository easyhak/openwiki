---
type: Agent subsystem guide
title: Claims model, session, and finalization
description: Atomic Claim semantics, run-scoped state, authoring tools, finalization, and failure policy.
tags: [claims, grounding, finalization, atomicity]
---

# Claims model, session, and finalization

Claims are the structured factual layer behind repository wiki prose. A Claim is
one concise proposition with an OpenWiki-owned stable ID and one or more
resolver-owned evidence records. Evidence versions are opaque: callers name a
resource, while its resolver decides how freshness is represented.

## Runtime ownership

Claims are enabled only for repository `init` and `update`. Init creates an empty
session after the old wiki is moved behind the replacement transaction; update
loads and preflights existing sidecars. Chat and personal-wiki runs do not get a
Claims session (`repo://src/claims/brains/code/runtime.ts#L49-L118`).

`ClaimSession` owns the run-scoped state:

- globally unique ownership of Claim IDs;
- serialized mutations for a page;
- lazy stale/unresolved issue disclosure;
- dirty/deleted/orphan page bookkeeping; and
- in-memory markers for factual pages that lack Claims.

Inspection returns statements and resources but withholds version internals.
Read notes tell the author when a page has stale/unresolved debt or no Claims;
they do not modify the Markdown (`repo://src/claims/brains/code/session.ts#L112-L188`,
`repo://src/claims/brains/code/session.ts#L255-L339`).

## Atomic mutation boundary

An add/confirm/update/retract batch validates every operation and resolves all
new evidence before committing a cloned page state. Duplicate targets, unknown
IDs, empty evidence, collisions, or unresolvable evidence reject the page batch
without a partial mutation (`repo://src/claims/core/mutations.ts#L45-L128`,
`repo://src/claims/core/mutations.ts#L138-L199`).

A single multi-page tool call executes independent page-local transactions in
parallel. It is intentionally not an all-pages transaction. Callers that need a
cross-page invariant must handle partial page success explicitly
(`repo://src/claims/brains/code/tools.ts#L253-L277`).

## Finalization

Finalization revisits only dirty, deleted, or orphaned state. For an eligible
page it re-resolves evidence, verifies the exact Markdown bytes, writes the
sidecar, and decides whether machine verification may appear in OKF frontmatter.
Recoverable page-local persistence or evidence problems become warnings so
other pages can complete; containment and security failures remain fatal
(`repo://src/claims/brains/code/session.ts#L379-L491`,
`repo://src/claims/brains/code/session.ts#L545-L568`).

The runtime then projects verification into Markdown, refreshes sidecar page
hashes, and rolls back any verification stamps that became unsafe. Warning-sink
failure is swallowed. This is currently best-effort behavior: there is no
`OPENWIKI_CLAIMS_STRICT` configuration or strict finalization branch in this
checkout (`repo://src/claims/brains/code/runtime.ts#L120-L164`).

Deletion of a successfully removed Markdown page automatically schedules its
sidecar for deletion. Structural pages such as indexes, logs, instructions,
plans, and Claims internals never own Claims.

## Change impact and proof

Mutation semantics are shared by the native agent tools and MCP
`openwiki_resolve_claims`. Finalization is called by the native persisted run
and the host-authored integration. Policy changes therefore need both paths,
including metadata ordering, init rollback, and retry behavior.

Focused validation:

```sh
pnpm exec vitest run test/claims/core/mutations.test.ts \
  test/claims/brains/code/session.test.ts \
  test/claims/brains/code/runtime.test.ts \
  test/claims/brains/code/tools.test.ts \
  test/agent/claims-run-lifecycle.test.ts
```
