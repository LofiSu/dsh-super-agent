# Upstream source

This directory vendors [pstack](https://github.com/cursor/plugins/tree/b7b93c36be9bcc36a74db438e0fd385d660bc559/pstack) from Cursor's plugins repository at commit `b7b93c36be9bcc36a74db438e0fd385d660bc559`. Only incidental whitespace was normalized. See LICENSE for the original MIT terms.

The ds-agent host adapters are in `src/env/skills.ts` and `src/harness/prompts.ts`. The repository host instructions are in `.agents/skills/pstack` and `.claude/skills/pstack`. Upstream automation definitions and scripts are retained as source and are not registered as jobs or invoked during installation.
