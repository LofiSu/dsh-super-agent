![dsh-super-agent banner](docs/assets/ds-agent-banner.png)

# dsh-super-agent

English · [简体中文](README.zh-CN.md)

An independent TypeScript demo inspired by [DeepSeek’s Super-agent design article](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg). It combines an async ReAct runtime with a proactive task engine.

- The **Router** evaluates incoming triggers and turns actionable requests into tickets.
- **Workers** run assignments in separate sessions while the Router keeps accepting input.
- **SQLite** persists state across restarts, and the **Watchdog** detects stalled work.

## Quick start

Requires Node.js 22+, pnpm, and an OpenAI-compatible model API key.

```bash
git clone https://github.com/LofiSu/dsh-super-agent.git
cd dsh-super-agent
pnpm install

export DEEPSEEK_API_KEY=your-key
pnpm ds-agent init
pnpm ds-agent chat "Summarize the open tickets"
pnpm ds-agent tasks
```

See [installation](docs/install.md) for other model providers. Run `pnpm test:coverage` for the offline fixture suite. The [real-channel demo](docs/REAL_CHANNELS.md) uses a live model and creates GitHub issues and comments in the configured repository.

## Documentation

[Architecture](docs/architecture.md) · [Modules](docs/MODULES.md) · [Channels](docs/REAL_CHANNELS.md) · [Safety](docs/safety.md) · [More docs](docs/index.md)

## License

[MIT](LICENSE)
