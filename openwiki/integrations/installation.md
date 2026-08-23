---
type: Agent integration guide
title: Integration installation and ownership
description: Host registry, scoped paths, bundle receipts, transactional configuration edits, upgrades, and uninstall.
tags: [integration, install, codex, claude, receipts]
---

# Integration installation and ownership

The installer supports Codex and Claude Code at user or repository scope. A
registry owns host IDs, producer actors, skill/config destinations,
documentation links, and the default `openwiki mcp --host <target>` command
(`repo://src/integrations/install/registry.ts#L7-L78`).

## Containment and ownership

Project scope first resolves the Git top-level. Every destination must remain
inside the selected scope and no existing path component may be a symlink. Skill
bundles may contain only `SKILL.md`, `agents/`, and `references/`; symlinks and
special files are refused (`repo://src/integrations/install/install-paths.ts#L67-L145`,
`repo://src/integrations/install/skill-bundle.ts#L86-L163`).

A strict receipt proves ownership with package/version/target/MCP command and a
SHA-256 inventory of canonical bytes. Modified or unmanaged installations are
not overwritten unless force is explicit. An exact installation reconciles its
config idempotently.

## Transactional install and removal

Install stages and inventories the canonical bundle, writes its receipt, then
commits config and skill changes as one recoverable operation. Commit failure
restores both prior artifacts and cleans staging; incomplete rollback becomes an
aggregate error. Forced replacement retains a timestamped backup
(`repo://src/integrations/install/installer.ts#L144-L231`,
`repo://src/integrations/install/installer.ts#L366-L498`).

Uninstall removes only exact managed state. It restores config on pre-commit
failure and reports a retained cleanup backup if final deletion fails. JSON
edits preserve unrelated keys and require the exact managed entry shape. TOML
edits preserve every byte outside marker-delimited OpenWiki blocks and reject
unmanaged or modified owned tables. Config writes use atomic sibling rename and
preserve mode bits.

## Adding a host

Extending the host registry is only the start. The CLI parser/help, config
adapter, producer mapping, canonical skill portability, destinations, package
inventory, install/upgrade/uninstall, and dogfood tests all need the new target.

```sh
pnpm exec vitest run test/integrations/installer.test.ts \
  test/integrations/config-adapters.test.ts \
  test/integrations/skill.test.ts \
  test/integrations/package-contents.test.ts \
  test/cli/integrations-commands.test.ts \
  test/cli/integrations-runners.test.ts
```
