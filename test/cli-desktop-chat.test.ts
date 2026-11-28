import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { describe, expect, it, vi } from 'vitest'
import { cliTrigger } from '../src/channels/cli.ts'
import { chatTurn } from '../src/cli/desktop-chat.ts'
import { MockModel } from '../src/harness/model.ts'
import { Runtime } from '../src/runtime.ts'
import { threadKey, type Thread, type Ticket } from '../src/shared/types.ts'

describe('desktop chat bridge', () => {
  it('only delivers replies written after a turn starts on an existing ticket', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-desktop-chat-'))
    const runtime = Runtime.create({ home, model: new MockModel(), env: {} })
    try {
      const ticketId = 'ticket_shared'
      const at = '2026-01-01T00:00:00.000Z'
      const persistReply = (id: string, text: string): void => {
        runtime.store.addReply({
          id, text, ticketId, channel: 'cli', purpose: 'result', status: 'sent', createdAt: at,
        })
      }
      const ticket: Pick<Ticket, 'id' | 'originTriggerId' | 'inputs'> = {
        id: ticketId, originTriggerId: 'prior_trigger', inputs: [],
      }
      runtime.store.putDoc('ticket', ticketId, ticket)
      persistReply('prior_reply', 'Prior reply')
      vi.spyOn(runtime, 'ingest').mockImplementation(trigger => {
        runtime.store.putDoc('ticket', ticketId, { ...ticket, inputs: [{ triggerId: trigger.id }] })
        persistReply('current_reply', 'Current reply')
        return 'stored'
      })

      const events: { type: string; text: string }[] = []
      await chatTurn(runtime, 'desktop-test', 'Continue', (type, text) => { events.push({ type, text }) })

      expect(events.filter(event => event.type !== 'status')).toEqual([
        { type: 'delta', text: 'Current reply' },
        { type: 'reply', text: 'Current reply' },
      ])
    } finally {
      await runtime.finish()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('leaves due work owned by another thread untouched', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-desktop-chat-'))
    const runtime = Runtime.create({ home, model: new MockModel(), env: {} })
    try {
      const foreign = cliTrigger({ id: 'foreign-pending', text: 'Investigate the backlog' })
      const ref = foreign.threads[0]!
      const key = threadKey(ref)
      runtime.store.putDoc('trigger', foreign.id, foreign)
      const pending: Thread = {
        key, ref, createdAt: foreign.at, subscriptions: [], correlated: [], pending: [foreign.id], meta: {},
      }
      runtime.store.putDoc('thread', key, pending)
      const startDaemon = vi.spyOn(runtime.daemon, 'start')
      runtime.startForegroundChat(threadKey({ source: 'cli', id: 'desktop-test' }))
      await runtime.jobsSettled()
      expect(startDaemon).not.toHaveBeenCalled()
      expect(runtime.store.listDocs<Ticket>('ticket')).toHaveLength(0)
      expect(runtime.store.getDoc<Thread>('thread', key)?.pending).toEqual([foreign.id])
    } finally {
      await runtime.finish()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps its thread identity across process restarts and isolates an explicit new conversation', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-desktop-chat-'))
    const run = (conversation: string): void => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'desktop-bridge'], {
        encoding: 'utf8',
        input: JSON.stringify({ text: 'Please investigate a local note' }) + '\n',
        env: {
          PATH: process.env.PATH, NODE_NO_WARNINGS: '1', LOFIBOT_HOME: home,
          LOFIBOT_ALLOW_MOCK_FIXTURE: '1', LOFIBOT_DESKTOP_CONVERSATION: conversation,
        },
        timeout: 10_000,
      })
      expect(result.status, result.stderr).toBe(0)
    }
    const threads = (): string[] => {
      const runtime = Runtime.create({ home, model: new MockModel(), env: {} })
      try {
        return runtime.store.listDocs<Thread>('thread').map(thread => thread.key).sort()
      } finally {
        runtime.store.close()
      }
    }
    try {
      run('local')
      run('local')
      expect(threads()).toEqual(['cli:desktop-local'])
      run('new-chat')
      expect(threads()).toEqual(['cli:desktop-local', 'cli:desktop-new-chat'])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  it('allows the desktop to request shutdown while a turn is running', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-desktop-chat-'))
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'desktop-bridge'], {
      env: {
        PATH: process.env.PATH,
        NODE_NO_WARNINGS: '1',
        LOFIBOT_HOME: home,
        LOFIBOT_ALLOW_MOCK_FIXTURE: '1',
      },
      timeout: 10_000,
    })
    try {
      const stopped = once(child, 'close')
      const lines = createInterface({ input: child.stdout })
      let started = false
      lines.on('line', line => {
        const event = JSON.parse(line) as { type: string; text: string }
        if (event.type !== 'status') return
        if (event.text === 'Ready') child.stdin.write('{"text":"Please investigate a local note"}\n')
        if (event.text === 'Working…') {
          started = true
          child.stdin.end('{"shutdown":true}\n')
          child.stdout.destroy()
        }
      })
      const [code, signal] = await stopped
      expect(started).toBe(true)
      expect([code, signal]).toEqual([0, null])
    } finally {
      child.kill()
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 15_000)

  it('emits protocol-only stdout and handles two turns after an invalid request', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-desktop-chat-'))
    try {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'desktop-bridge'], {
        encoding: 'utf8',
        input: ['invalid json', JSON.stringify({ text: 'Please investigate and write a note' }),
          JSON.stringify({ text: '请调查一下，再写一份报告' }), ''].join('\n'),
        env: {
          PATH: process.env.PATH,
          NODE_NO_WARNINGS: '1',
          LOFIBOT_HOME: home,
          LOFIBOT_ALLOW_MOCK_FIXTURE: '1',
        },
        timeout: 30_000,
      })
      expect(result.status, result.stderr).toBe(0)
      const events: { type: string; text: string }[] = result.stdout.trim().split('\n').map(line => JSON.parse(line))
      expect(events[0]).toEqual({ type: 'status', text: 'Ready' })
      expect(events.filter(event => event.type === 'error')).toHaveLength(1)
      const statuses = events.filter(event => event.type === 'status').map(event => event.text)
      expect(statuses.filter(status => status === 'Working…')).toHaveLength(2)
      expect(statuses.filter(status => status.startsWith('Acknowledged'))).toHaveLength(2)
      expect(statuses.filter(status => status === 'Task ready')).toHaveLength(2)
      expect(events.filter(event => event.type === 'delta').length).toBeGreaterThanOrEqual(2)
      const replies = events.filter(event => event.type === 'reply')
      expect(replies).toHaveLength(2)
      for (const reply of replies) expect(reply.text).toContain('investigation recorded')
      let deltas = ''
      for (const event of events) {
        if (event.type === 'delta') deltas += event.text
        if (event.type === 'reply') {
          expect(event.text).toBe(deltas)
          deltas = ''
        }
      }
      expect(result.stderr).toContain('[harness]')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
