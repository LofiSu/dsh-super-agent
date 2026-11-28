import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
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
