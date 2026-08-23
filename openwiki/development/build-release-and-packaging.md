---
type: Agent development runbook
title: Build, release, and package integrity
description: Compilation, generated assets, package inventory, release stamping, and CI gates.
tags: [build, release, packaging, ci, npm]
---

# Build, release, and package integrity

## Build products

`pnpm run build` compiles the Node runtime, separately compiles the browser
visualizer client, and copies `src/visualize/styles.css` because TypeScript does
not emit CSS. `prebuild` removes `dist/`; `postbuild` makes the CLI executable.
The package binary is `dist/cli/cli.js`.

Published content is allowlisted by `package.json`: compiled `dist`, the
canonical `integrations` bundle, `skills`, README, and license. The host
integration package test uses `npm pack --dry-run --json` to prove every
canonical skill file is present and generated installation state, staging,
fixtures, and local absolute paths are absent.

## Release channel and publishing

Committed builds are `community`. The release-only
`scripts/stamp-build-channel.cjs` recognizes only `community` and `official`,
rewrites exactly one assignment, and falls back to community for unknown input.
The upstream GitHub release job stamps official during the publish path, uses
Changesets for version PRs/publishing, and uses npm OIDC trusted publishing with
provenance. Fork release jobs must opt in and remain community builds.

## CI gates

The checks workflow independently runs formatting, lint, typecheck/build/CLI
smoke, tests on supported Node versions, Windows portability tests, and a
high/critical vulnerability scan. Pins on actions and release npm tooling are
supply-chain controls; do not loosen them as incidental cleanup.

## Change recipes

- **New runtime source:** ensure it is included by the Node tsconfig and emitted
  import paths remain valid.
- **New browser asset:** add it to the explicit copy script and its tests.
- **New package artifact:** update the package allowlist and package inventory
  tests; verify no local state enters the tarball.
- **Release behavior:** test stamping against temporary files; never mutate the
  committed channel in ordinary builds.
- **Integration skill changes:** update `integrations/openwiki/` as the
  canonical shipped bundle and run package/install tests.

Focused verification:

```sh
pnpm run typecheck
pnpm run build
pnpm exec vitest run test/copy-visualize-assets.test.ts \
  test/stamp-build-channel.test.ts \
  test/integrations/package-contents.test.ts
```
