---
type: Agent subsystem guide
title: Authentication, credential storage, and onboarding
description: Connector OAuth, model-provider auth, environment persistence, setup gates, and security boundaries.
tags: [auth, oauth, credentials, onboarding, security]
---

# Authentication, credential storage, and onboarding

OpenWiki authenticates two independent surfaces: external knowledge connectors
and the model used for agent runs. They share private environment persistence,
but connector OAuth completion does not satisfy model-provider setup and vice
versa.

## Connector OAuth

The provider registry owns endpoints, scopes, client-auth style, and destination
environment keys for Gmail, Notion, Slack, and X. The browser flow uses
Authorization Code with PKCE and a random state value. It prefers a loopback
callback on `127.0.0.1`, supports a manually pasted redirect for remote/headless
use, exchanges the code, and persists tokens only after validation
(`repo://src/auth/oauth.ts#L47-L105`).

OAuth discovery validates protected-resource and authorization-server URLs
before every fetch and redirect. Notion may use dynamic client registration;
Slack/Gmail require preconfigured app credentials. Access tokens refresh lazily
with expiry skew. External-CLI model providers invoke their owning CLI with a
timeout and keep the credential in that CLI's store
(`repo://src/auth/oauth-discovery.ts#L82-L175`).

## Private environment store

Process environment wins over saved values: loading `~/.openwiki/.env` never
overwrites an existing variable. Saves are serialized within the process,
rewrite through a private temporary sibling, atomically rename, and enforce
owner-only intent (`0700` home, `0600` file; best-effort ACL on Windows).
Managed-key ordering makes updates deterministic
(`repo://src/config/env.ts#L298-L370`).

Secret values must not enter connector config, committed repository files,
telemetry, or diagnostics. Connector configs name environment variables.
Redaction remains defense in depth and is not permission to log secrets.

## Setup gate

First-run readiness requires both provider configuration and mode-specific
onboarding completion. The credential wizard derives an update map through a
pure function; the caller owns persistence. Onboarding state stores mode,
template/source instances, schedules, power settings, and completion timestamp,
while the wiki goal lives in a separate private `INSTRUCTIONS.md`.

Provider readiness varies: OAuth needs a usable token, API-key providers need a
key, keyless/SDK providers need required project/region configuration, and all
paths need a selected model plus any required LangSmith step.

## Change impact and proof

Changing auth affects provider registry, discovery/redirect validation, refresh,
environment persistence, wizard derivation, startup guards, and redaction. Never
test only the happy browser redirect.

```sh
pnpm exec vitest run test/auth test/config/env.test.ts \
  test/config/env-behavior.test.ts test/setup test/cli/startup.test.ts
```
