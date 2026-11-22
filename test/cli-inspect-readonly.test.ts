import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-cli-inspect-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function run(name: string, state: string, args: string[] = []) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/main.ts', name, ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DS_AGENT_HOME: state, NODE_NO_WARNINGS: '1' },
    },
  )
}

function databaseFiles(state: string): string[] {
  return ['ds-agent.db', 'ds-agent.db-wal', 'ds-agent.db-shm']
    .filter(file => fs.existsSync(path.join(state, file)))
}

function databaseHash(state: string): string {
  return createHash('sha256').update(fs.readFileSync(path.join(state, 'ds-agent.db'))).digest('hex')
}

describe('read-only inspect commands', () => {
  it.each(['status', 'panel', 'health', 'tasks', 'memory'])(
    '%s fails closed without creating a database on an empty home',
    command => {
      const state = home()
      const result = run(command, state)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('local state database does not exist')
      expect(databaseFiles(state)).toEqual([])
    },
  )

  it.each([
    ['approvals', []],
    ['collab', ['latest']],
    ['recovery-effects', ['latest']],
    ['recovery-effects', ['latest', 'retry', 'effect_missing']],
    ['recovery-effects', ['latest', 'acknowledge', 'effect_missing']],
  ])('%s fails closed without creating a database on an empty home', (command, args) => {
    const state = home()
    const result = run(command, state, args)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('local state database does not exist')
    expect(databaseFiles(state)).toEqual([])
  })

  it('init still creates the database', () => {
    const state = home()
    const result = run('init', state)
    expect(result.status, result.stderr).toBe(0)
    expect(databaseFiles(state)).toContain('ds-agent.db')
  })

  it('reads an initialized home across inspect commands without changing rows', () => {
    const state = home()
    const writer = new Store(state)
    writer.putDoc('ticket', 'ticket_inspect_1', {
      id: 'ticket_inspect_1',
      title: 'inspect fixture',
      brief: 'inspect fixture',
      mandate: {
        strength: 'explicit',
        policyVersion: 'inspect-test',
        scope: 'inspect fixture scope',
        actor: { source: 'cli', id: 'owner' },
        basis: 'addressed',
      },
      speculative: false,
      assignments: [],
      inputs: [],
      channels: [],
      threadKeys: [],
    })
    writer.putDoc('ltm', 'ltm_inspect_1', {
      id: 'ltm_inspect_1',
      ticketId: 'ticket_inspect_1',
      text: 'persisted memory',
      createdAt: '2026-11-22T00:00:00.000Z',
    })
    writer.putDoc('a2a', 'a2a_inspect_1', {
      id: 'a2a_inspect_1', from: 'alpha', to: 'beta', body: { text: 'fixture' },
      at: '2026-11-22T00:00:00.000Z',
    })
    writer.close()

    const before = databaseHash(state)
    for (const command of ['status', 'panel', 'health', 'memory', 'a2a', 'tasks', 'team', 'teams']) {
      const result = run(command, state)
      expect(result.status, `${command}: ${result.stderr}`).toBe(0)
    }
    expect(fs.existsSync(path.join(state, 'ds-agent.db'))).toBe(true)
    expect(databaseHash(state)).toBe(before)

    const reader = Store.openReadOnly(state)
    expect(reader.getDoc('ticket', 'ticket_inspect_1')).toMatchObject({ title: 'inspect fixture' })
    expect(reader.getDoc('ltm', 'ltm_inspect_1')).toMatchObject({ text: 'persisted memory' })
    expect(reader.getDoc('a2a', 'a2a_inspect_1')).toMatchObject({ from: 'alpha', to: 'beta' })
    reader.close()
  })
})
