import { describe, expect, it } from 'vitest'
import { supportsReadOnlyDatabaseSync } from '../src/store/sqlite.ts'

describe('read-only SQLite Node.js version support', () => {
  it.each([
    ['21.0.0', false],
    ['22.11.0', false],
    ['22.12.0', true],
    ['23.0.0', false],
    ['23.1.0', false],
    ['23.2.0', true],
    ['24.0.0', true],
  ])('returns %s support as %s', (version, supported) => {
    expect(supportsReadOnlyDatabaseSync(version)).toBe(supported)
  })

  it('defaults to the running Node.js version', () => {
    expect(supportsReadOnlyDatabaseSync()).toBe(
      supportsReadOnlyDatabaseSync(process.versions.node),
    )
  })
})
