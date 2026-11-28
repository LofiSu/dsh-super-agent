import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runTurn } from '../src/harness/loop.ts'
import type { CompletionRequest, Model } from '../src/harness/model.ts'
import { SessionJournal } from '../src/harness/session.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import { dreamMemory } from '../src/memory/dream.ts'
import { SessionMemory } from '../src/memory/tools.ts'
import { Metrics } from '../src/metrics/metrics.ts'
import type { EnvPort, RolePorts } from '../src/shared/ports.ts'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []
const stores: Store[] = []
const redact = (text: string) => text.replaceAll('clear-secret', '[redacted]')

afterEach(() => {
  for (const store of stores.splice(0)) if (store.isOpen) store.close()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-memory-harness-'))
  homes.push(home)
  return home
}

function open(home: string) {
  const store = new Store(home)
  stores.push(store)
  const memory = new SessionMemory(store, redact)
  const metrics = new Metrics(home)
  const tools = new ToolRegistry({
    store, memory, metrics, redact, log: () => {},
    ports: {} as RolePorts, env: {} as EnvPort,
    scheduleJob: () => {}, routerTurn: async () => {},
  })
  return { store, memory, metrics, tools, redact, log: () => {},
    journal: new SessionJournal(path.join(home, 'sessions'), store, () => {}) }
}

function scripted(complete: Model['complete']): Model {
  return {
    name: 'test-model',
    classify: () => ({ pass: true, strength: 'explicit', reason: 'explicit' }),
    complete,
  }
}

it('persists tool-authored notes across restart and injects only the current scope index', async () => {
  const home = tempHome()
  const first = open(home)
  const session = { id: 'router:thread:one', role: 'router' as const }
  let calls = 0
  await runTurn({ ...first, session, prompt: 'Remember the wiki path', model: scripted(async request => {
    expect(request.tools.map(tool => tool.name)).toContain('memory')
    if (calls++) return { text: 'Saved' }
    return { toolCalls: [{ name: 'memory', id: 'write', args: {
      command: 'create', path: '/memories/MEMORY.md', file_text: 'See /memories/wiki/setup.md. clear-secret',
    } }] }
  }) })
  first.store.close()

  const restarted = open(home)
  const seen: CompletionRequest[] = []
  const model = scripted(async request => {
    seen.push(structuredClone(request))
    return { text: 'Done' }
  })
  await runTurn({ ...restarted, model, session, prompt: 'Continue' })
  await runTurn({ ...restarted, model, session: { ...session, id: 'router:thread:two' }, prompt: 'Continue' })
  expect(seen[0]?.messages.at(-2)?.content).toContain('/memories/wiki/setup.md')
  expect(seen[0]?.messages.at(-1)?.content).toBe('Continue')
  expect(JSON.stringify(seen)).not.toContain('clear-secret')
  expect(JSON.stringify(seen[1]?.messages)).not.toContain('/memories/wiki/setup.md')
  expect(restarted.journal.history(session.id).some(row => row.content?.startsWith('Session memory index'))).toBe(false)
  await expect(restarted.tools.invoke({ name: 'memory', id: 'w', args: {
    command: 'view', path: '/memories',
  } }, { sessionId: 'watchdog', role: 'watchdog' })).rejects.toThrow(/not available/)
  expect((await restarted.tools.specsFor('router', 'router')).map(tool => tool.name)).not.toContain('memory')
  await expect(restarted.tools.invoke({ name: 'memory_transcript', id: 'shared', args: {} },
    { sessionId: 'router', role: 'router' })).rejects.toThrow(/not available/)
})

it('consolidates with scoped evidence and exposes only memory tools', async () => {
  const state = open(tempHome())
  const session = { id: 'router:thread:a', role: 'router' as const }
  state.journal.append(session.id, {
    role: 'user', kind: 'message', content: 'Use pnpm', evidenceText: 'Use pnpm',
  })
  state.journal.append('router:thread:b', {
    role: 'user', kind: 'message', content: 'Private text', evidenceText: 'Private text',
  })
  let step = 0
  const model = scripted(async request => {
    expect(request.tools.map(tool => tool.name)).toEqual(['memory', 'memory_transcript'])
    if (step++ === 0) return { toolCalls: [
      { name: 'memory', id: 'premature', args: {
        command: 'create', path: '/memories/premature.md', file_text: 'Unverified',
      } },
      { name: 'memory_transcript', id: 'evidence', args: {} },
    ] }
    if (step === 2) {
      expect(request.messages.at(-2)?.content).toContain('Read user transcript evidence')
      expect(request.messages.at(-1)?.content).toContain('Use pnpm')
      expect(request.messages.at(-1)?.content).not.toContain('Private text')
      const evidence = JSON.parse(request.messages.at(-1)!.content) as { entries: { id: number }[] }
      return { toolCalls: [{ name: 'memory', id: 'index', args: {
        command: 'create', path: '/memories/MEMORY.md', file_text: 'Use pnpm',
        evidence_ids: evidence.entries.map(row => row.id),
      } }] }
    }
    return { text: 'Saved' }
  })
  expect(await dreamMemory(model, state.memory, session, redact)).toEqual({
    summary: 'Saved', writes: 1, limitReached: false,
  })
  expect(state.memory.index({ sessionId: session.id, role: session.role })).toContain('Use pnpm')
  expect(state.memory.index({ sessionId: 'router:thread:b', role: 'router' })).toBeUndefined()
})

it('shares Worker notes across tickets with identical thread sets and rejects speculative writes', () => {
  const state = open(tempHome())
  const worker = (ticketId: string, threadKeys: string[], speculative = false) => {
    state.store.putDoc('ticket', ticketId, { id: ticketId, speculative, threadKeys, memoryThreadKeys: threadKeys })
    return { sessionId: 'worker_' + ticketId, ticketId, role: 'worker' as const }
  }
  const first = worker('first', ['thread-B', 'thread-A'])
  const next = worker('next', ['thread-A', 'thread-B'])
  const other = worker('other', ['thread-A'])
  const speculative = worker('speculative', ['thread-A', 'thread-B'], true)
  const create = { command: 'create', path: '/memories/MEMORY.md', file_text: 'Two-source context' }
  state.memory.execute(first, create)
  expect(state.memory.index(next)).toBe('Two-source context')
  expect(state.memory.index(other)).toBeUndefined()
  expect(state.memory.index(speculative)).toBeUndefined()
  expect(() => state.memory.execute(speculative, create)).toThrow(/speculative/i)
  state.store.putDoc('ticket', first.ticketId, {
    id: first.ticketId, speculative: false, threadKeys: ['thread-A'], memoryThreadKeys: ['thread-A', 'thread-B'],
  })
  expect(state.memory.index(first)).toBeUndefined()
  state.memory.execute(first, create)
  expect(state.memory.index(other)).toBeUndefined()
  state.store.putDoc('ticket', speculative.ticketId, {
    id: speculative.ticketId, speculative: false, ended: { silent: true },
    threadKeys: ['thread-A', 'thread-B'], memoryThreadKeys: ['thread-A', 'thread-B'],
  })
  expect(() => state.memory.execute(speculative, create)).toThrow(/speculative/i)
})
