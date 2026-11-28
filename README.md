![LofiBot banner with a cobalt mascot and chartreuse eyes](docs/assets/lofibot-banner.png)

# LofiBot

English · [简体中文](README.zh-CN.md)

LofiBot is a local TypeScript agent that turns messages and scheduled events into tasks. Its Router keeps the conversation moving while Workers run tasks in separate sessions. SQLite keeps task state across restarts.

## Quick start

Requires Node.js 22+, pnpm, and a model API key.

```bash
git clone https://github.com/LofiSu/LofiBot.git
cd LofiBot
pnpm install
export DEEPSEEK_API_KEY=your-key
pnpm lofibot init
pnpm lofibot chat "Summarize the open tickets"
pnpm lofibot tasks
```

See [installation](docs/install.md) for other providers or to migrate an existing checkout. For Feishu and iMessage, run `pnpm lofibot channels check` before `pnpm lofibot serve --imessage --feishu`. See [channel setup](docs/REAL_CHANNELS.md) for details and GitHub.

For a native chat window, see the [Rune desktop client](desktop/README.md). It connects to the same Agent runtime and can render an offline preview without opening a window.

## Architecture

```mermaid
flowchart TD
  Sources["CLI · Feishu · iMessage · GitHub · A2A"]
  Routines["Daemon routines"]
  Ingress["Ingress · filter and route triggers"]
  Router["Engine · Router batches by Thread and runs Eval"]
  Assign["Ticket → Assignment"]
  Worker["Harness · isolated Worker session · async ReAct"]
  Tools["Model · sandboxed tools · optional MCP"]
  Store[("SQLite · sessions, tasks, memory and Outbox")]
  Watchdog["Watchdog · stalled work"]
  Outbox["Router → Outbox → channel"]

  Sources --> Ingress
  Routines --> Ingress
  Ingress --> Router
  Router -->|actionable| Assign --> Worker
  Router -->|subscribed Thread| Worker
  Worker <--> Tools
  Worker -->|report| Router
  Router --> Outbox
  Router <--> Store
  Worker <--> Store
  Watchdog -.->|nudge or fail| Assign

  classDef input fill:#F9EDF5,stroke:#A73968,color:#17234E
  classDef route fill:#213C83,stroke:#E94D9A,color:#FFFFFF,stroke-width:2px
  classDef work fill:#DEEBFF,stroke:#345EB1,color:#17234E
  classDef support fill:#EBF6A3,stroke:#61751D,color:#222D14
  class Sources,Routines input
  class Ingress,Router,Outbox route
  class Assign,Worker,Tools work
  class Store,Watchdog support
```

The Router owns replies. Workers report their results to it, and the Outbox handles delivery. Scheduled triggers and channel messages share the same ingress path.

[Architecture](docs/architecture.md) · [Module reference](docs/MODULES.md) · [Safety](docs/safety.md) · [MIT license](LICENSE)
