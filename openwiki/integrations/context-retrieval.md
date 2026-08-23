---
type: Agent integration guide
title: Task-oriented coding-context retrieval
description: The read-only openwiki_context catalog boundary, ranking, budgets, confidence, safety, and remaining freshness gaps.
tags: [integration, context, retrieval, mcp]
---

# Task-oriented coding-context retrieval

`openwiki_context` is a read-only, session-independent MCP tool. A host supplies
an absolute repository path and the exact coding task, optionally adding a
focused question, changed paths, contract count, character budget, or disabling
relationship expansion. It does not call begin or mutate repository state.

## Corpus and safe loading

The first supported corpus is a schema-v1 behavior catalog at
`openwiki/knowledge/catalog.json`. The tool
canonicalizes the Git root, refuses filesystem/home roots through the shared
repository boundary, requires a regular file below 2 MB, rejects symlink
components, compares the opened descriptor with the checked file, and strictly
validates every contract and relationship. Missing or unsafe catalogs produce a
bounded domain error without exposing contents.

## Ranking and response

Ranking combines exact IDs and keywords, task terms across title, summary,
change signals and evidence paths, and strong exact or owning changed-path
matches. Strong direct matches may add one relationship hop at reduced weight.
Results sort by score then stable ID and expose their match reasons.

The packet returns current/proposed status, summary, canonical pages,
implementation and tests, invariants, failure modes, impact signals,
relationships, validation commands, review gaps, confidence, and truncation.
`high|medium|low` describes retrieval strength, not truth. An unknown task
returns `confidence: none` and no generic filler.

Count and approximate serialized-character budgets are enforced after ranking;
the highest contract must fit. The response never reads or returns cited source
bodies, environment values, raw connector content, or opaque Claim versions.

## Current limitations

Catalog generation is not part of ordinary OpenWiki init/update, so repositories
without a compatible catalog receive a safe missing-catalog error. Freshness is
currently `unknown`: path/schema validation proves mechanical readability, not
that every contract matches the current commit. Ranking is deterministic
lexical/path retrieval rather than embeddings. These are explicit fallback
signals; hosts verify the returned source and tests.

## Change impact and proof

The implementation is `src/integrations/context/retrieval.ts`; protocol input is
owned by `src/integrations/core/protocol.ts`, the session manager registers the
session-free operation, and MCP remains a thin adapter. Installed skill and
managed `AGENTS.md` guidance tell hosts when to call it. The detailed wire shape
is in [the context contract](../context/openwiki-context-v2.md).

```sh
pnpm exec vitest run test/integrations/context-retrieval.test.ts \
  test/integrations/protocol.test.ts \
  test/integrations/mcp-server.test.ts \
  test/integrations/skill.test.ts \
  test/ingestion/code-mode.test.ts
```
