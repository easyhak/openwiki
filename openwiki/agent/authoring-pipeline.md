---
type: Agent workflow guide
title: Authoring, review, translation, and deterministic finalization
description: Prompt-owned research workflow and code-owned Markdown integrity pipeline.
tags: [authoring, prompts, review, translation, finalization]
---

# Authoring, review, translation, and deterministic finalization

OpenWiki combines a prompt-owned semantic workflow with code-owned integrity
finalizers. Tests can prove the workflow instructions and available reviewer
tools, but only deterministic code can guarantee formatting and state behavior.

## Prompt-owned repository init

The code prompt directs the model to inventory the repository, design and twice
review a frozen page taxonomy, perform one evidence pass per page, resolve
Claims before factual prose, check unknown unknowns, reconcile the tree, and run
question/verifier repair waves (`src/agent/prompts/code.ts:L118-L256`). Update
work scopes Claims and edits to affected facts/pages.

Review subagents are init-only and read-only: no write, edit, or execute tools.
The parent retains Claims and Markdown mutation ownership
(`src/agent/review-subagents.ts`, `skeleton-critic.ts`, `wiki-qa-subagents.ts`).

This is an important limitation: prompt tests prove instructions exist, not that
every model obeys the full workflow or achieves semantic completeness.

## Deterministic middleware

Before authoring, OKF middleware migrates concept metadata and snapshots prior
body provenance. Successful writes with invalid frontmatter return a repair
warning to the model; ordinary recoverable tool errors remain model-recoverable
rather than becoming fatal (`src/agent/okf-middleware.ts`).

After authoring, the fixed order is:

1. validate or degrade Mermaid,
2. synchronize directory indexes,
3. mark broken internal links,
4. project Claim evidence sources,
5. reconcile generated provenance.

All use the run’s single timestamp (`src/agent/wiki-finalizer.ts:L174-L236`).

Translation middleware runs only on update. A language switch translates all
eligible pages; ordinary updates retry pending pages. One page failure warns and
remains pending without aborting the whole update.

## Proof and change impact

Use prompt/reviewer tests for semantic workflow changes; middleware/finalizer,
frontmatter, link, Mermaid, and translation tests for code-owned behavior. A new
finalizer operation must update operation types, telemetry tagging/allowlists,
and ordering tests.
