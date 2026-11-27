# Orca Bot workflow in DeepSeek Harness Desktop

Reference revision: [Orca 16852f2](https://github.com/stablyai/orca/tree/16852f2).
Use the native Harness panel slots for the Bots entry and an original Harness
interface for the following workflows.

| Area | Orca source | Harness acceptance |
| --- | --- | --- |
| Create and list | `NewBotDialog.tsx`, `bots-create.ts`, `bot-controller-store.ts` | Create from the sidebar. Host validates the selected device and installed runtime and persists the configuration. Restart the app and recover the list from the same host store. |
| Home chat | `bot-chat-session.ts`, `bot-home.ts` | On a local Mac send a real message through ds-agent and reopen the same conversation after restart. Track delivery and runtime errors in the panel. |
| Agent adapters and device discovery | `bot-start-options.ts`, `bot-home-workspace.ts` | Show installed and reachable options. Test each declared adapter with an actual turn. Offline devices show waiting state. |
| Offers and templates | `bots-create-offer.ts`, `bot-template-create.ts` | Submit a proposal from a trusted host client. Confirm in the desktop UI. Retrying confirmation leaves one bot and one initial run. |
| Bot teams and task handoff | Bot conversation, orchestration and worktree services | Route a user-approved task to two Bot profiles. Show per-run status, cancellation, and results in the originating conversation. |
| Per-bot tools, connectors and triggers | Bot CLI and runtime RPC | Verify per-bot permissions. A real authorized trigger appears in the selected bot's chat and survives restart without duplicate handling. |

## Acceptance status

| Workflow | Verified evidence | Remaining |
| --- | --- | --- |
| Bot profiles and chat | Native desktop created a Bot, switched it to Codex, and reopened its saved reply. A separate ds-agent Bot answered a new question in the desktop and restored the reply after a full app restart. | Verify recovery of interrupted turns in the native desktop. |
| Runtime selection | Installed host advertised four runtimes after a restart without adapter environment overrides. Codex and Harness returned and persisted real replies. | Claude Code returned a quota error. Verify each selection in the desktop window. |
| Host registration | Installed host registered grokbot and returned an offline status after SSH closed before authentication. | Pair a reachable device and run a real remote turn. |
| Proposal and approval | Installed MCP submitted a pending offer. Approving it in the native desktop added the Bot to the list. An isolated host test covered approval replay. | Verify rejection in the desktop and an initial run if enabled. |
| Teams | Native desktop dispatched a real Codex and Harness task, restored both results after a full app restart, and persisted cancellation of another running dispatch. | Verify offline-member retry against a real host. |
| Tools and triggers | Codex adapter passed a real turn while ignoring user-level tool configuration. | The native desktop saved a conversation-only scope on a ds-agent profile, received a real answer and restored it from history. The native desktop enabled a loopback trigger for a scoped Bot. A real call completed once, retry returned the same receipt, the answer was present after desktop restart, and the revoked token was refused. A missing scope blocks execution. |

## Runtime configuration

Set absolute executable paths in `bot-runtimes.json` in the desktop sidecar's
state directory. Supported keys are `codex`, `claude`, and `harness`.
Set `localMagpie` to `true` to use the loopback Magpie preset for the Harness
headless adapter. The file stores paths and a boolean. Provider credentials
can be supplied via the environment.
