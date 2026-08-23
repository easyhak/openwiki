---
type: Agent change playbook
title: Common change recipes
description: Intent-to-files, invariants, tests, and validation for frequent OpenWiki engineering tasks.
tags: [playbook, change-impact, tests, extension]
---

# Common change recipes

Use these as starting sets, then follow actual imports/callers. They are bounded
impact hypotheses, not permission to skip source inspection.

## Add or change a model provider

- Start: `src/config/constants.ts`, provider resolution/model construction in
  `src/agent/index.ts`, credential setup.
- Preserve: provider normalization, retry/token semantics, secret redaction,
  selectable-model behavior, environment diagnostics.
- Test: model construction/resolution, provider-specific auth, config registry.
- Validate: owning tests + typecheck; use live tests only when credentials exist.

## Add a connector

- Start: `src/connectors/registry.ts`, `types.ts`, the source adapter, onboarding.
- Preserve: instance IDs, config/state/raw ownership, sanitized failures,
  connector-specific auth, scheduled targeting.
- Test: adapter, registry/config, raw tools, ingestion orchestration, onboarding.

## Add a CLI command or option

- Start: `src/cli/commands.ts` union/parser/help, `cli.tsx` dispatch, runner.
- Preserve: TTY/print behavior, stdout versus stderr contract, telemetry flag
  names without values, stable exit code.
- Test: parser, startup, runner, diagnostics; Ink components only when rendered
  state changes.

## Change wiki authoring or finalization

- Start: `src/agent/index.ts`, middleware/finalizer, OKF, Claims runtime.
- Preserve: one run timestamp, middleware order, provenance/source projection,
  interrupted metadata, transactional init, best-effort page-local recovery.
- Test: finalizer + Claims lifecycle + replacement/no-op as applicable.

## Change Claims

- Start: core types/mutations, code session/runtime/store, evidence resolver.
- Preserve: atomic operations, globally unique ownership, dirty-only
  persistence, evidence recheck, sidecar/Markdown hash agreement, typed access.
- Test: core + owning code brain + agent/MCP lifecycle when completion changes.

## Change coding-agent integration

- Start: protocol, session manager, MCP server, host registry/installer.
- Preserve: bounded transport errors, one active serialized session,
  canonical repository root, retry before commit, transactional init,
  receipted/atomic installation.
- Test: protocol, session manager, MCP server/stdio, installer/config adapters,
  package contents.

## Change configuration or credentials

- Start: constants/env, provider config, auth/setup persistence.
- Preserve: shell precedence, non-secret diagnostics, at-rest permissions,
  token refresh, no secret values in logs or telemetry.
- Test: config env behavior, credentials persistence/UI, auth provider flow,
  redaction.

## Change visualizer or Mermaid behavior

- Start: visualization graph/server/client or Mermaid validation/fences.
- Preserve: loopback-only serving, path containment, static/live parity,
  graceful diagram degradation, browser asset packaging.
- Test: graph/server/static export or Mermaid suite; build when assets change.
