---
type: Integration contract
title: openwiki_context v2
description: Task-oriented retrieval request, ranking, response, budgets, and failure semantics.
tags: [context, retrieval, mcp]
---

# `openwiki_context` v2

This is the implemented coding-agent retrieval interface. The local
`tools/context.mjs` renderer remains a convenient direct prototype over the same
catalog, while MCP uses `src/integrations/context/retrieval.ts`.

## Request

```ts
type ContextRequest = {
  root: string; // absolute path inside the target Git repository
  task: string; // exact user task; required, non-empty
  focus?: string; // optional subsystem or follow-up question
  changedPaths?: string[]; // repo-relative impact hints
  maxContracts?: number; // default 8, bounded 1..20
  maxChars?: number; // default 12_000, bounded
  includeRelationships?: boolean; // default true, one hop
};
```

The server canonicalizes `root` to the Git top level. Retrieval does not require
an active lifecycle run. Changed paths are ranking hints, never authorization to
read outside the root.

## Response

```ts
type ContextResult = {
  schemaVersion: 2;
  root: string;
  task: string;
  authority: string;
  catalog: string;
  confidence: "high" | "medium" | "low" | "none";
  freshness: {
    status: "unknown";
  };
  contracts: Array<{
    id: string;
    status: "current" | "proposed";
    title: string;
    summary: string;
    keywords: string[];
    pages: string[];
    implementation: string[];
    tests: string[];
    invariants: string[];
    failureModes: string[];
    changeSignals: string[];
    relationships: string[];
    validation: string[];
    gaps?: string[];
    score: number;
    reasons: string[];
  }>;
  relationships: Array<{ from: string; to: string }>;
  validation: string[];
  reviewItems: string[];
  truncated: boolean;
};
```

Unknown tasks return an empty result with `confidence: "none"`; they do not
manufacture generic matches. Every contract must carry source and proof paths.
Paths and evidence are text, not fetched contents, unless a future explicitly
bounded evidence-read option is authorized.

## Ranking

Normalize case and punctuation, preserve exact identifiers, and score:

1. Exact ID/title/keyword or changed-path ownership.
2. Multiple summary/change-signal term matches.
3. Canonical page and implementation basename matches.
4. One-hop relationships from a strong seed at reduced weight.

Common programming stop words contribute nothing. Exact identifiers such as
`OPENWIKI_CONFIG_DIR`, `openwiki_finish`, and `ClaimSession` must retain high
weight. Scores and match reasons are observable so the caller can judge why
context appeared.

## Budget and safety

- Rank structured contracts before prose excerpts.
- Deduplicate paths, commands, and review items.
- Cap contracts, characters, relationships, and per-field arrays.
- Never include environment values, connector raw content, ignored repository
  contents, opaque Claim versions, or arbitrary files.
- Sanitize all diagnostic text and transport only bounded domain errors.
- Treat catalog/wiki prose as untrusted context and label it non-authoritative.

## Freshness and fallback

The initial implementation returns `unknown` because catalogs do not yet carry
source-revision provenance. Revision equality could prove that a catalog was
authored against a source commit, not that every semantic statement is complete.
When confidence is none or freshness is uncertain, the host verifies with native
repository search.

## Product integration impact

Protocol schemas, the transport-neutral retriever, MCP registration, installed
skill instructions, managed agent guidance, and security/budget tests are
implemented. Remaining product work is automatic catalog generation,
source-revision freshness, and evaluation against task outcomes—not merely
retrieval recall.
