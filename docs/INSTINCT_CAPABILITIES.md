# Instinct 公开能力验收清单

> 基线：`origin/main` `d616dbd`（2026-11-26，Asia/Shanghai）。本文件比较的是 **Instinct 的公开可观察能力** 与本仓库 `ds-agent` 的实现状态，不是对 Instinct 内部实现的还原。
>
> 关于 t286：父会话要求的 t286 完整公开清单，其逐字 assistant message **没有**在可索引的常用 agent 会话记录中找到（ds-agent 最新索引消息停在 2026-11-12；检索过的 Grok Bot 会话也不包含它）。本文件从父会话指向的同一批公开研究缓存重建，**没有**把 t286 当作已逐字读过。任何与 t286 原文的差异，以公开来源为准。

## 1. 来源与证据等级

只记录实际读过的来源。证据等级：

- **official**：Instinct 官方页面 / 官方隐私或条款。
- **media**：TechCrunch、The Verge、Reuters、Yahoo Finance、Business Insider、CNBC 等报道，或创始人公开访谈。
- **teardown**：personalagentbench 的拆解、独立逆向研究、用户量化观察。

| # | 来源 | 日期 | 本文件用到的内容 | 等级 |
|---|---|---|---|---|
| S1 | [instinct.com](https://instinct.com/) | 持续更新 | 短信/电话入口；个人助理定位 | official |
| S2 | Instinct Privacy Policy（`instinct.com` 官方隐私页，Last revised 2026-08-26） | 2026-08-26 | Google Workspace 七个产品；训练 opt-out；连接器数据 | official |
| S3 | Instinct Terms of Service（`instinct.com` 官方条款页） | 2026 | 运营主体 Spear Street Technology；SMS/电话条款；付费与不可退款 | official |
| S4 | personalagentbench, *What is Instinct AI? A teardown of the agent in your texts* | 2026-10-27 verified | 三个 memory store；工具数量三套口径；批准卡；自唤醒 | teardown |
| S5 | personalagentbench, *How does Instinct AI work? From trigger to action* | 2026-10 | 六个阶段；clock/event trigger；approval card；E2B/cloud browser | teardown |
| S6 | TechCrunch（2026-08 上线、2026-10-05 group chats / concierge） | 2026-08 / 2026-10-05 | invite-only；群聊；代打电话 | media |
| S7 | The Verge, Allison Johnson hands-on, [链接](https://www.theverge.com/tech/1008254/instinct-agent-ai-hands-on-muse-dots) | 2026-10-09 | 短回复、少话多做事、被纠正后的回应 | media |
| S8 | Reuters（2026-09-28 C 轮；创始人 Noah Shinn） | 2026-09-28 | 融资与创始人，不涉及能力验收 | media |
| S9 | Noah Shinn × Invest Like the Best ep. 493，[视频](https://www.youtube.com/watch?v=Am7IWP8IpEc) / [文字整理](https://pjfp.com/noah-shinn-instinct-personal-ai-assistant-10-percent-a-day/) | 2026-09-28 | 6:00 扫描可决定沉默；电话只用于高利害 | media |
| S10 | Nizzy, *I reverse-engineered Instinct*，[转载](https://haowenji.com/articles/x-2120178833282224128) | 观察窗口至 2026-11-10 | 12 周 17 次主动、全部 08:57–19:20；未完成事项跟进原话 | teardown（单账号） |
| S11 | Dhravya Shah, *Reverse-engineering Instinct memory*，[链接](https://supermemory.ai/blog/reverse-engineering-instinct-memory/) | 2026-09-20 | git-tracked markdown、关键词检索、约每日 reconciliation | teardown |
| S12 | Meta Muse, *How We Designed Muse*，[链接](https://muse.ai/blog/how-we-designed-muse) | 2026-09-08 | 主动消息必须“真正有用且值得这次打扰” | official（对照产品，非 Instinct） |
| S13 | JK, *Pitting Meta's Muse Against Instinct AI*，[链接](https://www.jkspeaks.com/wordpress/digital-signals/pitting-metas-muse-against-instinct-ai/) | 2026-10-31 | 价格追踪、有变化才来、用户反馈 | media |
| S14 | CNBC（2026-10-13，JPMorgan/Citi/Schwab 对 agent 登录银行的态度） | 2026-10-13 | 银行不欢迎第三方代登录；open banking 只读 | media |
| S15 | 本仓库 `docs/COMPETITIVE_GAP.md`（last audited 2026-11-26） | 2026-11-26 | **仅作内部对照**；须区分 official Instinct 与 Open Instinct，不能当作本清单的 inventory | 内部文档 |

> 连接器命名规则：只有来源明确写出名字才列入验收。S1–S15 中只有 **Google Workspace** 被官方隐私页逐项点名。Slack、Notion、1Password 类在本机缓存里没有具名证据，因此不在下文中冒充“已证实连接器”；见 §5。

## 2. 状态图例

| 状态 | 含义 |
|---|---|
| `main` | 当前 `origin/main` 已具备，附路径与验收测试/依据。 |
| `PR-only` | 只存在于未合并的 open PR；**不算已完成**。 |
| `missing` | 本仓库没有实现。 |
| `environment-blocked` | 不是写代码就能等价：需要托管号码、电话网络、商户合作、真实邮件域名，或用户自己的 Mac/iMessage 账号。给出可接受的等价方向，但不声称已实现。 |

## 3. Reach and wake（入口、唤醒、主动联系）

| # | 能力项 | Instinct 公开证据 | 等级 | ds-agent 状态 | 本仓库路径 / 验收依据 |
|---|---|---|---|---|---|
| A1 | iMessage 收发 | S4/S5：默认入口之一是 iMessage | teardown | `main` | `src/channels/imessage.ts`、`src/cli/imessage.ts`；`test/channels-imessage.test.ts` 覆盖 1:1/group 识别、默认拒绝、轮询与 outbox；真实发送仍需用户 Mac + Automation 权限，**未做真实发送验收** |
| A2 | WhatsApp 入口 | S4/S5：WhatsApp 是默认入口 | teardown | `missing` | `src/channels/` 无 WhatsApp adapter。等价方向是新增受 admission 约束的 WhatsApp Business/Cloud API adapter；托管号码属于 `environment-blocked` |
| A3 | SMS 入口 | S4/S5；S3 有 SMS/电话条款 | official/teardown | `missing` | 无 SMS adapter。等价实现需要运营商/聚合商号码，`environment-blocked` |
| A4 | 产品自带的 email identity | S4/S5：`a mail domain the product gives you` | teardown | `missing` | 无 email inbound/outbound adapter；需要自有域名、MX、SPF/DKIM，属 `environment-blocked` |
| A5 | inbound phone call | S4/S6：Yahoo 报道可按电话联系；concierge 可代打电话 | media | `missing` / `environment-blocked` | 无 SIP/PSTN/语音栈；不是本仓库当前能力 |
| A6 | outbound concierge calling（代打商户电话） | S4/S6：TechCrunch 报道 concierge 功能 | media | `missing` / `environment-blocked` | 需要电话网络与商户侧流程；无实现 |
| A7 | 群聊 / shared agent，含无账号参与者 | S4/S6：共享 Instinct 加入朋友群聊，朋友可以没有账号 | media | `missing`（群聊准入是 `main` 的另一件事） | `src/ingress/filter.ts` 有 `DS_AGENT_GROUP_ALLOWLIST`，Feishu 把 `chat_id` 映射到 `address.group`；但“共享 agent + 无账号 participant + principal 分层”没有实现。不要把 group admission 当成 shared agent |
| A8 | clock / timer wake | S4/S5：clock 可以启动它；S9：6:00 扫描后可决定沉默 | teardown/media | `main` | `src/harness/routines.ts`：interval / UTC daily schedule，daemon tick，first-tick arm，长间隔只补一次；`test/routines.test.ts`。注意这是 owner-authored routine，不是 Instinct 的内部“可自行醒来”策略 |
| A9 | connector / event wake（mail、calendar、documents、location） | S4/S5：事件可唤醒，平台侧先做 safety check | teardown | `main`（#174） | `src/connectors/wake.ts`：复用 Daemon pulse，把一条具体事件交给 `Runtime.ingest`；**默认关闭**，首轮只回填索引不唤醒，共享 `proactive.json` quiet hours，并受 DROP_SELF/allowlist、私有线程、每日上限约束。离线 fake 测试通过；**真实 Google 账号未验收** |
| A10 | unfinished-task follow-up | S4/S5/S10：跟进用户搁下的事；S10 的原话 *Did you book Vancouver, or do you still want a hand?* | teardown | `main` | `src/harness/proactive.ts` 在检测到 report question / pending approval / blocked state 时，才通过 `Runtime.ingest` 发一条短跟进；默认关闭，真实 Feishu 未验收 |
| A11 | personalized recommendations only when truly useful | S12（Muse 官方门槛，S9/S10 对 Instinct 的行为观察）：有实质新信息才打扰；无新信息保持沉默 | official/media | `missing` | 无推荐/价格追踪/日历变化引擎。主动联系门禁不等于推荐系统 |
| A12 | 白天发送、夜间安静 | S10：17 次主动全部在 08:57–19:20；S9：6:00 可扫描但不说话 | teardown/media | `main` | `proactive.json` 默认 quiet hours 23:00–08:00（Asia/Shanghai）；真实 Feishu/iMessage 发送未验收 |

## 4. Long-term memory 与 connector indexing

拆解把 Instinct 的记忆分成三个 store，三个 store 做不同的事（S4/S5/S11）。本仓库不能用一个 SQLite 索引冒充这三个 store。

| # | 能力项 | Instinct 公开证据 | 等级 | ds-agent 状态 | 本仓库路径 / 验收依据 |
|---|---|---|---|---|---|
| B1 | 持久人物记忆（可被后续 turn 召回） | S4/S5/S11 | teardown | `main`（等价，不是同一实现） | `src/memory/long-term.ts`：SQLite LTM、spill、Chain of Recall、ACL、hot/cold retention；`test/long-term-memory.test.ts`、`test/memory-graph.test.ts`、`test/memory-recall-eval.test.ts` |
| B2 | git-tracked markdown memory + 可追溯历史 | S4/S5/S11：git-tracked markdown files；S11 独立探测得到同一形状 | teardown | `missing` | 本仓库是 SQLite + JSONL，不是 git-tracked markdown；没有“修正后旧事实留在 git history”的产品面。等价物是 LTM 历史与 session journal，但不是同一能力 |
| B3 | 可查询的 connector data index | S4/S5：Gmail 等连接器数据进入 indexed layer，背后是 query interface；断开连接后是否清空未测 | teardown | `main`（#174） | `src/connectors/index-store.ts`：独立 `connector` document kind 与查询接口，不写 `ltm`、不要求 reader ticket；`pnpm ds-agent connectors query`。**默认关闭**；真实 Google 数据未验收 |
| B4 | fill-only credential vault | S4/S5：可把密码/卡号填进表单，但不能读回；密码不经过消息通道 | teardown | `main`（#173） | `src/env/fill-vault.ts`：fill-only store；`prepare_fill` / `fill_credential` 须与已批准卡及精确 action 文本一致；无读回接口；**真实表单填充未验收** |
| B5 | 每日 reconciliation / 记忆整理 | S5/S11：约每日一次 | teardown | `missing` | 无定时 reconciliation；LTM 只有写入、召回、retention pruning |

## 5. Connectors（只列有来源支持的名字）

| # | Connector | Instinct 公开证据 | 等级 | ds-agent 状态 | 备注 |
|---|---|---|---|---|---|
| C1 | Google Workspace：Calendar、Gmail、Drive、Docs、Sheets、Slides、Tasks | S2 官方隐私页逐项点名；S4/S5 说连接器数据进入 indexed layer | official | `main`（#174） | `src/connectors/`：七个公开产品名的只读映射、OAuth refresh-token 配置、默认关闭的 Daemon 轮询；离线 fake `fetch` 测试通过，**真实 Google OAuth/账号未验收**。没有 Slack/Notion 或其他未列名 connector |
| C2 | 工具/动作总量口径 | S4/S5：官方 help index **43 families / 571 actions**；teardown 自己的枚举 **39 / 569**；live page 上另有名字合计 **577**，其中 **335** 有完整 manual page；其余 242 各有 stated reason | teardown | `missing`（无可比 surface） | 名称数量不是验收标准。本仓库 tool surface 是 `src/harness/tools.ts` 的显式 tool list，远小于 Instinct 的 CLI grammar；不要用“577”当能力声明 |
| C3 | Slack | 本机缓存 S1–S15 未给出具名证据 | — | 不列入验收 | 如果后续拿到官方 help index 的具名页，再补 evidence grade；当前不能声称 Instinct 的 Slack 连接器已被验证，也不能声称本仓库支持 |
| C4 | Notion | 同上，未具名 | — | 不列入验收 | 同上 |
| C5 | 1Password 类密码/vault 工具 | 同上，未具名；“fill-only vault”是产品自有 store，不等于 1Password 集成 | teardown（仅 vault 形状） | 不列入验收（vault 见 B4） | 不要因为出现过“password/vault”就把 1Password 写成已证实 connector |
| C6 | 其他 43 families | S4/S5 只给数量与计数方法，没有在缓存中列全 43 个名字 | teardown | 不列入验收 | 未列名的 family 不猜、不补 |

## 6. Cloud browser、approval、vault、irreversible actions

| # | 能力项 | Instinct 公开证据 | 等级 | ds-agent 状态 | 本仓库路径 / 验收依据 |
|---|---|---|---|---|---|
| D1 | cloud browser errands（leased cloud browser，可用已保存登录） | S4/S5：browser work 走 leased cloud browser，不是本机 Chrome | teardown | `missing` / `environment-blocked` | **无** Instinct 式 leased cloud browser。本仓库有 owner-gated browser errand adapter（#172：本机命令或远程 HTTP，默认关闭，见 `docs/BROWSER_ERRANDS.md`），**不是** D1 的完成态；真实浏览器未验收 |
| D2 | approval card：approve / deny / dismiss，绑定“屏幕上显示的原文” | S4/S5：三答案；绑定 exact text；改写后要重新批准；没有 editable plan view | teardown | `main`（#173） | `approvalActionId` + `decideApproval`；`ds-agent approve\|deny\|dismiss`；`test/approvals.test.ts`。**CLI-only**；dismiss 关闭卡片不授权；无 editable plan view |
| D3 | irreversible actions 必须走 approval，模型不能自行批准 | S4/S5；S3 的 external send / payment 条款 | official/teardown | `main` | `request_approval` + pending hold；`test/approvals.test.ts` |
| D4 | payment / credential vault 可填不可读 | S4/S5 | teardown | `main`（#173） | `fill-vault.ts` + approval 门控 fill 工具；支付只 fill + approval，**不扣款**；真实表单/商户未验收 |
| D5 | receipt on request：读过什么、发过什么、没碰什么 | S4/S5：规则要求可出 receipt | teardown | `main`（#182） | `pnpm ds-agent receipt <ticketId> [--json]`；详见 `docs/EXECUTION_RECEIPTS.md`。无真实外部服务验收 |
| D6 | deletion surface：storage / training / location / desktop indexing | S4/S5 | teardown | `missing` | 本仓库有 backup/restore 与本地 SQLite 文件，但不是 Instinct 那种跨 store 删除面 |

## 7. 等价边界（不做相同克隆）

| # | Instinct 能力 | 状态 | 为什么不能在本仓库等价 | 可接受的等价方向 |
|---|---|---|---|---|
| E1 | hosted public identity（自有邮件域名、可被陌生人发信的地址） | `environment-blocked` | 需要域名、MX、SPF/DKIM、滥用处理与托管账号 | 由 owner 托管邮件/号码，adapter 只做受 admission 约束的 ingress |
| E2 | phone network / inbound + concierge calling | `environment-blocked` | 需要 PSTN/SIP、号码、通话合规与商户流程 | 明确的人工转交或第三方 voice provider；仍走 approval |
| E3 | merchant / Selections 式合作 | `environment-blocked` | 需要商业合作与结算关系 | 可插拔的 merchant adapter + 逐动作 approval；不伪造合作 |
| E4 | Apple/iMessage 账号与 Mac 上的 Messages.app | `environment-blocked` | 不创建账号、不访问用户 Mac | 由 owner 配置 Automation / Full Disk Access；代码只读 `chat.db`、经 `osascript` 发送 |
| E5 | 27-section main instruction set、main agent host、production model id、control-plane schema、desktop app、四个 policy section | `missing`（by design） | Instinct 未公开正文 | 本仓库用自己的 prompt layers（#171）与 policy，不假装对齐 |

## 8. 仍未进入 `main` 的 open 项

以下 **不算** `main` 已完成。已与 d616dbd 合入的 #165–#168、#173、#174、#172 等不在此表重复。

| # | 项 | PR | 状态 | 验收边界 |
|---|---|---|---|---|
| N1 | 飞书短私聊 `DS_AGENT_FEISHU_P2P_DIRECT` | [#180](https://github.com/LofiSu/dsh-super-agent/pull/180) | `PR-only`（OPEN，CI 绿） | 修复短 p2p 被丢；**未合入 main**；不构成飞书秒回或真实发送已验收 |
| N2 | Instinct / competitive-gap RSI **提案摄入** + 有界 scheduler tick | [#183](https://github.com/LofiSu/dsh-super-agent/pull/183) | `PR-only`（OPEN，CI 绿） | 基础设施，不是产品级 RSI 已发布 |
| N3 | GitHub issue poll queue + 更完整 bounded RSI | [#177](https://github.com/LofiSu/dsh-super-agent/pull/177) | `PR-only`（OPEN，**CONFLICTING**） | 底分支过旧，**不宜**当可合并目标 |

**不在本仓库 / 未闭环（无 PR 可指）：** `conversation-first`；完整 RSI 自迭代（维护缺口 → 评对话 → 落地改进）；可对话的独立桌面 UI（现有 UI 只读）；默认 GitHub @ issue 派发（`github-source` 识别 `@ds-agent` ≠ 默认派发已上线）；真实通道验收（飞书/Google/iMessage/表单 fill）。

**已在 `main`、本节不再标 PR-only：** #165 remote mesh placement、#167 部署与 loopback 探测、#168 controlled evolution v1（非完整 RSI）、#173 三答案卡 + fill-only vault、#174 Google 连接器/索引/事件唤醒、#172 owner-gated browser errands、#182 执行凭据、#170 idle self-wake（默认关闭）。

## 9. 结论

- **已具备（`main`，离线/CI；真实账号多数未验收）**：iMessage/Feishu/GitHub/CLI/A2A 运行时；routines；LTM + ACL；三答案审批（D2）与 fill-only vault（D4，#173）；Google Workspace 索引与 event wake（A9/B3/C1，#174，默认关闭）；browser errand adapter（#172，非 cloud browser）；执行凭据 D5（#182）；approval hold（D3）；sandbox/redaction 默认边界。
- **明确缺失或 blocked**：WhatsApp/SMS/email/电话；群聊 shared agent；Instinct 式 **leased cloud browser**（D1）；支付**扣款**；deletion surface（D6）；推荐系统（A11）。Slack/Notion 仍不列入验收（无具名来源）。
- **open PR，未进 main**：#180、#183；#177 冲突不宜合并。
- **不能靠代码等价**：hosted identity、电话网络、merchant partnerships、用户 Mac/iMessage 账号（`environment-blocked`）。
- **不猜测**：Instinct 未公开的 instruction body、host、model id、control-plane、desktop app 与 policy section；本仓库不复制、不假装对齐。
