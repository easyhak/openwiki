---
type: Agent platform reference
title: Runtime and portability layer
description: Node/ESM assumptions, filesystem portability, language handling, diagnostics, and Windows behavior.
tags: [node, esm, windows, filesystem, language, diagnostics]
---

# Runtime and portability layer

OpenWiki targets Node 22 or newer and compiles as strict NodeNext ESM. The
visualizer browser entry is compiled separately with DOM libraries; the rest of
the project targets ES2022 without DOM globals (`package.json`, `tsconfig.json`,
`tsconfig.client.json`). Imports in TypeScript use emitted `.js` extensions.

## Shared platform services

- `diagnostics.ts` centralizes secret redaction, friendly provider errors, and
  authentication-error classification.
- `fs-errors.ts` identifies not-found and expected snapshot-race errors so tree
  scans can distinguish benign disappearance from corruption.
- `language.ts` canonicalizes supported output language using built-in `Intl`
  APIs and returns a warning/fallback for invalid values.
- `utils.ts` normalizes local paths, including literal leading tildes.
- `windows-acl.ts` applies current-user/SYSTEM ACL intent with `icacls` and
  fails open when platform tooling is unavailable.

## Portability invariants

Path comparisons that protect a boundary must normalize separators and resolve
physical containment rather than compare raw strings. POSIX virtual wiki paths
and native filesystem paths are distinct representations; do not casually pass
one where the other is expected.

The Windows ACL helper is deliberately best-effort because access-control tool
failure must not make ordinary OpenWiki use impossible. By contrast, evidence,
Claims-store, installer, and repository-root containment failures are hard
errors because continuing could cross a security boundary.

## Proof and validation

Primary tests are `test/platform/`. Path-sensitive changes should additionally
run the owning backend/store tests. CI runs the full suite on Node 22 and 24 and
a small Windows portability subset for skills and environment behavior.

```sh
pnpm exec vitest run test/platform test/config/openwiki-home.test.ts
pnpm run typecheck
```

When adding a browser-only API, keep it behind the visualizer client build so
the Node runtime does not accidentally acquire DOM type assumptions.
