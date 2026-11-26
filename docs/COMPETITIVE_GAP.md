# Competitive gap: Instinct, Muse, and Grok Bot

> Living document. Last audited **2026-11-26** against `main` **`d616dbd`**. Structural comparison only — not a claim about production prompts:
> none of the three products publishes its full prompt or internals. Muse is
> known from its leaked agent workspace, Instinct from the Open Instinct
> implementation, and Grok Bot from its public instruction and approval model.

The goal is not to copy wording. It is to close the capability and feel gaps
that make a personal agent worth talking to and worth delegating work to.

## Scorecard

| Dimension | Instinct / Open Instinct | Muse | Grok Bot | ds-agent now | Verdict |
|---|---|---|---|---|---|
| **Prompt stack** | Rebuilt each run: identity, instructions, owner, principal, channel, reach, setup, rules, memory, skills, approvals, long tasks, now | One long prompt plus injected workspace files (`SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `MEMORY.md`, `TOOLS.md`, `HEARTBEAT.md`, `PROACTIVE_PREFERENCES.md`) | Persistent Bot instructions plus skills, routines, integrations, memory | 33 ordered sections + per-turn task and recall data; nine runtime files (#171); `ds-agent prompt --layers` | **Parity on structure**, still behind on per-principal layers |
| **Voice / personality** | `PERSONA.md`, owner-owned, about 30 lines | `SOUL.md` + `IDENTITY.md`, written and refined by the agent and owner | Bot instructions, editable | Warm identity + `SOUL.md` + `IDENTITY.md` + built-in default voice + concrete voice examples (v2) | **Parity on intent**; needs real conversation evaluation, not just prompt shape |
| **Owner model** | Principal tiers: owner, staff, partner, family, friend, contact, stranger | Single owner; other people are not principals | One owner | Single owner; ingress trust separates owner from group/other | **Behind** on tiers; ahead on a strict default-deny ingress |
| **Local specialist agents** | Skills and subagents; MCP tools | Subagents and tools | Skills, routines, integrations | `delegate_agent` to owner-configured local CLIs; Workers only; no shell; bounded | **Newly at parity**, with a narrower trust surface than Muse/Instinct connectors |
| **Subagents / team** | Subagent prompts get the shared frame plus a role | Subagents | Routines and skills | Router/Worker split, Worker-internal teams, persisted jobs, aggregate report | **Parity** for execution topology |
| **Memory** | `MEMORY.md` + daily journal; bounded digest every turn | `MEMORY.md` + memory search/explain tools; strict write rules | Bot memory | `MEMORY.md` injection plus typed refs, `read_object` chain of recall, hybrid lexical + embedding recall, hot/cold retention, cold Thread digests, per-hop ACL | **Ahead on safety and provenance**; **behind on learned semantic recall and an owner-editable daily journal** |
| **Skills** | `skills/` with `SKILL.md`; loaded on demand | Tools and workspace files | Skills | `skills/<id>/SKILL.md` index in the prompt; `read_skill` loads the body | **Parity on the core loop**; no bundled starter set yet |
| **Proactivity / routines** | Scheduled etiquette and routines | `HEARTBEAT.md`, `PROACTIVE_PREFERENCES.md`, scheduling | Routines | `HEARTBEAT.md` checklist + `PROACTIVE_PREFERENCES.md`; `routines.json`: interval or UTC daily-time prompt, weekdays, channel/thread, persisted last-run, daemon tick | **Parity on intervals and daily times**; no cron expressions, per-routine timezone, or owner editor yet |
| **Channels** | Texting, email, A2A, chat | App / channel surfaces | Bot connectors | CLI, iMessage, Feishu, GitHub, A2A, OpenAI-compatible gateway, read-only loopback UI | **Ahead in one runtime**; owner-gated Google Workspace + browser errands on `main` (#174, #172) but **default off, real account/browser not validated**; **behind** on email, payment capture, SMS/phone, standalone conversational desktop |
| **Approvals** | Dedicated approvals layer | Safety policy | Approval before send, publish, delete, spend | Worker `request_approval` → hold → Router asks → **CLI** `approve` / `deny` / **`dismiss`** (dismiss closes card, no consent) with `actionId` on exact action text → audited RESUME | **Parity on state machine + structured action id**; still **CLI-only** — channel reply cannot approve |
| **Observability** | Layer inspection, logs | Workspace files are visible | Bot editor | Lifecycle bus, read-only token-gated UI, metrics, health, session journals, offline CLI inspection, execution receipts (#182) | **Ahead** |
| **Safety / sandbox** | Rules layer, approvals | Safety and security policy last | Approval gates | Default-on fail-closed OS sandbox for bash, env allowlist, secret redaction sentinel, spill ACL, opt-in strict read isolation; fill-only vault (#173) with no read-back | **Ahead for its scope**; specialist CLIs and host reads remain trust boundaries |
| **Self-improvement** | Editable persona, skills, memory, policy | Agent rewrites its workspace files | Instructions editor | #168 deliver-gate controlled evolution v1; deterministic eval suite — **no full RSI loop on `main`**; [#183](https://github.com/LofiSu/dsh-super-agent/pull/183) open (proposal ingest only) | **Behind on productized RSI**; ahead on repeatable offline verification |

Legend: **Ahead** means a concrete capability the others do not document;
**Parity** means the same job with a different design; **Partial** means the
foundation exists but the owner-facing surface is missing; **Missing** means no
implementation.

## Where ds-agent is already ahead

- **One runtime, many channels.** The same Engine, Store, Threads, Tickets, and
  Router serve IM, GitHub, A2A, CLI, and the gateway. Muse and Grok Bot are
  product surfaces; Instinct is closer, but ds-agent keeps the channel adapters
  behind one domain model.
- **Deterministic offline verification.** The full suite runs without a live
  model. That makes every gap fix testable in CI, which is the precondition for
  fast self-iteration.
- **Memory with provenance and ACL.** Every recalled object has a typed handle,
  and every hop re-checks the reader's Thread. A handle is not a capability.
  This is stronger than a flat `MEMORY.md` injection.
- **A real sandbox for Worker bash.** `sandbox-exec` / `bwrap` default-on and
  fail-closed, an environment allowlist, and a credential sentinel test.
- **Operator controls.** Pause, intervene, resume, handback, watchdog fail, and
  backup/restore are implemented, not just described.
- **Delegation without shell interpolation.** `delegate_agent` takes a task as
  one argv entry; command, cwd, env, timeout, and output cap are owner-owned.

## Where the gap is real

1. **Skills.** The core loop now exists: an owner adds
   `skills/<id>/SKILL.md`, the prompt carries a bounded index, and `read_skill`
   loads the body. What is still missing is a bundled starter set, an
   owner-facing editor, and any way for a skill to declare which existing tool
   it expects. A skill still cannot grant a tool.
2. **Routine scheduling depth.** Owner routines now support intervals and the
   canonical "every weekday at 08:00" (`at` + `days`, UTC). What is still
   missing is a cron expression, a per-routine timezone, and an owner-facing
   editor. Restart drift is documented, not solved.
3. **Approval reach.** Three-answer cards and `actionId` binding ship on `main` (#173), but the owner still decides through the **CLI** (`approve` / `deny` / `dismiss`). A channel reply cannot approve: that needs an authenticated owner identity and a signed decision, not text the model read.
4. **Semantic memory.** Recall is now hybrid: lexical plus one tag hop plus an
   optional embedding score. The shipped `HashedEmbedding` is deterministic and
   offline, so it catches morphology and shared stems but not true synonyms
   ("invoice" vs "billing"). Instinct and Muse use learned embeddings for that.
   The `EmbeddingPort` is where a local or hosted model plugs in; selecting and
   evaluating one is still open. There is also no owner-editable daily journal.
5. **Principal tiers.** ds-agent is owner-only by design. Group participants are
   not principals. Instinct's tier model is the reference if ds-agent ever
   supports staff or family.
6. **Connectors.** Owner-gated Google Workspace (#174) and browser errands (#172) are on `main` but default off with no real-account/browser acceptance. **Email, payment capture, SMS/phone, and a standalone conversational desktop** remain gaps — the difference between "can operate a repo" and "can run errands" on live accounts.
7. **Self-improvement as a product.** #168 is controlled evolution v1, not a loop that maintains this gap list, scores recent conversations, and lands improvements. [#183](https://github.com/LofiSu/dsh-super-agent/pull/183) adds proposal ingest infrastructure but is **not on `main`**. This document is the inventory; the product RSI closure is still open.

## Next sequence

| Priority | Work | Acceptance evidence |
|---|---|---|
| ~~P0~~ | ~~Skills loader and `read_skill`~~ — shipped in #149 | ✅ index injection, size caps, symlink/path rejection, role guards, `ds-agent skills`, docs |
| ~~P0~~ | ~~Owner-defined routines / heartbeat~~ — shipped in #150 | ✅ fake-clock tests, persisted last-run, first-sight arming, gap fires once, ingress admission, `ds-agent routines`, docs |
| ~~P1~~ | ~~Interactive approval flow~~ — shipped in #151 | ✅ worker tool, approval hold, Router question, CLI approve/deny, guidance + audit, watchdog idle, tests |
| ~~P1~~ | ~~Three-answer approval + exact `actionId`~~ — shipped in #173 | ✅ approve/deny/dismiss, action text binding, offline tests; channel approve still open |
| ~~P1~~ | ~~Fill-only credential vault (no read-back)~~ — shipped in #173 | ✅ fill-only store, approval-gated fill tools; real form acceptance operator-gated |
| ~~P1~~ | ~~Muse-style prompt stack~~ — shipped in #171 | ✅ 33 sections, nine runtime files, `docs/PROMPTS.md` |
| ~~P2~~ | ~~Google Workspace connectors (owner-gated)~~ — shipped in #174 | ✅ offline fakes, default off; real OAuth/API acceptance open |
| ~~P2~~ | ~~Browser errand adapter (owner-gated)~~ — shipped in #172 | ✅ local/remote HTTP command path, default off; not leased cloud browser; live browser open |
| P2 | Real-channel / real-connector acceptance | Recorded operator runs: Feishu send, Google, iMessage, browser errand, vault fill — not assumed from CI |
| P2 | Email and payment **capture** connectors | Adapter contract, approval gate, offline fakes; distinct from fill-only vault |
| P2 | Consider merge **#180**, **#183** after review | Independent review; do not treat **#177** as merge-ready |
| P2 | Principal tiers | Trigger trust tiers, prompt `principal` layer, tests that a group member cannot become the owner |
| P3 | Full reflection / RSI loop on `main` | Scheduled review → bounded lesson updates with owner approval; beyond #168 v1 and open #183 ingest |

## Rules for closing the gap

- **No capability claims without a test.** A README bullet without an offline
  test is a wish, not a feature.
- **One concern per PR.** A prompt change and a capability change ship
  separately, even when they are designed together.
- **Do not copy unsafe surfaces.** A local CLI agent is not a reason to add a
  shell string, an unbounded loop, or an unapproved outward action.
- **Do not conflate evidence.** Official Instinct pages vs Open Instinct implementation vs teardown blogs are different grades; see `docs/INSTINCT_CAPABILITIES.md`.
- **Measure the feel, not only the structure.** Prompt tests can prove layer
  order and boundary wording; they cannot prove the agent is pleasant. Real
  conversation transcripts and owner feedback are the only evidence for that.
