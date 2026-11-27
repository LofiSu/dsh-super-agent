import { UserError } from '../shared/errors.ts'
import type { Ticket } from '../shared/types.ts'
import type { Store } from '../store/sqlite.ts'

type Checkpoint = 'plan' | 'execute' | 'verify'
type Phase = 'intake' | Checkpoint | 'delivered'

interface PstackRun {
  version: 1
  phase: Phase
  playbook?: string
  checkpoints: Partial<Record<Checkpoint, { assignmentId: string; evidence: string }>>
}

export const RUN_KIND = 'pstack-run'
const next: Partial<Record<Phase, Checkpoint>> = { intake: 'plan', plan: 'execute', execute: 'verify' }

export function runPstack(store: Pick<Store, 'getDoc' | 'putDoc'>, ticketId: string): PstackRun {
  const existing = store.getDoc<PstackRun>(RUN_KIND, ticketId)
  if (existing) return existing
  const run: PstackRun = { version: 1, phase: 'intake', checkpoints: {} }
  store.putDoc(RUN_KIND, ticketId, run)
  return run
}

export function recordPstack(
  store: Pick<Store, 'getDoc' | 'putDoc'>, ticket: Ticket, sessionId: string, phase: string, evidence: string, playbook?: string,
): PstackRun {
  const assignment = ticket.assignments.at(-1)
  if (assignment?.state !== 'running' || ticket.ended || assignment.workerSessionId !== sessionId) {
    throw new UserError('pstack checkpoint requires the current worker assignment')
  }
  const run = runPstack(store, ticket.id)
  const expected = next[run.phase]
  if (!expected || expected !== phase) throw new UserError(`pstack expected checkpoint ${expected ?? 'none'}, got ${phase}`)
  const bounded = evidence.trim()
  if (!bounded || bounded.length > 4000) throw new UserError('pstack evidence must contain 1–4000 characters')
  if (expected === 'plan' && !playbook) throw new UserError('pstack plan needs an available playbook')
  const updated: PstackRun = {
    ...run,
    phase: expected,
    ...(expected === 'plan' ? { playbook } : {}),
    checkpoints: { ...run.checkpoints, [expected]: { assignmentId: assignment.id, evidence: bounded } },
  }
  store.putDoc(RUN_KIND, ticket.id, updated)
  return updated
}

export function assertPstackDelivery(store: Pick<Store, 'getDoc' | 'putDoc'>, ticketId: string): void {
  const run = store.getDoc<PstackRun>(RUN_KIND, ticketId)
  if (run && run.phase !== 'verify' && run.phase !== 'delivered') {
    throw new UserError('pstack verification must be recorded before delivery')
  }
}

export function markPstackDelivered(store: Pick<Store, 'getDoc' | 'putDoc'>, ticketId: string): void {
  const run = store.getDoc<PstackRun>(RUN_KIND, ticketId)
  if (run && run.phase !== 'delivered') store.putDoc(RUN_KIND, ticketId, { ...run, phase: 'delivered' })
}

export function assertPstackDelegation(store: Pick<Store, 'getDoc'>, ticketId: string): void {
  if (store.getDoc<PstackRun>(RUN_KIND, ticketId)?.phase === 'intake') {
    throw new UserError('record a pstack plan before delegating')
  }
}
