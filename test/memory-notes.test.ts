import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryNotes } from '../src/memory/notes.ts'
import { Store } from '../src/store/sqlite.ts'

describe('memory notes', () => {
  let home: string
  let store: Store
  let memory: MemoryNotes

  const execute = (command: string, args: Record<string, unknown>) =>
    memory.execute('owner-a', { command, ...args })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lofibot-memory-notes-'))
    store = new Store(home)
    memory = new MemoryNotes(store, text => text.replaceAll('test-secret', '[redacted]'))
  })

  afterEach(() => {
    try {
      store.close()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('lists its root, redacts writes and persists notes without exposing another scope', () => {
    expect(execute('view', { path: '/memories' })).toContain('/memories')
    execute('create', { path: '/memories/work/偏好.md', file_text: 'test-secret\nsecond\nthird' })
    expect(execute('view', { path: '/memories' })).toContain('/memories/work/偏好.md')
    expect(execute('view', { path: '/memories/work/偏好.md', view_range: [2, -1] }))
      .toContain('     2\tsecond\n     3\tthird')
    expect(() => memory.execute('owner-b', { command: 'view', path: '/memories/work/偏好.md' }))
      .toThrow(/does not exist/)
    store.close()
    store = new Store(home)
    memory = new MemoryNotes(store, text => text)
    expect(execute('view', { path: '/memories/work/偏好.md' })).toContain('[redacted]')
    expect(execute('view', { path: '/memories/work/偏好.md' })).not.toContain('test-secret')
  })

  it('lists directory sizes and caps the listing at two levels without line numbers', () => {
    const path = '/memories'
    expect(execute('view', { path })).toContain('\n0B\t/memories')
    execute('create', { path: '/memories/project/topic/deep.md', file_text: 'x'.repeat(1536) })
    const listing = execute('view', { path })
    expect(listing).toContain('\n1.5K\t/memories/project/topic')
    expect(listing).not.toContain('deep.md')
    expect(execute('view', { path, view_range: [2, 2] })).toBe(listing)
    expect(execute('view', { path: '/memories/project' })).toContain('\n1.5K\t/memories/project/topic/deep.md')
  })

  it('reads a bounded, redacted index from the current scope only', () => {
    expect(memory.readIndex('owner-a')).toBeUndefined()
    execute('create', { path: '/memories/MEMORY.md', file_text: 'test-secret ' + 'a'.repeat(2500) })
    expect(memory.readIndex('owner-b')).toBeUndefined()
    expect(memory.readIndex('owner-a')).toBe('[redacted] ' + 'a'.repeat(2500))
  })

  it('retains oversized index writes and loads only the first 200 lines or 25 KiB', () => {
    const path = '/memories/MEMORY.md'
    const lines = Array.from({ length: 201 }, (_, i) => 'Entry ' + (i + 1))
    expect(() => execute('create', { path, file_text: lines.join('\n') })).toThrow(/was saved.*shorten/)
    expect(memory.readIndex('owner-a')).toBe(lines.slice(0, 200).join('\n'))
    expect(execute('view', { path, view_range: [201, 201] })).toContain('Entry 201')

    const large = Array.from({ length: 9 }, () => '😀'.repeat(900)).join('\n')
    expect(execute('create', { path: '/memories/large.md', file_text: large })).not.toMatch(/shorten/)
    execute('delete', { path })
    expect(() => execute('rename', { old_path: '/memories/large.md', new_path: path })).toThrow(/was saved.*shorten/)
    const loaded = memory.readIndex('owner-a')!
    expect(Buffer.byteLength(loaded)).toBeLessThanOrEqual(25 * 1024)
    expect(Buffer.byteLength(loaded)).toBeGreaterThan(25 * 1024 - 4)
    expect(loaded).not.toContain('�')
  })

  it('reminds the agent to keep an index near its limit concise', () => {
    const path = '/memories/MEMORY.md'
    const lines = Array.from({ length: 180 }, () => 'entry').join('\n')
    expect(execute('create', { path, file_text: lines })).toContain('approaching')
    expect(memory.readIndex('owner-a')).toBe(lines)
  })

  it('replaces literally and inserts at the beginning or after an existing line', () => {
    const path = '/memories/draft.md'
    execute('create', { path, file_text: 'one\r\ntwo\r\n' })
    execute('str_replace', { path, old_str: 'two', new_str: '$&' })
    execute('insert', { path, insert_line: 0, insert_text: 'start\n' })
    execute('insert', { path, insert_line: 3, insert_text: 'end' })
    expect(execute('view', { path })).toContain('1\tstart\n     2\tone\n     3\t$&\n     4\tend')
    execute('str_replace', { path, old_str: '$&' })
    expect(execute('view', { path })).not.toContain('$&')
    expect(() => execute('insert', { path, insert_line: 10, insert_text: 'invalid' })).toThrow(/insert_line/)
  })

  it('moves and deletes directories atomically and refuses existing destinations', () => {
    execute('create', { path: '/memories/project/first.md', file_text: 'alpha' })
    execute('create', { path: '/memories/project/nested/second.md', file_text: 'beta' })
    execute('create', { path: '/memories/archive', file_text: 'existing' })
    expect(() => execute('rename', { old_path: '/memories/project', new_path: '/memories/archive' }))
      .toThrow(/already exists/)
    expect(() => execute('rename', { old_path: '/memories/project', new_path: '/memories/project/child' }))
      .toThrow(/descendant/)
    execute('rename', { old_path: '/memories/project', new_path: '/memories/final' })
    expect(() => execute('view', { path: '/memories/project' })).toThrow(/does not exist/)
    expect(execute('view', { path: '/memories/final/nested/second.md' })).toContain('beta')
    execute('delete', { path: '/memories/final' })
    expect(execute('view', { path: '/memories' })).not.toContain('/memories/final')
    expect(execute('view', { path: '/memories/archive' })).toContain('existing')
    expect(() => execute('delete', { path: '/memories' })).toThrow(/root/)
  })

  it('rejects malformed paths and ambiguous or oversized mutations without changing the note', () => {
    for (const path of ['/memories-other/x', '/memories/../x', '/memories/%2e%2e/x', '/memories/a\\b',
      '/memories/.hidden/x', '/memories/test-secret.md', '/memories/a//b', '/memories/a\u0000b']) {
      expect(() => execute('create', { path, file_text: 'invalid' })).toThrow(/path/i)
    }
    const path = '/memories/a'
    execute('create', { path, file_text: 'one one' })
    expect(() => execute('create', { path, file_text: 'second write' })).toThrow(/already exists/)
    expect(() => execute('create', { path: `${path}/b`, file_text: 'bad hierarchy' })).toThrow(/directory/)
    expect(() => execute('str_replace', { path, old_str: 'one', new_str: 'two' })).toThrow(/multiple/i)
    expect(() => execute('insert', { path, insert_line: 1, insert_text: 'x'.repeat(5000) })).toThrow(/line/)
    expect(execute('view', { path })).toContain('one one')
  })

  it('bounds long reads and allows the caller to continue at a later line', () => {
    const path = '/memories/paged.md'
    const lines = Array.from({ length: 12 }, (_, index) => `section ${index + 1} ${'x'.repeat(2500)}`)
    execute('create', { path, file_text: lines.join('\n') })
    const first = execute('view', { path })
    expect(first.length).toBeLessThanOrEqual(16_000)
    expect(first).toContain('line 7')
    expect(execute('view', { path, view_range: [7, -1] })).toContain('    12\tsection 12')
  })
})
