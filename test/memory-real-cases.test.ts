import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { imessageThreadFor } from '../src/channels/imessage.ts'
import { Daemon } from '../src/harness/daemon.ts'
import { HttpOpenAI, type Model } from '../src/harness/model.ts'
import { AutoDream } from '../src/memory/auto-dream.ts'
import { SessionMemory, type MemorySession } from '../src/memory/tools.ts'
import { Runtime } from '../src/runtime.ts'
import { backupStore, restoreStore } from '../src/store/backup.ts'
import { Store } from '../src/store/sqlite.ts'

const NOW = 1_000_000
const MINUTE = 60_000
const AT = new Date(0).toISOString()
const PAGE = '/memories/wiki/runtime.md'
const SECRET = 'credential-fixture-to-redact'
const redact = (text: string) => text.replaceAll(SECRET, '[redacted]')
const homes: string[] = []
const stores: Store[] = []

interface Prompt {
  evidence: { id: number; text: string }[]
  notes: { path: string; text: string }[]
}

afterEach(() => {
  for (const store of stores.splice(0)) if (store.isOpen) store.close()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lofibot-memory-cases-'))
  homes.push(home)
  return home
}

function open(home = temporaryHome()) {
  const store = new Store(home)
  stores.push(store)
  return { home, store, memory: new SessionMemory(store, redact) }
}

function router(store: Store, thread: string): MemorySession {
  const sessionId = `router:thread:${thread}`
  store.upsertSession({ id: sessionId, role: 'router', status: 'idle', createdAt: AT, heartbeat: AT })
  return { sessionId, role: 'router' }
}

function worker(store: Store, ticketId: string, threads: string[], observed = threads): MemorySession {
  const sessionId = `worker_${ticketId}`
  store.putDoc('ticket', ticketId, {
    id: ticketId, threadKeys: threads, memoryThreadKeys: observed, speculative: false,
    ended: { at: AT, outcome: 'ready', by: 'executor' }, assignments: [],
  })
  store.upsertSession({ id: sessionId, role: 'worker', ticketId, status: 'idle', createdAt: AT, heartbeat: AT })
  return { sessionId, role: 'worker', ticketId }
}

function evidence(store: Store, session: MemorySession, evidenceText: string | null, content?: string) {
  store.appendMessage(session.sessionId, 'user', JSON.stringify({ role: 'user', kind: 'message', evidenceText, content }))
}

function model(complete: Model['complete']): Model {
  return { name: 'real-case-fixture', complete, classify: () => ({ pass: false, strength: 'explicit', reason: 'fixture' }) }
}

function input(request: Parameters<Model['complete']>[0]): Prompt {
  const last = request.messages.at(-1)
  return JSON.parse(last?.content ?? '{}') as Prompt
}

function publish(prompt: Prompt) {
  return { text: JSON.stringify({
    page: prompt.evidence.map(row => row.text).join('\n'), evidence_ids: prompt.evidence.map(row => row.id),
  }) }
}

function page(memory: SessionMemory, session: MemorySession): string | undefined {
  const scope = memory.consolidationScope(session)
  return scope ? memory.readConsolidated(scope) : undefined
}

// Each case is a deterministic memory-specific reconstruction of the linked
// public change or its regression scenario. It does not replay production traffic.
describe('memory acceptance from public repository cases', () => {
  it('01 #188 Feishu conversation-first publishes an owner correction without a Worker', async () => {
    // https://github.com/LofiSu/LofiBot/pull/188
    const { store, memory } = open()
    const direct = router(store, 'feishu:customer-quote')
    const other = router(store, 'feishu:another-chat')
    memory.execute(direct, { command: 'create', path: '/memories/MEMORY.md', file_text: 'Quote runbook' })
    evidence(store, direct, 'For quotations use the finalized Feishu message, never an incoming duplicate.')
    const complete = vi.fn<Model['complete']>(async request => {
      expect(request.role).toBe('router')
      expect(request.tools).toEqual([])
      return publish(input(request))
    })
    const dream = new AutoDream(store, memory, () => model(complete), redact, () => {})
    let pulse: Promise<void> | undefined
    const daemon = new Daemon({ tick() {}, intervalMs: 1_000 }, () => {},
      undefined, undefined, undefined, undefined, undefined, { tick: time => { pulse = dream.tick(time) } })
    daemon.tick(NOW)
    await pulse
    expect(memory.index(direct)).toContain('Quote runbook')
    expect(memory.index(direct)).toContain(PAGE)
    expect(page(memory, direct)).toContain('finalized Feishu message')
    expect(memory.index(other)).toBeUndefined()
    expect(store.listSessions().every(row => row.role === 'router')).toBe(true)
  })

  it('02 #184 a stale quotation completion loses to a concurrent correction and retries cleanly', async () => {
    // https://github.com/LofiSu/LofiBot/pull/184
    const { store, memory } = open()
    const target = router(store, 'feishu:quote-branch')
    const notePath = '/memories/quote.md'
    memory.execute(target, { command: 'create', path: notePath, file_text: 'Use cached parent quote.' })
    evidence(store, target, 'If a quoted follow-up arrives, reconcile the parent in the current thread.')
    let deliver: (() => void) | undefined
    const stale = new AutoDream(store, memory, () => model(request => new Promise(resolve => {
      deliver = () => resolve(publish(input(request)))
    })), redact, () => {})
    const pending = stale.tick(NOW)
    expect(deliver).toBeDefined()
    memory.execute(target, { command: 'str_replace', path: notePath,
      old_str: 'Use cached parent quote.', new_str: 'Owner correction: verify the exact thread before quoting.' })
    deliver!()
    await pending
    expect(page(memory, target)).toBeUndefined()
    const complete = vi.fn<Model['complete']>(async request => {
      expect(input(request).notes).toContainEqual({
        path: notePath, text: 'Owner correction: verify the exact thread before quoting.',
      })
      return publish(input(request))
    })
    await new AutoDream(store, memory, () => model(complete), redact, () => {}).tick(NOW + MINUTE)
    expect(complete).toHaveBeenCalledOnce()
    expect(page(memory, target)).toContain('current thread')
    expect(memory.execute(target, { command: 'view', path: notePath })).toContain('Owner correction')
  })

  it('03 #198 Feishu busy recovery preserves evidence across scan pages and a restart', async () => {
    // https://github.com/LofiSu/LofiBot/pull/198
    const first = open()
    const workers = Array.from({ length: 40 }, (_, index) =>
      worker(first.store, `busy_${index}`, ['im:feishu-busy']))
    evidence(first.store, workers[39]!, 'Keep the interrupted history cursor until dispatch settles.')
    evidence(first.store, workers[0]!, 'Next history poll may consume the resumed page.')
    const received: string[] = []
    const backend = model(async request => {
      const prompt = input(request)
      received.push(...prompt.evidence.map(row => row.text))
      return publish(prompt)
    })
    await new AutoDream(first.store, first.memory, () => backend, redact, () => {}).tick(NOW)
    expect(received).toEqual([])
    first.store.close()
    const recovered = open(first.home)
    const dream = new AutoDream(recovered.store, recovered.memory, () => backend, redact, () => {})
    await dream.tick(NOW + MINUTE)
    await dream.tick(NOW + 2 * MINUTE)
    expect(received).toEqual([
      'Keep the interrupted history cursor until dispatch settles.',
      'Next history poll may consume the resumed page.',
    ])
  })

  it('04 #90 and #107 iMessage lookalike destinations do not share notes after a subscription drops', async () => {
    // https://github.com/LofiSu/LofiBot/pull/90
    // https://github.com/LofiSu/LofiBot/pull/107
    const { store, memory } = open()
    const handle = 'fixture-contact@example.com'
    const directThread = `imessage:${imessageThreadFor({ handle, isGroup: false })}`
    const groupThread = `imessage:${imessageThreadFor({ handle, chatRowId: 42, isGroup: true })}`
    expect(directThread).toBe('imessage:handle:fixture-contact@example.com')
    expect(groupThread).toBe('imessage:group-rowid:42')
    const direct = worker(store, 'direct', [directThread])
    const group = worker(store, 'group', [groupThread])
    const detached = worker(store, 'dropped', [directThread], [directThread, groupThread])
    memory.execute(direct, { command: 'create', path: '/memories/MEMORY.md', file_text: 'Private quote' })
    memory.execute(group, { command: 'create', path: '/memories/MEMORY.md', file_text: 'Group minutes' })
    evidence(store, detached, 'Original group history must remain confined to the detached Worker.')
    await new AutoDream(store, memory, () => model(async req => publish(input(req))), redact, () => {}).tick(NOW)
    expect(page(memory, detached)).toContain('Original group history')
    expect(page(memory, direct)).toBeUndefined()
    expect(page(memory, group)).toBeUndefined()
    expect(memory.index(direct)).not.toContain('Group minutes')
    expect(memory.index(group)).not.toContain('Private quote')
  })

  it('05 #174 connector wakes and generated reminders never become unattended human evidence', async () => {
    // https://github.com/LofiSu/LofiBot/pull/174
    const { store, memory } = open()
    const target = router(store, 'feishu:approvals')
    evidence(store, target, 'CONNECTOR_EVENT\nrecordId=drive-synthetic\nrelatedMemory=Unapproved version')
    evidence(store, target, null, 'PROACTIVE_IDLE\nticketId=t1\nrelatedMemory=Cached version')
    store.appendMessage(target.sessionId, 'assistant', JSON.stringify({
      role: 'assistant', kind: 'message', content: 'The model claimed the old document is approved.',
    }))
    evidence(store, target, `I confirmed the corrected Drive version; never quote ${SECRET}.`)
    const complete = vi.fn<Model['complete']>(async request => {
      const prompt = input(request)
      expect(prompt.evidence).toEqual([{ id: 4, text: 'I confirmed the corrected Drive version; never quote [redacted].' }])
      return publish(prompt)
    })
    await new AutoDream(store, memory, () => model(complete), redact, () => {}).tick(NOW)
    expect(complete).toHaveBeenCalledOnce()
    expect(page(memory, target)).toContain('corrected Drive version')
    expect(page(memory, target)).not.toContain(SECRET)
  })

  it('06 #124 competing SQLite runtimes claim once and reopen without processing a published row again', async () => {
    // https://github.com/LofiSu/LofiBot/pull/124
    const first = open()
    const target = router(first.store, 'feishu:durable-replay')
    evidence(first.store, target, 'Only publish the reconciled result once after restart.')
    const second = open(first.home)
    let deliver: (() => void) | undefined
    const leader = new AutoDream(first.store, first.memory, () => model(req => new Promise(resolve => {
      deliver = () => resolve(publish(input(req)))
    })), redact, () => {})
    const complete = vi.fn<Model['complete']>(async req => publish(input(req)))
    const follower = new AutoDream(second.store, second.memory, () => model(complete), redact, () => {})
    const pending = leader.tick(NOW)
    expect(deliver).toBeDefined()
    await follower.tick(NOW)
    expect(complete).not.toHaveBeenCalled()
    deliver!()
    await pending
    expect(page(second.memory, target)).toContain('once after restart')
    first.store.close()
    second.store.close()
    const restarted = open(first.home)
    await new AutoDream(restarted.store, restarted.memory, () => model(complete), redact, () => {}).tick(NOW + MINUTE)
    expect(complete).not.toHaveBeenCalled()
  })

  it('07 #131 WAL backup restores a coherent page and cursor while pending evidence remains eligible', async () => {
    // https://github.com/LofiSu/LofiBot/pull/131
    const live = open()
    const target = router(live.store, 'cli:snapshot')
    const received: string[] = []
    const backend = model(async req => {
      const prompt = input(req)
      received.push(...prompt.evidence.map(row => row.text))
      return publish(prompt)
    })
    evidence(live.store, target, 'Before backup: use the approved quote.')
    await new AutoDream(live.store, live.memory, () => backend, redact, () => {}).tick(NOW)
    evidence(live.store, target, 'Pending at backup: user corrected the quote expiry.')
    const file = path.join(temporaryHome(), 'snapshot.db')
    backupStore(live.home, file)
    const restoredHome = temporaryHome()
    restoreStore(restoredHome, file)
    const restored = open(restoredHome)
    expect(page(restored.memory, target)).toContain('approved quote')
    await new AutoDream(restored.store, restored.memory, () => backend, redact, () => {}).tick(NOW + MINUTE)
    expect(page(restored.memory, target)).toContain('corrected the quote expiry')
    expect(received).toEqual([
      'Before backup: use the approved quote.',
      'Pending at backup: user corrected the quote expiry.',
    ])
    expect(page(live.memory, target)).toContain('approved quote')
  })

  it('08 #99 mesh evidence backoff survives process loss and leaves sibling scopes independently writable', async () => {
    // https://github.com/LofiSu/LofiBot/pull/99
    const original = open()
    const older = worker(original.store, 'mesh_old', ['im:mesh'])
    const newer = worker(original.store, 'mesh_new', ['im:mesh'])
    const independent = worker(original.store, 'outside', ['im:independent'])
    evidence(original.store, older, 'Old mesh observation needs a confirmed retry.')
    evidence(original.store, newer, 'New mesh correction must follow the older observation.')
    evidence(original.store, independent, 'Independently confirmed local result.')
    const seen: number[] = []
    const backend = model(async req => {
      const prompt = input(req)
      seen.push(prompt.evidence[0]!.id)
      if (seen.length === 1) throw new Error('Upstream mesh provider unavailable')
      return publish(prompt)
    })
    await new AutoDream(original.store, original.memory, () => backend, redact, () => {}).tick(NOW)
    original.store.close()
    const restarted = open(original.home)
    const dream = new AutoDream(restarted.store, restarted.memory, () => backend, redact, () => {})
    await dream.tick(NOW + MINUTE)
    expect(page(restarted.memory, independent)).toContain('Independently confirmed')
    expect(page(restarted.memory, newer)).toBeUndefined()
    await dream.tick(NOW + 5 * MINUTE)
    await dream.tick(NOW + 6 * MINUTE)
    expect(seen).toEqual([1, 3, 1, 2])
    expect(page(restarted.memory, older)).toContain('New mesh correction')
  })

  it('09 #185 the one-shot exit pass publishes a resumed human decision and edits a stale note', async () => {
    // https://github.com/LofiSu/LofiBot/pull/185
    const seed = open()
    const target = router(seed.store, 'cli:human-review')
    const notePath = '/memories/approval.md'
    seed.memory.execute(target, { command: 'create', path: notePath, file_text: 'Continue before owner confirmation.' })
    seed.store.close()
    const backend = new HttpOpenAI('http://127.0.0.1:1/v1', 'fixture', 'fixture')
    const complete = vi.spyOn(backend, 'complete').mockImplementation(async req => {
      const prompt = input(req)
      expect(prompt.evidence.map(row => row.text)).toEqual(['Owner after resume: require confirmation before continuing.'])
      expect(prompt.notes).toContainEqual({ path: notePath, text: 'Continue before owner confirmation.' })
      return { text: JSON.stringify({
        page: 'Require owner confirmation.', evidence_ids: [prompt.evidence[0]!.id],
        edits: [{ path: notePath, text: 'Require confirmation before continuing.' }],
      }) }
    })
    const runtime = Runtime.create({ home: seed.home, model: backend, env: {} })
    try {
      runtime.start({ assessPending: false, memoryOnExit: true })
      evidence(runtime.store, target, null, 'CONTINUATION\nticketId=old\nreason=scheduler')
      evidence(runtime.store, target, 'Owner after resume: require confirmation before continuing.')
      expect(complete).not.toHaveBeenCalled()
    } finally {
      await runtime.finish()
    }
    const restarted = open(seed.home)
    expect(complete).toHaveBeenCalledOnce()
    expect(page(restarted.memory, target)).toContain('Require owner confirmation')
    expect(restarted.memory.execute(target, { command: 'view', path: notePath })).toContain('Require confirmation')
  })

  it('10 #112 and #204 legacy archive keeps old summaries visible only through the archive entry', async () => {
    // https://github.com/LofiSu/LofiBot/pull/112
    // https://github.com/LofiSu/LofiBot/pull/204
    const { home, store, memory } = open()
    const scope = router(store, 'cli:archive-comparison')
    memory.execute(scope, { command: 'create', path: '/memories/MEMORY.md', file_text: 'New trusted index' })
    store.putDoc('ltm', 'old-mesh-summary', {
      id: 'old-mesh-summary', text: 'ARCHIVE_ONLY_OLD_SUMMARY', createdAt: AT, ticketId: 'old-job',
    })
    store.close()
    const inspect = (...args: string[]) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DS_AGENT_')))
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'memory', ...args], {
        encoding: 'utf8', env: { ...env, LOFIBOT_HOME: home, NODE_NO_WARNINGS: '1' }, timeout: 15_000,
      })
      expect(result.status, result.stderr).toBe(0)
      return result.stdout
    }
    const foreground = inspect()
    expect(foreground).toContain('New trusted index')
    expect(foreground).not.toContain('ARCHIVE_ONLY_OLD_SUMMARY')
    expect(inspect('archive')).toContain('ARCHIVE_ONLY_OLD_SUMMARY')
  })
})
