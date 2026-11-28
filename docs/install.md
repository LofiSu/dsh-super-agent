---
layout: default
title: Install and run
lang: en
nav: install
alt: /zh/install/
description: "Install lofibot and run the live demo. Node.js 22, pnpm, and an OpenAI-compatible model."
---

# Install and run

Node.js 22 or newer. See `engines` in [package.json]({{ site.repository_url }}/blob/main/package.json). The store uses `node:sqlite`. Install [pnpm](https://pnpm.io/).

```bash
git clone https://github.com/LofiSu/LofiBot.git
cd LofiBot
pnpm install
```

This repository is source-only for now: it is not published to npm, so there is
no `npm install -g lofibot` from the registry. Day to day, run the CLI in the
checkout with `pnpm lofibot ...`.

The package does build. `pnpm build` emits `dist/` and the `bin.lofibot` entry
(`./dist/cli/main.js`), so a packed tarball runs without `tsx`. `lofibot
--version` prints the package version. To smoke a local pack/install without a
registry, see [docs/RELEASE.md]({{ site.repository_url }}/blob/main/docs/RELEASE.md)
and run `pnpm tsx scripts/package-smoke.ts`.

`pnpm test` and `pnpm demo` both need a live OpenAI-compatible model. MockModel is not used on that path. `pnpm demo:local` is an in-memory fixture smoke check. It is not the acceptance path.

Set `LOFIBOT_API_BASE`, `LOFIBOT_API_KEY`, and `LOFIBOT_API_MODEL` before `pnpm test`. If any of the three is missing, the `test` script fills a local Magpie default: base `http://127.0.0.1:3425/v1`, key `magpie`, model `workbuddy/deepseek-v4.1-flash`. Without that gateway, the tests cannot reach a model. A provider key alone, such as `DEEPSEEK_API_KEY`, does not replace those defaults. The script sets `LOFIBOT_API_BASE` and `LOFIBOT_API_KEY` itself, so the preset path never sees the lone key.

`pnpm demo` and `pnpm lofibot chat` do not apply that Magpie default. For those, set both `LOFIBOT_API_BASE` and `LOFIBOT_API_KEY`, or one provider key. Setting only one of that pair exits with an error. Omit `LOFIBOT_API_MODEL` on the pair and the client sends `deepseek-chat`. `DEEPSEEK_API_KEY` alone defaults to `deepseek-flash`.

```bash
export LOFIBOT_API_BASE=https://api.deepseek.com
export LOFIBOT_API_KEY=sk-...
export LOFIBOT_API_MODEL=deepseek-flash
pnpm test
```

`pnpm demo` uses real channels only. It creates and reads real GitHub issues, and posts real issue comments through `gh`. There is no fake IM or GitHub fallback. Log in with `gh auth login`, and set `LOFIBOT_GH_REPO` to a repository this `gh` login can write, before the demo. Unset, the demo uses `LofiSu/LofiBot`.

```bash
gh auth login
export LOFIBOT_GH_REPO=your-account/your-writable-repo
pnpm demo
pnpm lofibot chat "fix the login timeout"
```

`LOFIBOT_API_BASE` can be any OpenAI-compatible URL. A local [Magpie](https://github.com/yetone/magpie) gateway is fine. Use the gateway token as the key, and Magpie's model id.

```bash
export LOFIBOT_API_BASE=http://127.0.0.1:3425/v1
export LOFIBOT_API_KEY=magpie
export LOFIBOT_API_MODEL=deepseek/deepseek-flash
export LOFIBOT_GH_REPO=your-account/your-writable-repo
pnpm demo
```

One model for the process. A small model fits the Router and Watchdog. A stronger one fits the Worker.

State lives in `LOFIBOT_HOME`, or in `./.lofibot` (SQLite).

```bash
pnpm lofibot tasks
pnpm lofibot status
pnpm lofibot metrics
```

Runtime always constructs sharded routers, the Worker mesh, long-term memory, the lifecycle bus, and A2A. There is no extension opt-in flag. Configure them with `LOFIBOT_SHARDS`, `LOFIBOT_MESH_CAPACITY`, and `LOFIBOT_INSTANCE_ID`; see [docs/MODULES.md]({{ site.repository_url }}/blob/main/docs/MODULES.md).

Worker `bash` requires `sandbox-exec` on macOS or `bwrap` on Linux; a missing wrapper is a hard error, and CI installs bubblewrap.

Closing those issues is best-effort. Each scenario calls `closeGithubIssues` only after its main work. A failed close is ignored, so the issue stays open and the demo does not fail for that. A throw, or a return before that call, also leaves issues open: a later `createIssue` can fail after earlier ones exist, the watchdog scenario returns when the issue has no trigger, and the spill scenario returns when a trigger is missing. `LOFIBOT_GH_KEEP=1` skips the close on purpose. After a run, look through the repo for open issues labeled `lofibot-demo`.

Feishu setup is in the repo: [docs/REAL_CHANNELS.md]({{ site.repository_url }}/blob/main/docs/REAL_CHANNELS.md).

## Upgrading an existing checkout

The CLI is now `lofibot`, and project environment variables use the `LOFIBOT_` prefix. Update scripts, service definitions, and bot mentions to use `@lofibot`. The default state directory is `./.lofibot`. Rename and unset old variables before starting LofiBot. Verify the existing actor and group allowlists, required sandbox dimensions, and read isolation under their new names.

Stop the old process and back up its database using `pnpm ds-agent backup --out /absolute/path/lofibot-backup.db` from the old checkout. Restore that snapshot with `pnpm lofibot restore /absolute/path/lofibot-backup.db` from the new checkout. Keep the old state directory as a backup. Copy any filesystem-based configuration, vault and workspaces you still need into the new state directory separately.
