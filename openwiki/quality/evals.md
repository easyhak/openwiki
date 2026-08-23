---
type: Agent evaluation guide
title: Grounding and coding-agent evaluations
description: LEDGER longitudinal grounding metrics and the paired DeepSWE agent-utility experiment.
tags: [evals, ledger, deepswe, grounding, agent-utility]
---

# Grounding and coding-agent evaluations

The evaluation systems answer different questions. LEDGER asks whether wiki
facts track a changing repository. DeepSWE asks whether providing an OpenWiki
improves a coding agent's task performance. Neither replaces deterministic unit
and integration tests.

## LEDGER

LEDGER replays ordered Git checkpoints, runs repository init at the first and
updates thereafter, freezes each wiki, then reevaluates every current factual
claim against source at that checkpoint. Claims are classified as supported,
stale, invented, or unverified; all four rates use the current-claim count as
their denominator (`repo://evals/ledger/run/runner.ts#L119-L287`,
`repo://evals/ledger/metrics/claims.ts#L13-L69`).

Evidence maps route a concept toward likely source, but never encode the answer.
The evaluator still resolves and judges raw source. Model/evaluator failure is
fail-soft where possible and reduces reported completeness rather than silently
becoming a favorable score. A saved run can be reevaluated with a different
evaluator without rerunning OpenWiki.

The core score rewards supported/current documentation and exposes the other
states separately; longitudinal churn and forgetting analysis explain how the
score changes (`repo://evals/ledger/metrics/score.ts#L3-L23`).

## DeepSWE

DeepSWE pairs baseline and OpenWiki conditions with the same task, model,
reasoning effort, seed, attempts, and Harbor environment. The treatment restores
or generates a wiki in isolation, merges managed instructions, and gives the
unchanged Codex task prompt the wiki files. Treatment artifacts are excluded
from the submitted patch and held-out tests remain in an offline verifier.

Network destinations are allowlisted; credentials are injected at runtime and
must not enter images, command arguments, wikis, or summaries. Cache validation
ensures reused wikis match the intended repository/task inputs
(`repo://evals/deepswe/openwiki_codex.py#L423-L598`,
`repo://evals/deepswe/run.py#L383-L479`).

## Running focused checks

```sh
pnpm run eval:ledger:typecheck
pnpm exec vitest run evals/ledger
uvx --from pytest pytest evals/deepswe/tests
```

Live benchmark runs require model credentials, network access, pinned external
tools, and deliberate cost authorization; they are not normal pull-request
correctness gates.
