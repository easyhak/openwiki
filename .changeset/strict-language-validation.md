---
"openwiki": patch
---

fix: reject an unrecognized `--language` value instead of silently generating an English wiki

An unrecognized language (for example a language name like `Korean` instead of the BCP-47 code `ko`) now fails the command up front instead of printing a warning and falling back to English. Because a started run records the language it began with and resume refuses to change it, the previous fallback could persist the wrong language with no way to correct it short of deleting OpenWiki's own state. Pass a real BCP-47 code (`ko`, `zh-CN`, `pt-BR`) and rerun.
