![LofiBot 横幅，绘有钴蓝色、亮黄绿色眼睛的吉祥物](docs/assets/lofibot-banner.png)

# LofiBot

[English](README.md) · 简体中文

LofiBot 是一个本地运行的 TypeScript 智能助手，把消息和定时事件转成任务。Router 保持对话畅通，Worker 在独立会话中执行任务。任务状态保存在 SQLite 中，重启后可继续使用。

## 快速开始

需要 Node.js 22+、pnpm 和模型 API 密钥。

```bash
git clone https://github.com/LofiSu/LofiBot.git
cd LofiBot
pnpm install
export DEEPSEEK_API_KEY=your-key
pnpm lofibot init
pnpm lofibot chat "总结当前未关闭的任务"
pnpm lofibot tasks
```

更换模型服务商或迁移已有安装，请看[安装指南](docs/zh/install.md)。同时启用飞书和 iMessage 时，先运行 `pnpm lofibot channels check`，再运行 `pnpm lofibot serve --imessage --feishu`。详细配置和 GitHub 接入见[信道文档](docs/REAL_CHANNELS.md)。

## 架构

```mermaid
flowchart TD
  Sources["CLI · Feishu · iMessage · GitHub · A2A"]
  Routines["定时任务"]
  Ingress["Ingress · 过滤并路由事件"]
  Router["Engine · Router 按 Thread 批处理并评估"]
  Assign["Ticket → Assignment"]
  Worker["Harness · 独立 Worker 会话 · async ReAct"]
  Tools["模型 · 沙箱工具 · 可选 MCP"]
  Store[("SQLite · 会话、任务、记忆与 Outbox")]
  Watchdog["Watchdog · 检查停滞任务"]
  Outbox["Router → Outbox → 信道"]

  Sources --> Ingress
  Routines --> Ingress
  Ingress --> Router
  Router -->|可执行| Assign --> Worker
  Router -->|已订阅的 Thread| Worker
  Worker <--> Tools
  Worker -->|回报| Router
  Router --> Outbox
  Router <--> Store
  Worker <--> Store
  Watchdog -.->|提醒或标记失败| Assign

  classDef input fill:#F9EDF5,stroke:#A73968,color:#17234E
  classDef route fill:#213C83,stroke:#E94D9A,color:#FFFFFF,stroke-width:2px
  classDef work fill:#DEEBFF,stroke:#345EB1,color:#17234E
  classDef support fill:#EBF6A3,stroke:#61751D,color:#222D14
  class Sources,Routines input
  class Ingress,Router,Outbox route
  class Assign,Worker,Tools work
  class Store,Watchdog support
```

Router 负责回复，Worker 向它回报执行结果，由 Outbox 负责投递。定时事件和信道消息共用同一条入口链路。

[架构说明](docs/zh/architecture.md) · [模块参考](docs/MODULES.md) · [安全说明](docs/zh/safety.md) · [MIT 许可证](LICENSE)
