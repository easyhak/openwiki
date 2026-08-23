# OpenWiki Agent Wiki

This is an experimental, hand-authored mirror of the repository from a coding
agent's perspective. It is designed to answer: “What must I know, where is the
authoritative implementation, what else can this change break, and what is the
narrowest proof?”

Start with [quickstart.md](quickstart.md). The prose wiki covers the complete
top-level source and evaluation surface; `coverage/manifest.json` makes that
claim mechanically checkable. `knowledge/catalog.json` is the same knowledge
decomposed into retrievable behavior contracts, and `tools/context.mjs` renders
a task-specific packet from it.

This directory intentionally occupies the repository's canonical `openwiki/`
location for the retrieval experiment. It is the supported corpus for the
shipped read-only `openwiki_context` MCP tool, but catalog generation is not yet
part of normal OpenWiki runs. A later OpenWiki init may replace this hand-authored
test corpus; source code and tests remain authoritative.

Useful commands:

```sh
node openwiki/tools/validate.mjs
node openwiki/tools/context.mjs "change MCP finish Claims behavior"
node openwiki/tools/context.mjs "add a connector"
```
