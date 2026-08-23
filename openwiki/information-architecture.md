# Information architecture and coverage contract

This wiki is organized around runtime ownership and coding tasks, not the source
directory tree. The tree below is the completeness contract; every canonical
domain page explains ownership, flow, invariants, failures, extension seams,
primary source, proof tests, and narrow validation for its scope.

```text
openwiki/
├── README.md
├── quickstart.md
├── repository-map.md
├── knowledge-model.md
├── information-architecture.md
├── coverage/
│   └── manifest.json
├── system/
│   ├── architecture.md
│   ├── run-lifecycle.md
│   ├── configuration-and-state.md
│   └── security-and-failures.md
├── agent/
│   ├── runtime.md
│   ├── providers.md
│   └── authoring-pipeline.md
├── cli/
│   └── runtime.md
├── claims/
│   ├── model-and-runtime.md
│   └── evidence-and-persistence.md
├── integrations/
│   ├── host-lifecycle.md
│   ├── context-retrieval.md
│   └── installation.md
├── knowledge/
│   ├── okf.md
│   └── catalog.json
├── data/
│   ├── connectors.md
│   └── ingestion.md
├── identity/
│   └── auth-and-credentials.md
├── operations/
│   ├── scheduling.md
│   ├── telemetry.md
│   └── visualization.md
├── platform/
│   └── runtime-and-portability.md
├── development/
│   └── build-release-and-packaging.md
├── quality/
│   ├── testing.md
│   └── evals.md
├── playbooks/
│   └── change-recipes.md
├── context/
│   └── openwiki-context-v2.md
├── examples/
│   └── strict-claims-context.md
└── tools/
    ├── context.mjs
    └── validate.mjs
```

## Canonical domain ownership

| Domain                    | Canonical pages                                | Source ownership                                              |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| Persisted run boundary    | `system/run-lifecycle.md`                      | `src/agent/index.ts`, replacement, metadata, checkpoints      |
| Agent graph and authoring | `agent/`                                       | graph construction, prompts, backend, middleware, QA          |
| User command surface      | `cli/runtime.md`                               | parsing, startup, TUI, print runners, diagnostics             |
| Grounding                 | `claims/`                                      | Claim model, tools, preflight, store, evidence resolution     |
| Host embedding            | `integrations/`                                | MCP protocol/session, installer, and context retrieval        |
| Wiki representation       | `knowledge/okf.md`                             | frontmatter, provenance, indexes, verification projection     |
| External knowledge        | `data/`                                        | connector registry/runtime, source adapters, ingestion        |
| Identity                  | `identity/auth-and-credentials.md`             | OAuth, external CLI auth, environment persistence, onboarding |
| Operations                | `operations/`                                  | schedules, telemetry, visualization, Mermaid degradation      |
| Shared boundaries         | `platform/`, `system/security-and-failures.md` | diagnostics, language, filesystem, ignore, containment        |
| Engineering loop          | `development/`, `quality/`                     | build/package/release, tests, LEDGER, DeepSWE                 |

## Completeness rules

`coverage/manifest.json` maps every top-level `src/` directory, relevant root
module, evaluation system, integration bundle, and build script to at least one
canonical page and focused test surface. `knowledge/catalog.json` decomposes
the same map into task-rankable behavior contracts. `tools/validate.mjs` rejects
missing domains, missing pages or tests, invalid evidence, unknown contract
relationships, and broken local links.

Completeness does not mean documenting every helper. It means every substantial
component and cross-system workflow has a canonical home from which an agent
can reach its implementation, proof, and adjacent risks without broad search.
