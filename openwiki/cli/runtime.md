---
type: Agent interface guide
title: CLI parsing, startup, print mode, and TUI runtime
description: Command union, dispatch, mode selection, orchestration parity, events, and cancellation.
tags: [cli, tui, print, commands, cancellation]
---

# CLI parsing, startup, print mode, and TUI runtime

`src/cli/cli.tsx` installs the crash guard before parsing. Integrations and MCP
dispatch separately; standard commands conditionally load the private
environment, resolve startup guards, decide telemetry disclosure, and select a
specialized runner, print mode, or Ink application (`L39-L115`).

## Command and mode contract

`CliCommand` in `commands.ts` is the closed parsed union. Bare init/update
default to code mode; chat defaults personal. Conflicting modes or init/update
flags fail. Print mode requires actual work. Language is canonicalized during
parsing.

Code mode maps to process cwd and repository output; personal mode maps to the
private local wiki (`src/cli/run-mode.ts:L31-L55`). Non-TTY chat without a
message fails. Provider credentials are normally required before a
noninteractive run, except a clean printed update may no-op before provider
setup (`src/cli/startup.ts`).

## Print and interactive parity

Both paths must keep one telemetry wrapper around repository setup, code
connector augmentation, and `runOpenWikiAgent`. Print buffers only text events
for stdout and sends diagnostics/auth repair to stderr. The TUI preserves a
thread across turns, rotates on mode change/clear, throttles tool rendering, and
rejects callbacks from stale run IDs.

Ctrl-C restores Ink’s terminal before emitting SIGINT so an active init
replacement can own rollback; without an active run it exits 130
(`src/cli/process-interrupt.ts`).

## Changing the CLI

A new flag or command usually touches parser/help, `CliCommand`, startup guards,
dispatch/runner, print options, interactive options, telemetry eligibility, and
tests. New pre-agent work must live inside telemetry in both print and TUI
orchestration; current tests directly prove print ordering more strongly than
interactive parity.

Primary validation:

```sh
pnpm exec vitest run test/cli/commands.test.ts test/cli/startup.test.ts \
  test/cli/runners.test.ts test/cli/run-mode.test.ts \
  test/cli/process-interrupt.test.ts
```
