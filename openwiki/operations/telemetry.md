---
type: Agent operations guide
title: Anonymous telemetry and failure taxonomy
description: Exactly-once recording, privacy gates, identity, error classification, secure local tee, and blind spots.
tags: [telemetry, privacy, failures, diagnostics]
---

# Anonymous telemetry and failure taxonomy

Only init/update produce `openwiki_run`; chat is omitted. Init includes setup
dimensions such as mode/provider/connectors, while both init and update carry
outcome and normalized failure classification.

## Exactly-once boundary

`withRunTelemetry` encloses setup, connectors, and agent execution. It records
success/no-op or anonymized failure exactly once and then rethrows the original
error (`src/telemetry/with-run-telemetry.ts:L39-L84`). Event construction is
closed: no raw messages, repository facts, paths, prompts, or error text.
Failures use normalized class/detail/owner/stage/status, and PostHog person
profiles are disabled.

## Privacy and delivery

`OPENWIKI_TELEMETRY_DISABLED` or `DO_NOT_TRACK` opts out. CI uses a sentinel
identity and suppresses the first-run notice. Human identity is a random
owner-only persisted UUID, never derived from machine/repository data.

Capture uses bounded requests/shutdown and swallows telemetry failures.
`--telemetry-file` writes the exact local record through an unpredictable
owner-only sibling and atomic rename to avoid symlink clobbering or permissive
shared-directory modes.

## Failure taxonomy

Errors are unwrapped cycle-safely with bounded depth. First-origin ownership
tags win. Provider auth/quota and local DNS/refusal usually belong to the
environment; finalize-stage filesystem failures belong to OpenWiki.

Known observability gaps are part of the change contract: some finalizer details
and run build details are currently not in telemetry’s allowlists, so their
class/stage survive while the detail is dropped. Adding a lifecycle operation
must update the throw-site tag, allowlist/owner rules, tests, and disclosure if
collection scope changes.

Proof: `test/telemetry/` plus `test/cli/telemetry-cli.test.ts`.

```sh
pnpm exec vitest run test/telemetry test/cli/telemetry-cli.test.ts
```
