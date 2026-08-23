---
type: Agent security guide
title: Trust boundaries, failure ownership, and recovery
description: Security-sensitive paths, redaction, containment, transaction boundaries, and failure classification.
tags: [security, failures, recovery, redaction, containment]
---

# Trust boundaries, failure ownership, and recovery

The model, repository contents, connector responses, provider errors, and MCP
payloads are all potentially untrusted. Security is enforced in deterministic
code around the model rather than through prompt instructions alone.

## Trust boundaries

| Boundary                 | Guarantee                                                                          | Primary implementation                                           |
| ------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Repository read boundary | `.openwikiignore` hides excluded paths and restricts shell execution               | `src/agent/openwiki-ignore.ts`, `src/agent/docs-only-backend.ts` |
| Authoring boundary       | Non-chat repository writes stay below `openwiki/`                                  | `src/agent/docs-only-backend.ts`                                 |
| Claims ownership         | Generic tools cannot read/write `.claims`; typed tools own mutations               | backend + `src/claims/brains/code/tools.ts`                      |
| Evidence containment     | `repo://` resources resolve inside the canonical repository and honor ignore rules | `src/claims/evidence/repository/`                                |
| Secret display boundary  | Diagnostic text and secret-like object keys are redacted centrally                 | `src/platform/diagnostics.ts:L22-L92`                            |
| Host root boundary       | MCP authoring requires an absolute canonical Git top-level and rejects broad roots | `src/integrations/core/repository-root.ts`                       |
| Installation boundary    | Staged/receipted host skill installation refuses unsafe or unmanaged replacement   | `src/integrations/install/`                                      |
| Private local state      | OpenWiki home uses owner-only permissions/ACL intent                               | `src/config/openwiki-home.ts`, `src/platform/windows-acl.ts`     |

Path spelling is canonicalized before ignore and confinement checks. This is a
security invariant: `./`, `..`, alternate separators, symlinks, or case changes
must not bypass a rule. While ignore rules are active, arbitrary shell commands
are unavailable because static analysis cannot prove they will not read an
excluded path.

## Failure ownership

Agent failures carry a stage (`config`, `build`, `run`, `finalize`) and often a
class/detail. The telemetry boundary records the classified outcome once and
rethrows; the CLI remains responsible for user-facing diagnostics. Unknown MCP
exceptions are converted to a generic transport failure while bounded
`HostIntegrationError` messages may cross the boundary.

| Failure point                         | Durable result                                         | Recovery                             |
| ------------------------------------- | ------------------------------------------------------ | ------------------------------------ |
| Provider/config before authoring      | No wiki mutation                                       | Correct config and rerun             |
| Agent stream after partial writes     | Partial wiki retained; metadata `interrupted`          | Update reruns against diffable state |
| Repository init before commit         | Previous wiki restored                                 | Fix cause and rerun init             |
| Init rollback also fails              | `AggregateError` contains original and rollback errors | Manual filesystem recovery           |
| Claims page-local recoverable failure | Warning; unsafe Claim/verification state not advanced  | Reconcile or fix persistence         |
| Host finish before commit             | Active session retained                                | Correct state and retry same run ID  |
| Connector source failure              | Recorded per source; other ingestion may continue      | Retry affected source                |
| Telemetry/ACL best-effort failure     | Core operation continues                               | Diagnose operationally if required   |

## Redaction rule

Any new path that displays, logs, persists, or transports provider/MCP error
data must call the shared sanitizer or recursively apply the shared secret-key
predicate. Never add a private regex at a call site; extend
`SECRET_KEY_PATTERN_SOURCE` and its central tests.

## Focused proof

- Backend and ignore: `test/agent/docs-only-backend.test.ts`,
  `test/agent/openwiki-ignore.test.ts`
- Redaction: `test/platform/diagnostics.test.ts`,
  `test/agent/redaction.test.ts`, `test/agent/stream-redaction.test.ts`
- Init transaction: `test/agent/wiki-replacement.test.ts`,
  `test/agent/claims-run-lifecycle.test.ts`
- Host errors/root: `test/integrations/repository-root.test.ts`,
  `test/integrations/mcp-server.test.ts`
- Installer safety: `test/integrations/installer.test.ts`

For a security-sensitive change, run the narrow owning tests plus
`pnpm run lint:check` and inspect the exact negative cases; a happy-path build is
not sufficient proof.
