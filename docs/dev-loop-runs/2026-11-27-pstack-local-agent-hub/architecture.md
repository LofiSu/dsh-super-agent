# Default pstack workflow and local AI agent hub

## Requirements

Once the engine accepts a work Ticket, execution starts inside pstack. Chat envelopes and system wakes remain messaging paths. Task intent selects steps inside the workflow. It never enables or disables the workflow. Ticket mandate, approvals, speculative restrictions and pause rules remain authoritative.

A user can connect and manage multiple AI accounts and runnable agents on one machine. Account labels, agent mappings and run history persist per ds-agent home. Credentials stay with the official client or in a local credential provider. Agents can cooperate even if they use the same model.

## Architecture decision

Two designs were considered. A single omnipotent model can hold the workflow checklist in its transcript and call provider-specific tools. This is inexpensive to prototype, but restart correctness and completion depend on reconstructing a rotating transcript. A generic workflow engine plus a separate provider scheduler gives explicit state but duplicates the repository's already deployed Ticket, Assignment, approval and recovery machinery.

Use Ticket as execution ownership, a pstack workflow document keyed by Ticket as a durable checkpoint, and the existing guarded delegate tool as the narrow execution entry. Settings owns account definitions. A provider adapter owns authentication and execution details. Neither workflow nor model receives credentials or constructs shell commands.

## Runtime contract

- At Worker startup initialize or resume a versioned workflow document keyed by Ticket ID. No regex, routing model, slash command, provider binding or new network request is required to enter.
- The Worker names the goal and completion criteria, selects the applicable vendored playbook, and records plan, execution and verification checkpoints. Investigation may verify by tracing source and checking references. Implementation uses an original repro or the relevant user-facing checks.
- The host owns phase transitions and rejects ready reports before verification on every managed work ticket. Existing remote and historic callers without a local workflow record remain compatible. A blocked or failed run can still report its blockers. Existing approvals remain the gate for outward changes. A read-only work contract stays read-only.
- Restart resumes from the persisted phase. The active Assignment is the authority for writes. Older tickets can start on the next Worker turn. Conversation and proactive routing stay at the existing Router boundary. An external Worker must eventually support protocol negotiation and checkpoint reporting before the host can enforce its steps.
- A verification entry records the supplied evidence and links to host receipts where available. A Worker checkpoint is an attestation. It must never be presented as an independently verified receipt. Product acceptance includes genuine evidence replay.

## Account and agent contract

- A local connection binds an account alias and provider to either an existing officially authenticated CLI profile or an owner-configured provider integration. Store metadata in a local file updated atomically. A connection can be disabled or removed without logging out the official client or deleting its profile.
- Provider presets use commands and argv chosen by the host. User-approved custom adapters can use an executable with fixed argv. The model can only select a registered agent ID and submit task text. Existing configured specialists remain available, with collision policy explicit.
- Detect installed known clients at setup. Installing an executable does not prove that it is signed in. Show setup and management entry points; explicit binding may be skipped during first run. Preserve the existing model gateway setup.
- Codex and Claude Code have official noninteractive execution modes and support profile-specific login. WorkBuddy Enterprise and a user-owned bot require a configured integration with supported credentials and a verified callable interface. An owner-configured executable bridge allows those products to participate through the same delegation contract; provider-native status, streaming and cancellation require separate verified adapters. A model endpoint stays a model gateway provider.
- A run snapshots the agent ID, permitted workspace and assignment before executing. Existing durable delegation receipts and process supervision own execution status and failure. Only the selected client receives its profile environment. No password collection, token copying, account enumeration or credential injection into prompt or journal.
- For collaboration the owner can name the agents in the work request. The coordinator sends independent briefs and assembles their receipts. Read-only review and isolated writable implementation must use their appropriate permissions and worktree. Providers may use identical models. Parallel lanes require isolated writes and independent evidence. No cross-provider transcript sharing by default.

## Delivery order and verification

1. Replace keyword activation with the default Ticket workflow. Add regression tests for arbitrary work tickets, conversational routing, persistence and completion gating.
2. Add local account binding and catalog commands. Migrate configured specialists through the existing registry without silently rewriting their configuration. Verify Unix file mode, invalid/duplicate accounts and failure recovery.
3. Wire bound agents into Worker delegation. Exercise multiple agents with fixture executables and verify that run records retain both identities and the parent ticket. Run the full offline suite, lint, typecheck and package smoke.
4. Verify real Codex/Claude Code account and WorkBuddy/bot adapters using user-owned test accounts. Validate pause, timeout, per-agent workspace, restart and provider cancellation. Provider-specific verification requires access to those accounts and is recorded separately from offline fixture checks.

## References

- [pstack mode and playbooks](https://github.com/cursor/plugins/tree/main/pstack/skills/poteto-mode)
- [Codex execution surfaces](https://openai.com/index/unlocking-the-codex-harness/)
- [Claude Code programmable execution](https://code.claude.com/docs/en/headless)
- [WorkBuddy Enterprise managed agent API](https://cloud.tencent.com/document/api/1831/138581)

## Local data and lifecycle

| Data | Owner | Key and persistence |
| --- | --- | --- |
| Ticket mandate and assignment | Engine | Existing SQLite Ticket document; scope and authorization are authoritative |
| Workflow | Local execution harness | `pstack-run/<ticketId>`; version, phase, bundled playbook ID, bounded checkpoint attestations and assignment IDs |
| Connection catalog | Owner setup/CLI | Per-home `agent-connections.json`; named provider, fixed executable and profile metadata; mode 0600 |
| Official login | Vendor client | Vendor's existing profile or an explicitly selected local profile directory |
| External operation | Execution receipt layer | Existing external operation ID, parent ticket/assignment, agent ID, timestamp and outcome |

A reloaded Worker sees the saved checkpoint and the selected upstream playbook. Checkpoints are ordered. The active assignment's session may advance the workflow. Paused or permission-held turns still use the existing harness pause checks; no new scheduler is added. Local receipt output exposes the phase, playbook, whether verification was recorded, and agent aliases, with prompt bodies, credential values and raw errors excluded. Existing unknown-operation recovery prevents retrying uncertain external work automatically.

## Concurrency and data leaving the machine

The initial cross-product path delegates in sequence through the existing guarded Worker tool. Use two distinct aliases for implementation and review, with a bounded handoff and independent context. A bridge must enforce any read-only promise itself. Do not run parallel writers against the same Worker workspace. Parallel implementation can be added by providing isolated worktrees, explicit merge ownership and tested conflict handling. Agent-local model sessions may be independent even when they use the same model.

Connection metadata and ds-agent receipts are local. A vendor endpoint or a cloud-backed CLI may receive the delegated task and its explicitly scoped context under the owner's connection settings. Model-gateway credentials and external application connections remain distinct.

## Acceptance matrix

| Scenario | Required observation |
| --- | --- |
| Plain, accepted work message | First Worker model call sees pstack intake state, without keyword or command matching |
| Plan submitted and process restarts | Same Ticket resumes with the recorded phase and playbook |
| Worker attempts delivery before declared verification | Tool rejects the ready report; Ticket remains open |
| One implementer and one reviewer | Each receives its own brief, and each ID and outcome appears on one parent receipt |
| Local binding removed | Catalog no longer resolves it after restart; vendor login data remains intact |
| Vendor profile expires | An explicit connectivity check reports the provider outcome and points to its login action |
| WorkBuddy or bot lacks a usable bridge | Setup can explain the missing connector; the runtime does not pretend to execute it |
