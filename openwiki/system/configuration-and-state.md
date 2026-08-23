---
type: Agent operations reference
title: Configuration, persistence, and state ownership
description: Environment precedence, OpenWiki home layout, repository state, connector state, and checkpoints.
tags: [configuration, environment, persistence, state]
---

# Configuration, persistence, and state ownership

OpenWiki state is split between user-level private state and repository-owned
wiki state. Confusing the two is a common source of unsafe changes.

## User-level state

`src/config/openwiki-home.ts` resolves the OpenWiki home once at module load. It
defaults to `~/.openwiki`; `OPENWIKI_CONFIG_DIR` selects a different absolute
home and expands `~`/`~/...` explicitly.

| Location                | Owner and contents                                 |
| ----------------------- | -------------------------------------------------- |
| `.env`                  | Saved provider settings, credentials, OAuth tokens |
| `wiki/`                 | Personal knowledge wiki                            |
| `connectors/<id>/`      | Config, state, raw acquisition files, logs         |
| `conversation_history/` | Deep-agent history offload                         |
| `skills/`               | Synchronized bundled/user skills                   |

Home and connector directories are created with owner-only POSIX intent and a
best-effort Windows ACL. Connector IDs are allowlisted and raw paths are
resolved with containment checks (`src/config/openwiki-home.ts:L73-L117`).

`loadOpenWikiEnv` reads saved values but never overwrites an already-set process
environment value, so shell exports win. `MANAGED_ENV_KEYS` is the ordered
registry used for persistence, diagnostics, and debug visibility. Adding a read
environment variable should update that registry and decide explicitly whether
the value is secret-bearing.

## Repository-owned state

| Location                                | Meaning                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `openwiki/**/*.md`                      | User-owned generated knowledge                           |
| `openwiki/.claims/`                     | Implementation-owned per-page Claim sidecars             |
| `openwiki/.last-update.json`            | Last run status, model, language, and freshness baseline |
| `.github/workflows/openwiki-update.yml` | Generated scheduled update workflow                      |
| `AGENTS.md` / `CLAUDE.md` blocks        | Generated coding-agent retrieval guidance                |

Generic authoring tools may edit Markdown but must not write Claims sidecars or
run metadata. Repository init temporarily moves the owned wiki state behind a
replacement transaction; update works in place and records interrupted metadata
if completion fails.

## Ephemeral and checkpoint state

Chat uses the persistent private SQLite checkpointer so a thread can continue
across turns; init/update use an in-memory checkpointer. The run locks down
persistent checkpoint permissions after streaming and prunes older chat history
for the active namespace. `_plan.md` and `_skeleton.md` are workflow control
files removed during finalization; they are never durable wiki concepts.

## Configuration change checklist

1. Add or modify the canonical constant/resolver in `src/config/`.
2. Preserve shell-over-file precedence and avoid logging secret values.
3. Update credential/onboarding persistence only if users should save it.
4. Check CLI parsing and provider construction callers.
5. Add configuration, environment-behavior, and integration tests.

Focused proof surfaces:

- `test/config/env.test.ts`
- `test/config/env-behavior.test.ts`
- `test/config/openwiki-home.test.ts`
- `test/agent/checkpoint-policy.test.ts`
- `test/agent/checkpoint-pruning.test.ts`
- `test/agent/run-metadata.test.ts`

Run `pnpm exec vitest run test/config test/agent/checkpoint-policy.test.ts test/agent/run-metadata.test.ts`
for changes spanning environment and persisted run state.
