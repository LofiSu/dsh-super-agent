# Anthropic Agent Memory 功能复刻计划

> 按可独立验收的 PR 执行，每个 PR 先写行为回归测试，再完成代码、独立审查和受保护分支集成。

目标是复刻 Anthropic 公开方案中可观察的记忆行为。全部读写使用同一个 M6 存储与授权边界。原文、笔记、Wiki 和注入上下文构成一个系统。公开资料未给出的内部实现和调参不作为已验证行为。

依据：[工程博客](https://www.anthropic.com/research/components-of-agent-memory)、[客户端工具](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)、[Claude Code 自动记忆](https://code.claude.com/docs/en/memory)、[Managed Agents Dreams](https://platform.claude.com/docs/en/managed-agents/dreams)。

## 实施顺序与验收

- [ ] **运行入口连续性。** 在 `src/cli/desktop-chat.ts` 与 Desktop 调用端传递稳定的对话身份，保留明确的新对话边界。在 `src/runtime.ts` 为前台接入现有 AutoDream 心跳及退出处理，避免启动无关后台任务。测试关闭进程、重启、同一对话回忆、新对话隔离和与 serve 共同运行。
- [ ] **证据可回查。** 在 `src/memory/transcript.ts`、`src/memory/tools.ts`、`src/store/sqlite.ts` 接入同作用域的分页与查询。引用持有会话和记录身份，按当前创建者与读取者的授权验证。覆盖 Worker 跨会话回查、线程被移除、隐藏记录以及结构化工具执行结果的脱敏。
- [ ] **跨会话纠错与累积。** 在 `src/memory/auto-dream.ts` 用每会话进度摄取记录，按结论保留出处与版本。覆盖晚处理的旧冲突、晚处理的旧独立事实、无效引用、工具返回与人工纠正冲突、并发与重试。
- [ ] **自动 Wiki。** 在 `src/memory/auto-dream.ts` 与 `src/memory/notes.ts` 允许 Dreaming 提出建页、修订、合并、修复链接与索引升降级。在一次发布中验证路径、预算、引用、链接和旧版本。测试一条新证据更新两个主题、多条记录综合成新主题、重复页合并、断链修复，以及超限或版本竞争时无部分发布。
- [ ] **整理产物和发布。** 手动入口与自动入口使用同一套草稿和校验。后台作业读取授权历史与当前笔记，保留独立的输入版本及可审阅草稿，支持接受、丢弃和恢复。测试拒绝不改线上内容、过时草稿不能覆盖、重启后可查状态，并验证恢复只是将同一作用域切换到已保存版本。
- [ ] **客户端协议与注入。** 用官方六命令样例验证参数、读取范围、错误与越界。在真实 Claude API 接入时使用官方提供的工具类型。对索引实现 200 行或 25 KB 的先到限制及超限反馈，详细主题按需加载。测试空索引、边界和高频主题变化。
- [ ] **端到端验收。** 重跑既有十个基于公开问题的案例与真实模型验收，新增至少一个真实模型任务覆盖跨会话证据、多页 Wiki、索引提升和桌面重启。分别记录执行器行为、模型正确率、废弃事实残留、来源可追溯和上下文用量。每个 PR 运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`，合并后用远端 main 复验。

先交付入口连续性，并行核对公开协议的行为样例。后续证据与 Wiki 共享引用契约，依序集成。
