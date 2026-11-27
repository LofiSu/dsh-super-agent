import type { SkillRegistry } from '../env/skills.ts'
import { runPstack } from '../core/pstack-run.ts'
import type { Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'

export function engineeringWorkflow(ticket: Ticket, skills: SkillRegistry, store: Store): string | undefined {
  if (!skills.list().some(skill => skill.bundled && skill.id === 'poteto-mode')) return undefined
  const run = runPstack(store, ticket.id)
  return [
    '# Active pstack workflow',
    'Every accepted work ticket starts here. Use the ticket mandate to choose the steps, preserve read-only scope, and obey existing pause, approval and speculative gates. Never assume an external action is authorized by a playbook.',
    'Before execution, select a pstack-playbook-* document (or figure-it-out or interrogate), read it with read_skill, and call pstack_checkpoint with phase=plan, its ID as playbook, and the goal, ordered steps, and acceptance criteria as evidence.',
    'Follow the selected steps. Delegate bounded work to configured agents when appropriate. Record observed outcomes with phase=execute. Verify the real result, then record the command, observed result or source evidence with phase=verify before reporting delivery. Report failures or unavailable evidence explicitly. On resume, continue from the stored phase.',
    'The pstack checkpoint records your attestation. Actual tool results and delegation receipts remain the source of evidence. No playbook grants additional tools, scheduler or account access.',
    `Current pstack state: ${JSON.stringify({ phase: run.phase, playbook: run.playbook })}`,
    skills.read('poteto-mode').body,
    ...(run.playbook ? [skills.read(run.playbook).body] : []),
  ].join('\n\n')
}
