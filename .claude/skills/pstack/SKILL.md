---
name: pstack
description: Run this repository's engineering work through the vendored pstack playbooks with repository state, worktree, review and merge controls.
---

# pstack for deepseek-super-agent

Read `vendor/pstack/skills/poteto-mode/SKILL.md` in full. Select the matching playbook from its `playbooks/` directory, put its steps in the task checklist, and load the referenced skills and principles as needed. For long or multi-PR work, use `autonomous-run.md`, `multi-phase-plan.md` and the applicable `autopilot-*.md`. For an existing PR use `babysit.md`. For integration use `shipping.md`.

## Host mappings

- Map Cursor Task to the host's supported agent tool and models. Read `vendor/pstack/agents/poteto-agent.md` and `vendor/pstack/skills/poteto-mode/worker.md` when briefing an implementer. Include the goal, acceptance checks, write scope, exact base and worktree. The repository's implementer and review roles supply the host-specific permissions and constraints.
- Use independent reviewers for code changes and additional security or QA lanes as appropriate. Run the decisive verification command again at the reviewed head. Preserve a distinction between observed CI results and local reproduction evidence.
- Use the GitHub tools or `gh` for PR operations and local commands for checkable verification. Use available host tooling for UI or CLI evidence. State which evidence is missing if a host tool is unavailable.
- The main session owns the single project loop. Replace Cursor `/loop` and cloud-agent wake steps with waits and reconciliation in that session. Stop hooks guard continuation. Keep unrelated work in separate worktrees and never revert other agents' changes.
- The repository's GitHub rules win over upstream defaults. Run `pnpm typecheck`, `pnpm lint` and `pnpm test` before opening a PR. The main session controls merging. Required reviews, current-head CI and branch protection gate integration. High-risk changes require owner approval. Respect stop and pause immediately.

## Checkpoints

At entry, reconcile the current branch, working tree, PR heads and CI with `.super-agent/state.json`, `docs/MASTER_PLAN.md`, `docs/DEVELOPMENT_STATUS.md`, `docs/AGENT_REGISTRY.md` and `docs/PR_REVIEW_LOG.md`. Treat them as project records and verify stale claims against Git and GitHub.

Only the main session writes project state. Use the existing schema and checkpoint real changes through `plan`, `execute`, `review`, `integrate` and `checkpoint`; use `idle` or `owner_input` when appropriate. Update the cycle counters, queue, active agents, open PRs, progress time and update time. Record the next action and supporting evidence at every handoff. Follow the repository's existing cycle budget if it applies to the host. At a pause, use pstack's pause playbook and record the exact branch, head, PR and next check.
