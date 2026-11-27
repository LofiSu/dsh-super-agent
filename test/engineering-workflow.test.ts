import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import { runPstack, recordPstack, assertPstackDelivery } from '../src/core/pstack-run.ts'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

it('persists a default run and requires verification after a plan is recorded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-pstack-test-'))
  homes.push(dir)
  const ticket = { id: 'ticket_123', assignments: [{ id: 'asg_1', state: 'running', workerSessionId: 'worker_ticket_123' }] } as Ticket
  let store = new Store(dir)
  try {
    expect(runPstack(store, ticket.id).phase).toBe('intake')
    expect(() => assertPstackDelivery(store, ticket.id)).toThrow('verification')
    recordPstack(store, ticket, 'worker_ticket_123', 'plan', 'Check the contract', 'pstack-playbook-investigation')
    expect(() => assertPstackDelivery(store, ticket.id)).toThrow('verification')
    recordPstack(store, ticket, 'worker_ticket_123', 'execute', 'Traced the callers')
    store.close()
    store = new Store(dir)
    expect(runPstack(store, ticket.id).phase).toBe('execute')
    expect(() => recordPstack(store, ticket, 'another-session', 'verify', 'Read the source')).toThrow('assignment')
    recordPstack(store, ticket, 'worker_ticket_123', 'verify', 'Compared callers against the tests')
    expect(() => assertPstackDelivery(store, ticket.id)).not.toThrow()
  } finally {
    store.close()
  }
})
