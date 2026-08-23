---
type: Agent subsystem guide
title: Claims evidence, preflight, and persistence
description: Repository resource identities, evidence relocation, sidecar schema, containment, and freshness preflight.
tags: [claims, evidence, sidecars, preflight, security]
---

# Claims evidence, preflight, and persistence

Repository evidence is the only current Claims evidence namespace. Resources
use canonical `repo://path` or `repo://path#Lx-Ly` identities. Parsing rejects
absolute paths, traversal, controls, `.git`, and the generated `openwiki/`
subtree; a single line canonicalizes to a range
(`repo://src/claims/evidence/repository/resource.ts#L47-L77`,
`repo://src/claims/evidence/repository/resource.ts#L85-L168`).

## Resolution and freshness

Whole-file evidence hashes the complete text. Range evidence stores opaque
content and anchoring information so the resolver can relocate an unchanged or
edited range across revisions. Missing or ambiguous ranges resolve to `null`.
Ignored paths throw rather than masquerading as absent. Missing files return
`null`, while operational read failures remain errors
(`repo://src/claims/evidence/repository/resolver.ts#L16-L84`,
`repo://src/claims/evidence/repository/resolver.ts#L189-L325`).

Evidence resolution performs lexical and physical containment checks. Symlinks
and alternate physical aliases are rejected after `lstat`/`realpath`; a Claim
cannot use a contained-looking path to read outside the repository.

Update preflight loads sidecars without mutating them, resolves each unique
resource/prior-version pair once, and classifies unresolved before stale.
Resolver failures remain fatal. It also inventories orphan sidecars and factual
pages without Claims so that debt can be surfaced lazily to the author
(`repo://src/claims/brains/code/preflight.ts#L44-L108`).

## Sidecar contract

Grounded page `/openwiki/x.md` maps to `openwiki/.claims/x.json`. Sidecars are
schema v1 with exactly the page version, Claims, and optional verification
record. The store accepts no alternate schema version or policy field; runtime
policy such as a future strict mode belongs outside this persisted format
(`repo://src/claims/brains/code/types.ts#L3-L50`,
`repo://src/claims/brains/code/paths.ts#L98-L145`).

Store loading fails closed on malformed data and enforces page-level Claim ID
and evidence-resource uniqueness. The page version hashes exact Markdown bytes.
Writes use a same-directory temporary file and rename; discovery never follows
symlinks and requires lexical and physical locations to agree
(`repo://src/claims/brains/code/store.ts#L157-L235`,
`repo://src/claims/brains/code/store.ts#L288-L326`,
`repo://src/claims/brains/code/store.ts#L547-L660`).

The sidecar is the authoritative source for exact evidence ranges and versions.
OKF `sources` and `verified` frontmatter are lossy, user-visible projections.

## Change impact and proof

Changing resource/version semantics affects mutation confirmation, preflight,
sidecars, and OKF projection. Changing path classification affects discovery,
deletion reconciliation, author read notes, and sidecar ownership. A schema
change requires an explicit migration because the loader currently accepts only
literal version 1.

```sh
pnpm exec vitest run test/claims/evidence/repository/resource.test.ts \
  test/claims/evidence/repository/resolver.test.ts \
  test/claims/brains/code/store.test.ts \
  test/claims/brains/code/preflight.test.ts
```
