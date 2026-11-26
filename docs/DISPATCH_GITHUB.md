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

## Implementer

`github.implementer` in owner config:

| Value | Behavior |
|-------|----------|
| `"claude"` | Isolated clone → pre/post holdout → Claude Code → diff-path policy → peanut branch PR via `FeaturePrPublisher`. |
| `"none"` / omitted | Fail-closed: fix/RSI implement jobs error without publish. |

High-risk `rsi_proposal` jobs complete without calling implementer hooks.

### Publish acknowledgment

The implementer calls `prepare()` then `publish(input, binding)` on the host.
That is host-side acknowledgment of the exact commit/branch/metadata before push
and `gh pr create`. A human reviews and merges the PR; this PR never merges to
`main`.

Isolated dispatch workspaces are not LocalEnv worker sandboxes. The implementer
omits `FeaturePrPublisher.assertCredentialsHidden` and relies on holdout,
implementer diff-path policy, and the publisher’s credential path scan (same as
Runtime workers for risky paths in the commit tree).

## RSI scheduler hook (#183)

This slice lands GitHub poll, admission, queue, implementer, holdout, and serve
wiring. It does **not** ship `rsi.ts` ingest/scheduler. `serve-loop` exposes an
optional `runRsiTick` callback; after #183 merges, a follow-up can pass
`runRsiSchedulerTick` from `dispatch-integration` without changing Runtime.

## What this slice does not claim

- No live GitHub poll verification in CI (tests use fixtures and mocks).
- No automatic issue comments on success/failure.
- No merge to `main` or force-push.
- No real-channel acceptance or product RSI publish.
