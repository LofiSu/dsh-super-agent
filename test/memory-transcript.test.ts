import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionMemory } from '../src/memory/tools.ts'
import { readMemoryTranscript } from '../src/memory/transcript.ts'
import { MIGRATIONS, migrate } from '../src/store/schema.ts'
import { Store } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

const homes: string[] = []
function testHome(): string {
  const home = tempHome()
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

const redact = (text: string) => text.replaceAll('fake-token', '[REDACTED]')

function append(store: Store, session: string, role: string, content: string, extra = {}) {
  store.appendMessage(session, role, JSON.stringify({ kind: 'message', role, content, ...extra }))
}

describe('transcript evidence', () => {
  it('uses exclusive cursors scoped to the harness session across reopen and newer appends', () => {
    const home = testHome()
    const original = new Store(home)
    try {
      append(original, 'router:thread:a', 'user', 'first message')
      append(original, 'router:thread:b', 'user', 'other conversation')
      append(original, 'router:thread:a', 'assistant', 'first answer')
    } finally {
      original.close()
    }
    const reopened = new Store(home)
    try {
      const newest = readMemoryTranscript(reopened, 'router:thread:a', { limit: 1 }, redact)
      expect(newest.entries.map(entry => entry.text)).toEqual(['first answer'])
      expect(newest.before).toBe(newest.entries[0]?.id)
      append(reopened, 'router:thread:a', 'user', 'newer than cursor')
      const older = readMemoryTranscript(reopened, 'router:thread:a', { before: newest.before }, redact)
      expect(older.entries.map(entry => entry.text)).toEqual(['first message'])
      expect(older.before).toBeUndefined()
      expect(() => readMemoryTranscript(reopened, 'router:thread:a', { sessionId: 'router:thread:b' }, redact))
        .toThrow(/current session/)
    } finally {
      reopened.close()
    }
  })

  it('indexes a version 7 journal without rewriting historical evidence', () => {
    const home = testHome()
    const database = new DatabaseSync(path.join(home, 'lofibot.db'))
    try {
      migrate(database, MIGRATIONS.filter(migration => migration.version <= 7), 7)
      database.prepare(
        "INSERT INTO messages(id, session_id, role, body, created_at) VALUES(103, 'router', 'user', ?, ?)",
      ).run(JSON.stringify({ kind: 'message', role: 'user', content: 'legacy evidence' }), '2026-01-01T00:00:00Z')
    } finally {
      database.close()
    }
    const upgraded = new Store(home)
    try {
      expect(upgraded.schemaVersion).toBe(8)
      expect(readMemoryTranscript(upgraded, 'router', {}, redact).entries).toEqual([
        { id: 103, role: 'user', at: '2026-01-01T00:00:00Z', text: 'legacy evidence' },
      ])
    } finally {
      upgraded.close()
    }
    const probe = new DatabaseSync(path.join(home, 'lofibot.db'), { readOnly: true })
    try {
      const indexColumns = probe.prepare("SELECT name FROM pragma_index_info('messages_session_id_idx')").all()
      expect(indexColumns).toEqual([{ name: 'session_id' }, { name: 'id' }])
    } finally {
      probe.close()
    }
  })

  it('skips tool entries, tool arguments, synthetic or damaged rows and redacts before truncation', () => {
    const store = new Store(testHome())
    try {
      append(store, 'worker_ticket_a', 'user', 'TASK\nticketId=ticket_a\nmemory=internal')
      append(store, 'worker_ticket_a', 'user', 'JOB_COMPLETE\njobId=j', { evidenceText: null })
      append(store, 'worker_ticket_a', 'user', 'FOLLOWUP\nticketId=ticket_a\ntext=ignored', {
        evidenceText: 'actual user message fake-token',
      })
      append(store, 'worker_ticket_a', 'assistant', 'visible answer', {
        toolCalls: [{ name: 'memory_transcript', args: { private: 'excluded tool argument' } }],
      })
      append(store, 'worker_ticket_a', 'tool', 'excluded tool output')
      store.appendMessage('worker_ticket_a', 'user', 'Torn JSON')
      store.appendMessage('worker_ticket_a', 'user', JSON.stringify({ role: 'assistant', kind: 'message', content: 'mismatch' }))
      append(store, 'worker_ticket_a', 'user', 'z'.repeat(65_536))
      append(store, 'worker_ticket_a', 'assistant', 'a'.repeat(1_195) + 'fake-token' + 'b'.repeat(50))
      const result = readMemoryTranscript(store, 'worker_ticket_a', {}, redact)
      expect(result.entries).toMatchObject([
        { text: 'a'.repeat(1_195) + '[REDA', truncated: true },
        { text: 'visible answer' },
        { text: 'actual user message [REDACTED]' },
      ])
      expect(result.before).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('returns a continuation even when an entire scan window consists of synthetic prompts', () => {
    const store = new Store(testHome())
    try {
      append(store, 'router', 'user', 'historical text')
      for (let i = 0; i < 100; i += 1) append(store, 'router', 'user', 'TASK\nticketId=ticket_a')
      const result = readMemoryTranscript(store, 'router', {}, redact)
      expect(result.entries).toEqual([])
      expect(result.before).toEqual(expect.any(Number))
      expect(readMemoryTranscript(store, 'router', { before: result.before }, redact).entries[0]?.text)
        .toBe('historical text')
    } finally {
      store.close()
    }
  })

  it('bounds the serialized page and validates numeric controls', () => {
    const store = new Store(testHome())
    try {
      for (let i = 0; i < 12; i += 1) append(store, 'router', 'assistant', '\u0001'.repeat(1_200))
      const result = readMemoryTranscript(store, 'router', { limit: 12 }, redact)
      expect(JSON.stringify(result).length).toBeLessThan(8_100)
      expect(result.entries).toHaveLength(1)
      expect(result.before).toBe(result.entries[0]?.id)
      expect(() => readMemoryTranscript(store, 'router', { limit: 13 }, redact)).toThrow(/limit/)
      expect(() => readMemoryTranscript(store, 'router', { before: 2.5 }, redact)).toThrow(/before/)
    } finally {
      store.close()
    }
  })
})


it('looks up and searches redacted original evidence across authorized sibling sessions', () => {
  const store = new Store(testHome())
  try {
    const memory = new SessionMemory(store, redact)
    const at = '2026-01-01T00:00:00Z'
    const threads = ['cli:project', 'imessage:project']
    const worker = (id: string, keys = threads, observed = keys, restrictions = {}) => {
      const sessionId = 'worker_' + id
      store.putDoc('ticket', id, { threadKeys: keys, memoryThreadKeys: observed, ...restrictions })
      store.upsertSession({ id: sessionId, role: 'worker', ticketId: id, status: 'idle', heartbeat: at, createdAt: at })
      return sessionId
    }
    const author = worker('author')
    const reader = worker('reader', [...threads].reverse())
    append(store, author, 'user', 'assembled content', { evidenceText: 'Old deployment evidence fake-token' })
    append(store, author, 'assistant', 'private deployment answer')
    append(store, author, 'user', 'private deployment envelope')
    append(store, author, 'tool', 'private deployment output')
    append(store, worker('subset', threads.slice(0, 1)), 'user', 'ignored', { evidenceText: 'other deployment' })
    append(store, worker('speculative', threads, threads, { speculative: true }), 'user', 'ignored', { evidenceText: 'speculative deployment' })
    append(store, worker('silent', threads, threads, { ended: { silent: true } }), 'user', 'ignored', { evidenceText: 'silent deployment' })
    append(store, author, 'user', 'ignored', { evidenceText: 'CONNECTOR_EVENT\ndeployment notice' })
    append(store, reader, 'user', 'assembled content', { evidenceText: 'New deployment evidence' })

    const newest = memory.transcript(reader, { scope: 'memory', query: 'DEPLOYMENT', limit: 1 })
    expect(newest.entries.map(entry => entry.text)).toEqual(['New deployment evidence'])
    const older = memory.transcript(reader, { scope: 'memory', query: 'deployment', before: newest.before })
    const ref = { id: 1, sessionId: author }
    expect(older.entries).toEqual([expect.objectContaining({ ref, text: 'Old deployment evidence [REDACTED]' })])
    expect(memory.transcript(reader, { ref })).toEqual(older)
    expect(memory.transcript(reader, { ref: { id: 1, sessionId: reader } }).entries).toEqual([])
    expect(() => memory.transcript(reader, { ref, limit: 2 })).toThrow(/ref/)
    expect(() => memory.transcript(reader, { scope: 'memory', query: ' ' })).toThrow(/query/)
    expect(memory.transcript(reader, { ref: { id: 2, sessionId: author } }).entries).toEqual([])
    expect(memory.transcript(reader, { scope: 'memory', query: 'fake-token' }).entries).toEqual([])
    expect(memory.transcript(reader, {}).entries.map(entry => entry.text)).toEqual(['New deployment evidence'])
    expect(memory.transcript('router:thread:unrelated', { ref }).entries).toEqual([])

    worker('author', threads.slice(0, 1), threads)
    expect(memory.transcript(reader, { ref }).entries).toEqual([])
    expect(memory.transcript(reader, { scope: 'memory', query: 'Old deployment' }).entries).toEqual([])

    worker('author')
    worker('reader', threads.slice(0, 1), threads)
    expect(memory.transcript(reader, { ref }).entries).toEqual([])
  } finally {
    store.close()
  }
})


it('includes qualified references in the serialized transcript page budget', () => {
  const store = new Store(testHome())
  try {
    const sessionId = 'router:thread:' + '\u0001'.repeat(300)
    const at = '2026-01-01T00:00:00Z'
    store.upsertSession({ id: sessionId, role: 'router', status: 'idle', heartbeat: at, createdAt: at })
    append(store, sessionId, 'user', '', { evidenceText: '\u0001'.repeat(1_200) })
    const memory = new SessionMemory(store, redact)
    const ref = { sessionId, id: 1 }
    const result = memory.transcript(sessionId, { scope: 'memory' })
    expect(result.entries).toEqual([expect.objectContaining({ ref, truncated: true })])
    expect(result.entries[0]?.text.length).toBeGreaterThan(0)
    expect(JSON.stringify(result).length).toBeLessThan(8_100)
    expect(memory.transcript(sessionId, { ref })).toEqual(result)
  } finally {
    store.close()
  }
})
