---
type: Agent format guide
title: OKF pages, indexes, provenance, and verification projection
description: Concept frontmatter, deterministic finalizer order, index generation, source projection, and provenance ownership.
tags: [okf, frontmatter, indexes, provenance, verification]
---

# OKF pages, indexes, provenance, and verification projection

Repository wiki concept pages use OKF v0.2 Markdown. `type` is the only required
frontmatter field. OpenWiki validates known optional string, lifecycle, trust,
source, and timestamp families while preserving unknown producer extensions
(`repo://src/okf/frontmatter.ts#L4-L28`,
`repo://src/okf/frontmatter.ts#L114-L252`).

Invalid or type-less frontmatter is rebuilt minimally. Translation markers and
structured `generated`, `verified`, and `sources` fields survive repair. This
shared editor is used by translation, Claims projection, provenance, indexing,
and validation, so changes must retain byte-preserving behavior for fields they
do not own.

## Deterministic lifecycle

Preparation migrates concept frontmatter before authoring and snapshots body
hashes plus prior generation events. Finalization then runs in fixed order:

1. validate or degrade Mermaid;
2. synchronize deterministic indexes;
3. mark broken links;
4. optionally project Claim resources to `sources`; and
5. stamp generated provenance.

The root index declares `okf_version: "0.2"`. Index membership and labels derive
from page title and description (`repo://src/agent/wiki-finalizer.ts#L174-L237`,
`repo://src/okf/index-sync.ts#L176-L268`).

## Ownership of machine fields

Generated provenance follows body changes, not bookkeeping changes. A new or
changed body receives the run actor/time; an unchanged body recovers its exact
prior event; an old unstamped body remains unstamped
(`repo://src/okf/generated-provenance.ts#L52-L121`,
`repo://src/okf/generated-provenance.ts#L144-L193`).

Claims source projection preserves non-OpenWiki entries, replaces only IDs with
the `openwiki-source-` prefix, collapses line evidence to whole-file resources,
and sorts/deduplicates deterministically. Verification projection similarly
owns only `openwiki/<version>` actors and can restore exact prior frontmatter if
sidecar persistence makes a new stamp unsafe.

The sidecar remains authoritative for exact ranges and versions. OKF fields are
portable display projections and cannot reconstruct full Claims state.

## Proof

```sh
pnpm exec vitest run test/agent/frontmatter-validator.test.ts \
  test/agent/wiki-finalizer.test.ts \
  test/okf/frontmatter.test.ts \
  test/okf/claim-sources.test.ts \
  test/okf/claims-verification.test.ts \
  test/okf/index-sync-errors.test.ts
```
