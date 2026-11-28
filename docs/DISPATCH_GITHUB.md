# GitHub dispatch (owner slice)

Owner-only automation for GitHub issues in a configured repository: poll for
`/ds-agent fix|status|cancel`, optionally admit `@`-mentions when explicitly
configured, run a bounded implementer that opens **peanut/** PRs only, and
expose local queue status/cancel. This slice does **not** merge to `main`, post
issue comments, or claim a live product RSI publish loop.

## Enablement

- `pnpm ds-agent serve --github-dispatch`, or
- `DS_AGENT_GITHUB_DISPATCH=1`, or
- presence of `github-dispatch.json` under `DS_AGENT_HOME` with GitHub and/or
  RSI enabled.

Serve starts the dispatch loop after channel loops; shutdown aborts and waits
for the dispatch loop like other serve subsystems.

## Polling and commands

- Default poll interval **60s**, floor **15s** (`pollIntervalMs`).
- Authorized actors (default includes `LofiSu`) may use:
  - `/ds-agent fix` — enqueue isolated implementer work (when implementer is configured).
  - `/ds-agent status` — local store view via CLI (`ds-agent dispatch status`).
  - `/ds-agent cancel <jobId>` — local queue only (`ds-agent dispatch cancel`); **no GitHub comments**.
- Admission is fail-closed: wrong repo, bots, outsiders, PR threads, fenced or quoted command regions are rejected.

## Optional mention handles (default off)

- `mentionHandles` is **off by default**. Unconfigured `@ds-agent` is **not** a command.
- When set, each handle must verify against `gh api user` (owner-gh) or the GitHub App slug (github-app mode).
- `@ds-agent` and unrelated public handles are rejected.

## Webhook helper

`webhook-verify.ts` implements signature verification for future use. **Webhooks are not deployed** in this slice; production path is `gh api` polling only.

## Execution policy

The production loop polls and queues authorized GitHub commands and runs the
RSI scheduler. Coding and candidate tests require a separately isolated runner.
The built-in runner fails closed without executing code or publishing a PR.

## What this slice does not claim

- No live GitHub poll verification in CI (tests use fixtures and mocks).
- No automatic issue comments on success/failure.
- No merge to `main` or force-push.
- No real-channel acceptance or product RSI publish.
