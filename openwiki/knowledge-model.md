---
type: Agent architecture guide
title: Agent wiki knowledge model
description: How pages, behavior contracts, evidence, relationships, coverage, and context packets compose.
tags: [knowledge-model, contracts, evidence, retrieval]
---

# Agent wiki knowledge model

An agent wiki should not be a second implementation manual. Its smallest useful
unit is a **behavior contract**: a statement that affects how code may safely
change, backed by implementation and proof, connected to downstream impact.

## Four layers

| Layer        | Artifact                             | Purpose                                                      |
| ------------ | ------------------------------------ | ------------------------------------------------------------ |
| Navigation   | `quickstart.md`, `repository-map.md` | Route intent to ownership quickly                            |
| Explanation  | domain/workflow pages                | Explain order, invariants, boundaries, failures, seams       |
| Retrieval    | `knowledge/catalog.json`             | Decompose behavior into rankable, machine-readable contracts |
| Completeness | `coverage/manifest.json`, validator  | Detect missing domains/pages/tests/evidence/links            |

Each catalog contract has an ID, current/proposed status, title, summary,
keywords, canonical pages, implementation evidence, proof tests, invariants,
failure modes, relationships, change signals, validation commands, and explicit
gaps where useful. IDs are semantic and stable; they are not source locations.
Source paths may change while the behavior remains.

## Evidence and confidence

Implementation evidence explains _where the behavior is owned_. Tests explain
_what is currently proved_. A test citation does not prove every sentence on a
page, and prompt instructions do not prove model compliance. Operational gaps
are recorded instead of converted into invented guarantees.

Context confidence is retrieval confidence, not truth confidence:

- `high`: several strong task/keyword matches with implementation and tests.
- `medium`: one strong or several partial matches.
- `low`: weak lexical/relationship matches; inspect broadly.
- `none`: no useful catalog match; fall back to source discovery.

Freshness is established mechanically (paths and coverage still exist) and
semantically by source review. No generated timestamp can establish semantic
freshness on its own.

## Retrieval behavior

The MCP retriever and local renderer tokenize the task, score titles, keywords,
summaries, change signals and changed paths, then expand one hop through
relationships. They return contracts before page prose, deduplicate commands,
and state when the task is unknown. This structure helps an agent form a bounded
search hypothesis without hiding uncertainty behind a large document dump.

## Why this can support any task—but not answer it alone

Completeness here means every substantial component and cross-system workflow
has a canonical route, contracts, evidence entrypoints, impact edges, and proof
surface. It does not mean every helper, branch, or future task is pre-described.
For a novel task, the wiki should reliably answer where to start and what to
protect. The agent must still inspect the exact live code, callers, and tests.
