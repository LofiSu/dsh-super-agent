---
layout: default
title: 安装和运行
lang: zh-CN
nav: install
alt: /install/
description: "安装 lofibot 并跑实况 demo。需要 Node.js 22、pnpm，以及一个 OpenAI 兼容模型。"
permalink: /zh/install/
---

# 安装和运行

Node.js 22 或更高。版本写在 [package.json]({{ site.repository_url }}/blob/main/package.json) 的 `engines` 里。存储用 `node:sqlite`。包管理用 [pnpm](https://pnpm.io/)。

```bash
git clone https://github.com/LofiSu/LofiBot.git
cd LofiBot
pnpm install
```

本仓目前只按源码使用：还没有发布到 npm，所以不能从 registry 装
`npm install -g lofibot`。日常在仓库里用 `pnpm lofibot ...` 运行 CLI。

包里是有构建步骤的。`pnpm build` 会产出 `dist/` 和 `bin.lofibot` 入口
（`./dist/cli/main.js`），打出来的 tarball 不需要 `tsx` 就能跑。`lofibot
--version` 会打印包版本。想在本机做 pack/安装冒烟、不走 registry 的话，看
[docs/RELEASE.md]({{ site.repository_url }}/blob/main/docs/RELEASE.md)，并运行
`pnpm tsx scripts/package-smoke.ts`。

`pnpm test` 和 `pnpm demo` 都要一个能打通的 OpenAI 兼容模型。这两条路径不用 MockModel。`pnpm demo:local` 是内存 fixture 冒烟，不是验收路径。

跑 `pnpm test` 之前，先设 `LOFIBOT_API_BASE`、`LOFIBOT_API_KEY`、`LOFIBOT_API_MODEL`。三个里缺哪个，`test` 脚本就填上本机 Magpie 的默认值：地址 `http://127.0.0.1:3425/v1`，密钥 `magpie`，模型 `workbuddy/deepseek-v4.1-flash`。本机没有这个网关，测试就连不上模型。只放一把厂商 Key，比如 `DEEPSEEK_API_KEY`，换不掉这三项。脚本会自己写上 `LOFIBOT_API_BASE` 和 `LOFIBOT_API_KEY`，预设路径看不到那把单独的 Key。

`pnpm demo` 和 `pnpm lofibot chat` 不会填这套 Magpie 默认值。这两条要成对设置 `LOFIBOT_API_BASE` 和 `LOFIBOT_API_KEY`，或者只设一把厂商 Key。这一对只设其中一个，进程会报错退出。成对设置时不写 `LOFIBOT_API_MODEL`，客户端发送 `deepseek-chat`。只设 `DEEPSEEK_API_KEY` 时，默认模型是 `deepseek-flash`。

```bash
export LOFIBOT_API_BASE=https://api.deepseek.com
export LOFIBOT_API_KEY=sk-...
export LOFIBOT_API_MODEL=deepseek-flash
pnpm test
```

`pnpm demo` 只走真实信道：用 `gh` 创建、读取真实 GitHub issue，并把回复发成真实评论。没有假的 IM，也没有假的 GitHub。先 `gh auth login`，再把 `LOFIBOT_GH_REPO` 指到这个账号能写的仓库，然后再跑 demo。不设的话，demo 用 `LofiSu/LofiBot`。

```bash
gh auth login
export LOFIBOT_GH_REPO=your-account/your-writable-repo
pnpm demo
pnpm lofibot chat "fix the login timeout"
```

`LOFIBOT_API_BASE` 可以是任意 OpenAI 兼容地址，包括本机的 [Magpie](https://github.com/yetone/magpie)。密钥填网关 token，模型名用 Magpie 上的 id。

```bash
export LOFIBOT_API_BASE=http://127.0.0.1:3425/v1
export LOFIBOT_API_KEY=magpie
export LOFIBOT_API_MODEL=deepseek/deepseek-flash
export LOFIBOT_GH_REPO=your-account/your-writable-repo
pnpm demo
```

一个进程用一个模型。Router 和 Watchdog 用轻的，Worker 用强一点的。

状态在 `LOFIBOT_HOME`，没设的话在 `./.lofibot`（SQLite）。

```bash
pnpm lofibot tasks
pnpm lofibot status
pnpm lofibot metrics
```

这些扩展服务由 Runtime 常驻装配：Router 分片、Worker mesh、长期记忆、生命周期总线和 A2A 每次启动都会构造，没有 opt-in 开关。用 `LOFIBOT_SHARDS`、`LOFIBOT_MESH_CAPACITY`、`LOFIBOT_INSTANCE_ID` 配置；逐项说明见 [docs/MODULES.md]({{ site.repository_url }}/blob/main/docs/MODULES.md)。

Worker 的 `bash` 需要 macOS 上的 `sandbox-exec` 或 Linux 上的 `bwrap`；wrapper 不存在会直接报错，CI 会安装 bubblewrap。

关掉这些 issue 只是收尾。每个场景都是正事做完才调 `closeGithubIssues`。关闭请求失败会被忽略，issue 还开着，demo 也不会因此判失败。场景中途抛错，或者在这次调用之前就 return，已经建出来的 issue 也会留着：后面的 `createIssue` 可能在前面几条已经建好之后失败；watchdog 场景在 issue 没有 trigger 时直接返回；spill 场景缺 trigger 时也直接返回。`LOFIBOT_GH_KEEP=1` 是故意不关。跑完去仓库里看一眼，还有没有带着 `lofibot-demo` 标签、仍然开着的 issue。

飞书怎么配，看仓库里的 [docs/REAL_CHANNELS.md]({{ site.repository_url }}/blob/main/docs/REAL_CHANNELS.md)。

## 升级已有安装

命令已改为 `lofibot`，项目环境变量统一以 `LOFIBOT_` 开头。请更新脚本、服务配置和机器人提及（`@lofibot`）。新的默认状态目录是 `./.lofibot`。

停止旧进程后，在旧版本目录运行 `pnpm ds-agent backup --out /absolute/path/lofibot-backup.db`。再在新版目录运行 `pnpm lofibot restore /absolute/path/lofibot-backup.db` 恢复 SQLite 快照。请保留旧状态目录作为备份，并按需单独复制仍在使用的文件配置、凭据库和工作区。
