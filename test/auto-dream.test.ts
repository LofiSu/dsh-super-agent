import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Daemon } from '../src/harness/daemon.ts'
import { HttpOpenAI, type Model } from '../src/harness/model.ts'
import { AutoDream } from '../src/memory/auto-dream.ts'
import { SessionMemory } from '../src/memory/tools.ts'
import type { Ticket } from '../src/shared/types.ts'
import { Runtime } from '../src/runtime.ts'
import { Store } from '../src/store/sqlite.ts'

const roots: string[] = []
const stores: Store[] = []
const now = 1_000_000
const id = 'router:thread:owner'
const session = { sessionId: id, role: 'router' as const }
const redact = (text: string): string => text.replaceAll('private-token', '[redacted]')

afterEach(() => {
  for (const store of stores.splice(0)) if (store.isOpen) store.close()
  for (const home of roots.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function fixture(home?: string) {
  if (!home) {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-dream-'))
    roots.push(home)
  }
  const store = new Store(home)
  stores.push(store)
  store.upsertSession({
    id, role: 'router', status: 'idle',
    heartbeat: new Date(0).toISOString(), createdAt: new Date(0).toISOString(),
  })
  return { home, store, memory: new SessionMemory(store, redact) }
}

function append(store: Store, text: string): void {
  store.appendMessage(id, 'user', JSON.stringify({ role: 'user', kind: 'message', evidenceText: text }))
}

function stub(complete: Model['complete']): Model {
  return { name: 'fixture', complete, classify: () => ({ pass: false, strength: 'explicit', reason: 'fixture' }) }
}

it('publishes on a daemon pulse, indexes the result, and resumes corrections after reopen', async () => {
  const first = fixture()
  first.memory.execute(session, { command: 'create', path: '/memories/MEMORY.md', file_text: 'Manual navigation' })
  append(first.store, 'Use npm. private-token')
  const complete = vi.fn<Model['complete']>(async request => {
    expect(request.tools).toEqual([])
    const body = JSON.parse(request.messages[1]!.content) as { evidence: { id: number; text: string }[] }
    expect(body.evidence[0]!.text).not.toContain('private-token')
    return { text: JSON.stringify({ page: body.evidence[0]!.text, evidence_ids: [body.evidence[0]!.id] }) }
  })
  const background = new AutoDream(first.store, first.memory, () => stub(complete), redact, () => {})
  let pulse: Promise<void> | undefined
  const daemon = new Daemon({ tick: () => {}, intervalMs: 1_000 }, () => {},
    undefined, undefined, undefined, undefined, undefined, { tick: time => { pulse = background.tick(time) } })
  daemon.tick(now)
  await pulse
  expect(first.memory.index(session)).toContain('/memories/wiki/runtime.md')
  expect(first.memory.index(session)).toContain('Manual navigation')
  expect(first.memory.execute(session, { command: 'view', path: '/memories/wiki/runtime.md' })).toContain('Use npm')
  await background.tick(now + 60_000)
  expect(complete).toHaveBeenCalledTimes(1)
  first.store.close()

  const restarted = fixture(first.home)
  append(restarted.store, 'Correction: use pnpm.')
  const next = new AutoDream(restarted.store, restarted.memory, () => stub(complete), redact, () => {})
  await next.tick(now + 120_000)
  expect(complete).toHaveBeenCalledTimes(2)
  const page = restarted.memory.execute(session, { command: 'view', path: '/memories/wiki/runtime.md' })
  expect(page).toContain('use pnpm')
  expect(page).not.toContain('Use npm')
  expect(restarted.memory.index({ sessionId: 'router:thread:other', role: 'router' })).toBeUndefined()
})

it('retries invalid provenance and fences publication after shutdown', async () => {
  const { store, memory } = fixture()
  append(store, 'Use pnpm.')
  const invalid = vi.fn(async () => ({ text: '{"page":"invalid","evidence_ids":[999]}' }))
  await new AutoDream(store, memory, () => stub(invalid), redact, () => {}).tick(now)
  expect(memory.index(session)).toBeUndefined()
  const recover = vi.fn<Model['complete']>(async () => ({ text: '{"page":"Use pnpm.","evidence_ids":[1]}' }))
  const retry = new AutoDream(store, memory, () => stub(recover), redact, () => {})
  await retry.tick(now + 60_000)
  expect(recover).not.toHaveBeenCalled()

  let settle: ((value: { text: string }) => void) | undefined
  const delayed = new AutoDream(store, memory, () => stub(() => new Promise(resolve => { settle = resolve })), redact, () => {})
  const work = delayed.tick(now + 300_000)
  delayed.stop()
  settle?.({ text: '{"page":"Use pnpm.","evidence_ids":[1]}' })
  await work
  expect(memory.index(session)).toBeUndefined()
  await retry.tick(now + 360_000)
  expect(memory.index(session)).toContain('/memories/wiki/runtime.md')
})

it('starts automatic consolidation through Runtime without running the memory CLI', async () => {
  const seed = fixture()
  append(seed.store, 'Use pnpm.')
  seed.store.close()
  const model = new HttpOpenAI('http://127.0.0.1:1/v1', 'fixture', 'fixture')
  const complete = vi.spyOn(model, 'complete').mockResolvedValue({
    text: '{"page":"Use pnpm.","evidence_ids":[1]}',
  })
  const runtime = Runtime.create({ home: seed.home, model, env: {} })
  try {
    runtime.start({ assessPending: false })
    await vi.waitFor(() => {
      expect(new SessionMemory(runtime.store, redact).index(session)).toContain('/memories/wiki/runtime.md')
    })
    expect(complete).toHaveBeenCalledTimes(1)
  } finally {
    await runtime.finish()
  }
})

it('cannot let older evidence overwrite a correction in a shared Worker scope', async () => {
  const { store, memory } = fixture()
  const heartbeat = new Date(0).toISOString()
  const oldId = 'worker_old'
  const recentId = 'worker_recent'
  const worker = (ticketId: string, status: 'idle' | 'running') => {
    store.putDoc('ticket', ticketId, {
      id: ticketId, threadKeys: ['cli:local'], memoryThreadKeys: ['cli:local'], speculative: false,
    })
    store.upsertSession({ id: `worker_${ticketId}`, role: 'worker', ticketId, status, heartbeat, createdAt: heartbeat })
  }
  worker('old', 'running')
  worker('recent', 'idle')
  store.appendMessage(oldId, 'user', JSON.stringify({ role: 'user', kind: 'message', evidenceText: 'Use npm.' }))
  store.appendMessage(recentId, 'user', JSON.stringify({ role: 'user', kind: 'message', evidenceText: 'Correction: use pnpm.' }))
  const complete = vi.fn<Model['complete']>(async () => ({
    text: '{"page":"Use pnpm.","evidence_ids":[2]}',
  }))
  const background = new AutoDream(store, memory, () => stub(complete), redact, () => {})
  await background.tick(now)
  worker('old', 'idle')
  await background.tick(now + 60_000)
  expect(complete).toHaveBeenCalledTimes(1)
  expect(memory.execute({ sessionId: recentId, role: 'worker', ticketId: 'recent' }, {
    command: 'view', path: '/memories/wiki/runtime.md',
  })).toContain('Use pnpm.')
  const ticket = store.getDoc<Ticket>('ticket', 'recent')!
  expect(memory.recallForDestination(ticket, { source: 'cli', thread: 'local' })).toContain('Use pnpm.')
  expect(memory.recallForDestination(ticket, { source: 'im', thread: 'local' })).toBeUndefined()
  expect(memory.recallForDestination({ ...ticket, threadKeys: ['cli:local', 'im:other'] }, {
    source: 'cli', thread: 'local',
  })).toBeUndefined()

})

it('runs a bounded exit pass and rewrites supplied notes in the same publication', async () => {
  const seed = fixture()
  seed.memory.execute(session, { command: 'create', path: '/memories/setup.md', file_text: 'Use npm.' })
  seed.store.close()
  const model = new HttpOpenAI('http://127.0.0.1:1/v1', 'fixture', 'fixture')
  const complete = vi.spyOn(model, 'complete').mockImplementation(async request => {
    const input = JSON.parse(request.messages[1]!.content) as {
      notes: { text: string }[]; evidence: { id: number }[]
    }
    expect(input.notes[0]?.text).toBe('Use npm.')
    return { text: JSON.stringify({
      page: 'Use pnpm.', evidence_ids: [input.evidence[0]!.id],
      edits: [{ path: '/memories/setup.md', text: 'Use pnpm.' }],
    }) }
  })
  const runtime = Runtime.create({ home: seed.home, model, env: {} })
  runtime.start({ assessPending: false, memoryOnExit: true })
  expect(complete).not.toHaveBeenCalled()
  append(runtime.store, 'Correction: use pnpm.')
  await runtime.finish()
  const reopened = fixture(seed.home)
  expect(complete).toHaveBeenCalledTimes(1)
  expect(reopened.memory.index(session), runtime.log.text()).toContain('/memories/wiki/runtime.md')
  expect(reopened.memory.execute(session, { command: 'view', path: '/memories/setup.md' })).toContain('Use pnpm.')
})

it('does not log an upstream error that echoes private transcript text', async () => {
  const { store, memory } = fixture()
  append(store, 'A private remark absent from configured secrets.')
  const logs: string[] = []
  const background = new AutoDream(store, memory, () => stub(async () => {
    throw new Error('A private remark absent from configured secrets.')
  }), redact, message => logs.push(message))
  await background.tick(now)
  expect(logs).toEqual(['[memory] background consolidation failed; will retry'])
})


it('ignores scheduler envelopes previously stored as apparent human evidence', async () => {
  const { store, memory } = fixture()
  append(store, 'PROACTIVE_IDLE\nticketId=ticket_1\nrelatedMemory=generated reminder')
  append(store, 'Use pnpm.')
  const complete = vi.fn<Model['complete']>(async request => {
    const input = JSON.parse(request.messages[1]!.content) as { evidence: { id: number; text: string }[] }
    expect(input.evidence).toEqual([{ id: 2, text: 'Use pnpm.' }])
    return { text: '{"page":"Use pnpm.","evidence_ids":[2]}' }
  })
  await new AutoDream(store, memory, () => stub(complete), redact, () => {}).tick(now)
  expect(memory.index(session)).toContain('/memories/wiki/runtime.md')
})


it('uses the same Worker model as foreground work', async () => {
  const seed = fixture()
  const at = new Date(0).toISOString()
  const workerId = 'worker_ticket_role'
  seed.store.putDoc('ticket', 'ticket_role', {
    id: 'ticket_role', threadKeys: ['cli:local'], memoryThreadKeys: ['cli:local'], speculative: false,
    assignments: [], ended: { at, outcome: 'ready', by: 'executor' },
  })
  seed.store.upsertSession({
    id: workerId, role: 'worker', ticketId: 'ticket_role', status: 'idle', createdAt: at, heartbeat: at,
  })
  seed.store.appendMessage(workerId, 'user', JSON.stringify({
    role: 'user', kind: 'message', evidenceText: 'Use pnpm.',
  }))
  seed.store.close()
  const main = new HttpOpenAI('http://127.0.0.1:1/v1', 'default-fixture', 'default')
  const worker = new HttpOpenAI('http://127.0.0.1:2/v1', 'worker-fixture', 'worker')
  const primary = vi.spyOn(main, 'complete')
  const effective = vi.spyOn(worker, 'complete').mockResolvedValue({
    text: '{"page":"Use pnpm.","evidence_ids":[1]}',
  })
  const runtime = Runtime.create({ home: seed.home, model: main, models: { worker }, env: {} })
  try {
    runtime.start({ assessPending: false })
    await vi.waitFor(() => expect(new SessionMemory(runtime.store, redact).index({
      sessionId: workerId, role: 'worker', ticketId: 'ticket_role',
    })).toContain('/memories/wiki/runtime.md'))
    expect(effective).toHaveBeenCalledTimes(1)
    expect(primary).not.toHaveBeenCalled()
  } finally {
    await runtime.finish()
  }
})
