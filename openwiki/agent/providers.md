---
type: Agent extension guide
title: Model provider and transport layer
description: Provider registry, credential requirements, model resolution, SDK dispatch, availability, and streaming controls.
tags: [providers, models, credentials, streaming, retries]
---

# Model provider and transport layer

The provider union and declarative registry in `src/config/constants.ts` are the
canonical inventory. Providers declare selectable models and one of four auth
methods: API key, OAuth, external CLI, or AWS SDK delegation. `createModel` in
`src/agent/index.ts` is the imperative transport seam for SDK-specific behavior.

## Resolution sequence

Provider choice prefers explicit `OPENWIKI_PROVIDER`, then detected credential
variables, then OpenAI (`src/config/constants.ts:L803-L850`). Startup validates
required credentials/base URL/secret/region, refreshes ChatGPT OAuth when
needed, resolves the model, probes availability, and resolves retry/output/idle
settings before constructing the graph (`src/agent/index.ts:L356-L444`).

An explicit run model wins over environment and provider default. Invalid IDs
fail; a known provider mismatch warns but proceeds because gateways may serve
custom models. Availability `unavailable` fails, while `unknown` is advisory—the
first provider request remains the ultimate compatibility check.

## Transport dispatch

- Anthropic, OpenRouter, and Bedrock use dedicated clients.
- Gemini uses native Google chat.
- Gemini Enterprise selects Gemini, Claude, or OpenAI-compatible Vertex
  surfaces by model family.
- Remaining compatible providers use `ChatOpenAI` configuration.
- ChatGPT OAuth forces Responses streaming, disables storage, and supplies
  account/origin headers through its specialized fetch.

OpenAI-compatible request streaming and LangGraph message streaming are
separate controls. Bedrock alone receives the stream-idle watchdog.

## Adding a provider

Audit the provider type, selectable order, registry metadata, credentials/setup
UI, model factory, availability probe, request transformation, diagnostic
redaction, and model-option tests. Registry-only work is sufficient only when an
existing compatible transport and auth flow truly cover the new provider.

Primary proof:

- `test/agent/create-model.test.ts`
- `test/agent/model-resolution.test.ts`
- provider-specific Bedrock, Vertex/Gemini, ChatGPT OAuth tests
- `test/openai-compatible-responses.test.ts`
- `test/config/copilot-provider.test.ts`

Run the owning provider test with create-model/model-resolution and typecheck.
