import { describe, expect, it } from 'vitest'
import { Store, supportsReadOnlyDatabaseSync } from '../src/store/sqlite.ts'
import { tempHome } from './fixtures.ts'

const readOnlySupported = supportsReadOnlyDatabaseSync()

describe('read-only Store writes', () => {
  describe.skipIf(!readOnlySupported)('success path on runtimes with a read-only SQLite opener', () => {
    it('rejects document writes and ID allocation before SQLite, while keeping reads available', () => {
      const home = tempHome()
      const writable = new Store(home)
      writable.putDoc('ticket', 'ticket-1', { title: 'original' })
      writable.close()

      const readOnly = Store.openReadOnly(home)
      try {
        expect(() => readOnly.putDoc('ticket', 'ticket-1', { title: 'changed' }))
          .toThrowError(new Error('store is open read-only'))
        expect(() => readOnly.putDoc('ticket', 'ticket-2', { title: 'inserted' }))
          .toThrowError(new Error('store is open read-only'))
        expect(() => readOnly.deleteDoc('ticket', 'ticket-1'))
          .toThrowError(new Error('store is open read-only'))
        expect(() => readOnly.nextId('test'))
          .toThrowError(new Error('store is open read-only'))

        expect(readOnly.getDoc('ticket', 'ticket-1')).toEqual({ title: 'original' })
        expect(readOnly.listDocs('ticket')).toEqual([{ title: 'original' }])
        expect(readOnly.listDocIdsByPrefix('ticket', 'ticket-')).toEqual(['ticket-1'])
        expect(readOnly.health()).toBe('ok')
      } finally {
        readOnly.close()
      }

      const reopened = Store.openReadOnly(home)
      try {
        expect(reopened.getDoc('ticket', 'ticket-1')).toEqual({ title: 'original' })
        expect(reopened.getDoc('ticket', 'ticket-2')).toBeUndefined()
        expect(reopened.listDocIdsByPrefix('ticket', 'ticket-')).toEqual(['ticket-1'])
      } finally {
        reopened.close()
      }
    })
  })

  describe.skipIf(readOnlySupported)('version gate on runtimes without a read-only SQLite opener', () => {
    it('rejects openReadOnly with the version error before touching the database', () => {
      const home = tempHome()
      const writable = new Store(home)
      writable.putDoc('ticket', 'ticket-1', { title: 'original' })
      writable.close()

      let thrown: unknown
      try {
        Store.openReadOnly(home)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toBe('read-only SQLite access requires Node.js 22.12+ or 23.2+')
      // The version gate runs before the read-only open, so the writable store
      // data stays untouched on disk.
      const reopened = new Store(home)
      try {
        expect(reopened.getDoc('ticket', 'ticket-1')).toEqual({ title: 'original' })
      } finally {
        reopened.close()
      }
    })
  })

  it('reports the running runtime support predicate consistently', () => {
    expect(readOnlySupported).toBe(supportsReadOnlyDatabaseSync(process.versions.node))
  })

  it('keeps document writes, deletes, and ID allocation available on writable Stores', () => {
    const store = new Store(tempHome())
    try {
      store.putDoc('ticket', 'ticket-1', { title: 'writable' })
      expect(store.getDoc('ticket', 'ticket-1')).toEqual({ title: 'writable' })
      expect(store.nextId('test')).toBe('test_1')
      store.deleteDoc('ticket', 'ticket-1')
      expect(store.getDoc('ticket', 'ticket-1')).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
