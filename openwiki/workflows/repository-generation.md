---
type: workflow
title: Repository Generation Lifecycle
description: How OpenWiki drives resumable repository wiki generation through the five durable operations begin, submit_plan, next_page, submit_page, and finish, backed by an ordered PageJob queue in openwiki/.run.json and source-fingerprint invalidation.
tags:
  [
    repository-generation,
    lifecycle,
    resumable,
    page-jobs,
    run-state,
    source-fingerprint,
    claims,
  ]
sources:
  - id: openwiki-source-6cb3236b8c1412a26d832fcf
    resource: repo://src/agent/repository-runner.ts
  - id: openwiki-source-69abc6f0f641147820a274bc
    resource: repo://src/agent/utils.ts
  - id: openwiki-source-9697823032111d36e2d4caa9
    resource: repo://src/agent/wiki-replacement.ts
  - id: openwiki-source-ed90c6fa13119927ecd82845
    resource: repo://src/generation/errors.ts
  - id: openwiki-source-1197594de038075f3570340c
    resource: repo://src/generation/page-jobs.ts
  - id: openwiki-source-7c5ecb56558cc061dab24f9d
    resource: repo://src/generation/repository-run.ts
  - id: openwiki-source-080c4525024a9b689e361cbb
    resource: repo://src/generation/run-state.ts
  - id: openwiki-source-58835b77ce38a0dd1fed8d09
    resource: repo://src/integrations/core/session-manager.ts
verified:
  - by: openwiki/0.4.0
    at: 2026-08-26T21:08:39.375Z
generated: { by: "openwiki/0.4.0", at: "2026-08-26T21:08:39.375Z" }
---

# Repository Generation Lifecycle

Repository generation is a resumable, checkpointed workflow that turns a Git
repository into a grounded OpenWiki. It is expressed as a small transport-neutral
core in `src/generation/` that owns durable state, and two thin drivers — a
native agent runner and a host/MCP adapter — that call the same five operations.
The core is the source of truth for ordering, durability, and failure semantics;
the drivers only supply models, prompts, and transport.

## The five-operation lifecycle

The whole workflow is exactly five operations, each a function in
`src/generation/repository-run.ts`:

- `beginRepositoryRun` — start a fresh durable run or reconstruct an interrupted
  one, or prove that a clean update needs no work.
- `submitRepositoryPlan` — validate, normalize, and durably install the ordered
  page queue, moving the run from `planning` to `generating`.
- `nextRepositoryPage` — read the first pending job without reserving or mutating
  it, or report queue completion.
- `submitRepositoryPage` — prove one page's Markdown and complete Claim set are
  durable, then mark that job complete.
- `finishRepositoryRun` — run deterministic deletion, indexing, provenance,
  Claims finalization, and metadata persistence, then remove the checkpoint.

The host adapter surfaces these under stable protocol names
(`openwiki_begin`, `openwiki_submit_plan`, `openwiki_next_page`,
`openwiki_submit_page`, `openwiki_finish`).

```mermaid
stateDiagram-v2
    [*] --> planning: begin fresh or resume
    planning --> planning: source drift clears plan
    planning --> generating: submit_plan installs queue
    generating --> generating: next_page then submit_page per job
    generating --> planning: source drift on finish
    generating --> done: finish with no pending job (skipped allowed)
    planning --> noop: clean update preflight
    noop --> [*]
    done --> [*]
```

Lifecycle phases and transitions of one repository-generation run. A run reaches
`done` once no job is `pending`; jobs that failed their worker and were skipped do
not block finish.

## Durable run state: openwiki/.run.json

A run's entire resumable state lives in a single JSON checkpoint,
`openwiki/.run.json`, whose basename and schema version are fixed constants. The
checkpoint carries the run's identity (`runId`, `mode`, `phase`), resolved
language, the pre-run page inventory (`initialPages`), the source fingerprint,
planning context, the stable actor, prior successful metadata, a pre-run content
snapshot, serialized wiki-preparation state, and — once installed — the ordered
`plan`.

The checkpoint is loaded and schema-validated on read; a malformed checkpoint
raises `invalid_state` rather than being silently discarded, so resumable work is
never thrown away by accident. Writes are atomic: state is written to a
per-process temporary file with an exclusive-create flag and then renamed over
the target. The checkpoint is removed idempotently only after successful
completion or an init rollback.

The in-memory `ActiveRepositoryRun` is only advanced after the next durable state
is written; every mutating operation writes `openwiki/.run.json` first and
replaces `run.state` afterward, so a crash never leaves memory ahead of disk.

## The durable ordered page queue

`submitRepositoryPlan` turns a proposed plan into a normalized `RepositoryRunPlan`
via `createRepositoryPlan`. Normalization canonicalizes and deduplicates page
paths, rejects reserved working pages, forbids a page being both generated and
deleted, and enforces mode-specific shape rules — init plans may not delete pages
and must include `/openwiki/quickstart.md`, and `/openwiki/quickstart.md` can
never be deleted. Each page becomes a `PageJob` with a fresh UUID `id` and
`status: "pending"`.

For update runs, the plan is augmented with jobs the planner omitted:
`addRequiredClaimIssueJobs` inserts reconciliation jobs for pages with unresolved
grounding issues, and `addRequiredRewriteJobs` inserts rewrite jobs for pages
that must change language. The queue is then deterministically sorted by code-unit
path order, with `/openwiki/quickstart.md` placed last so the navigation page is
generated after the domain pages it routes to.

The installed plan is the run's persisted ordered queue: jobs are consumed in
order, and completion is tracked per job. A duplicated `submit_plan` is tolerated
only if it describes the same semantic plan (compared while ignoring generated
job IDs and progress); a different plan against an already-installed queue is
rejected with `invalid_state`.

A `PageJob` progresses through three persisted statuses: `pending`, `skipped`, and
`complete`. `pending` is the only state `nextRepositoryPage` returns; `skipped`
marks a job whose worker failed without ever submitting, while `complete` marks a
durably proven page. `next_page` advances only over `pending` jobs, and `finish`
requires that none remain `pending`.

## Page completion is the durability boundary

`nextRepositoryPage` returns the first `pending` job together with whether the
target page already exists on disk and its current Claims — but it does not
reserve or mutate anything, so it is safe to call repeatedly.

`submitRepositoryPage` is where a page becomes durable, and it is strict about
ordering: only the current pending job may be submitted, an already-complete job
is idempotently acknowledged, and an unknown job id is `not_found`. Before
recording completion it requires the page's Markdown to be present and readable,
validates its front matter, reconciles the page's complete proposed Claim set
into the process-local Claims session, finalizes Claims, and proves durability
via `assertPageClaimsDurable`. That proof checks that a sidecar was persisted,
that its page version matches the current Markdown bytes, that a verification
event was projected into the page front matter, and that every expected Claim's
statement and evidence set match exactly. Only after all of this does it write a
new checkpoint marking the job `complete`.

Because per-job completion is persisted, page completion is the workflow's
durability boundary and recovery unit: once the run state is durable, already
completed pages are the recovery mechanism. An interrupted run resumes by simply
replaying `next_page`/`submit_page` for the remaining pending jobs rather than
restarting the whole wiki. A job that was `skipped` is durably recorded too, so
the next `begin` can reset it back to `pending` and reconsider the page.

## Skipped pages: failed workers do not abort the run

A page worker can fail without ever calling `submit_page` — the model may throw,
the worker may exit, or a non-correctable error may surface. Rather than aborting
the whole update, the native runner skips that single job and continues to the
next pending one. Before any model-owned authoring starts, `captureRepositoryPageSnapshot`
records the page's current Markdown and Claims sidecar for the current pending
job. On a failure that is not a correctable `submit_page` rejection, the runner
calls `skipRepositoryPage`, which restores the page to its pre-authoring
snapshot, rewrites or deletes its Claims sidecar to match, re-prepares the
process-local Claims runtime, records `interrupted` metadata, and durably marks
the job `skipped`. A deferred warning is emitted to the event stream so the
operator knows the page was skipped and will be reconsidered on the next update.

The skip path distinguishes three failure shapes inside `runPageAgent`. If the
worker already submitted before throwing, the page is complete and the error is
swallowed. If the failure was a fatal submission failure (any
`RepositoryRunError` whose code is not `invalid_input`), it is rethrown so the
durable invariants are protected. Otherwise the page is skipped via
`skipRepositoryPage` and the runner continues.

## Claim reconciliation on submit

`replacePageClaims` treats the submitted Claim set as the page's complete
replacement set. A proposal that reuses an existing id confirms or updates that
Claim; a new proposal that exactly matches an existing Claim confirms it; an
otherwise-new proposal is added; and any existing Claim not present in the
submission is retracted. Duplicate proposals and ids not owned by the page are
rejected as `invalid_input`, and every Claim must carry at least one evidence
resource. This is why callers should reuse ids for unchanged or revised Claims
and omit ids only for genuinely new ones.

## begin: fresh run, resume, and clean-update no-op

`beginRepositoryRun` first ensures code-mode repository setup, then reads
`openwiki/.run.json`. If a checkpoint exists, it resumes; otherwise it starts
fresh.

For a fresh **update**, Claims preflight runs before Git-status no-op detection:
if the working tree is clean _and_ there are zero grounding issues, `begin`
returns a `noop` view without creating any run. A clean Git status alone cannot
hide stale or unresolved grounding state.

For a fresh **init**, the existing wiki is first replaced with a blank target via
a recoverable transaction that backs up `openwiki/`, preserves user-owned
`INSTRUCTIONS.md`, and installs SIGINT/SIGTERM handlers that restore the backup on
cancellation. Writing the checkpoint and the `interrupted` metadata is the
durability point; only after both are durable is the init backup committed, so
from then on partial pages — not the backup — are the recovery mechanism. If the
fresh path fails before commit, an init rollback removes any written state and
restores the previous wiki, while a failed update never deletes a successfully
written checkpoint.

Resume validates that the caller owns the durable run: a mode mismatch, a
language change, or a different producer actor all raise `conflict`, forcing the
existing run to be resumed on its own terms before anything else changes.

## Resume on the same checkout and source-fingerprint invalidation

`createRepositorySourceFingerprint` hashes every model-visible repository source
input for the active plan — Git HEAD, tracked and untracked source files, and
porcelain status — while excluding generated OpenWiki state and ignored paths.
Git, stat, symlink, and read failures reject, because the fingerprint is a
correctness gate rather than a hint.

The fingerprint makes resume safe only on the same checkout. When `begin` resumes
and the current fingerprint differs from the checkpoint's, the whole plan is
invalidated: the phase is reset to `planning`, the new fingerprint is stored, and
`plan` is deleted from the state. Plan absence — not fingerprint equality — is the
durable signal that new planning context may replace the prior context.

When source has _not_ changed but the retained plan still contains `skipped`
jobs, resume resets those skipped jobs back to `pending` so the failed pages are
reconsidered on this resumed run rather than left behind. Skipped pages are only
kept durably across an interrupted run; the next successful resume re-opens them
for work. The reset is persisted together with any actor-metadata or
planning-context update before the in-memory state advances.

`finishRepositoryRun` guards the same drift at both ends of its deterministic
window: it re-checks the fingerprint before doing any finalization and again after
Claims are finalized, closing the check/use race so source cannot change midway.
Any drift resets the run to `planning`, clears the plan, and raises a `conflict`
telling the caller to `begin` and submit a replacement plan.

## finish: deterministic finalization

`finishRepositoryRun` refuses to run while any job is still `pending`, and requires
that every `skipped` job is accompanied by its original page snapshot. The native
runner collects these `skippedPageSnapshots` as it generates and passes them into
`finish`; if the snapshots do not line up one-to-one with the skipped jobs by id
and path, finish raises `invalid_state` before doing any work.

Once the queue has no pending jobs and source is stable, finish deletes pages
abandoned by a superseded plan (never touching `initialPages`), applies the
plan's explicit deletions, reconciles Claims sidecars for deleted pages, finalizes
wiki artifacts (indexes and provenance), restores each skipped page's snapshot
Markdown, and finalizes Claims with the skipped pages excluded from the
whole-repository durability proof (`assertRepositoryClaimsDurable`). It then
re-checks the source fingerprint to close the check/use race, and persists
completion metadata — `interrupted` when any page was skipped, otherwise
`complete` only if content changed — before, last of all, removing
`openwiki/.run.json`. The checkpoint is deleted last on purpose: every earlier
failure leaves the run resumable so `begin` can reconstruct and retry.

## One lifecycle, two drivers

Both entrypoints drive the identical durable core.

The **native runner** (`runNativeRepositoryGeneration`) begins the run with a
stable OpenWiki producer actor, then loops: it runs a bounded planning agent when
the phase is `planning`, runs one fresh non-delegating page worker per pending job
(each bounded to writing only its assigned page and calling `submit_page`), and
then calls `finish` with the collected skipped-page snapshots. A worker that
throws, exits without submitting, or fails non-correctably is skipped via
`skipRepositoryPage` and the runner proceeds to the next pending job; the run is
not aborted by a failed page worker. If `finish` reports the specific source-drift
invalidation `conflict`, the runner rebuilds context, re-begins, and replans
automatically. Workers reuse the supplied model but keep no repository-generation
state beyond the durable core.

The **host integration** (`HostSessionManager`) exposes the same five operations
as the OpenWiki MCP tools. It holds one active `ActiveRepositoryRun`, requires the
caller's `runId` to match before every operation, serializes operations with a
single-operation guard, and maps lifecycle `RepositoryRunError` codes onto stable
host-integration errors. Because both drivers call `beginRepositoryRun`,
`submitRepositoryPlan`, `nextRepositoryPage`, `submitRepositoryPage`, and
`finishRepositoryRun`, they share the exact same ordering, durability boundary,
and source-fingerprint invalidation semantics.

## Failure semantics

Lifecycle failures are reported with stable `RepositoryRunError` codes —
`invalid_input`, `invalid_state`, `conflict`, and `not_found` — that the host
adapter maps to protocol errors and the native runner uses to drive replanning.
Correctable input rejections (bad plan or bad Claim payload) are returned to
workers as failed tool results so their loop stays active, while `invalid_state`
and `conflict` protect the durable invariants: submit in phase order, submit only
the current pending job, and never finish over changed source.
