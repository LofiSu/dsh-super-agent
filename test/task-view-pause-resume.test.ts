import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Engine } from '../src/core/engine.ts'
import type { Host } from '../src/core/host.ts'
import { gatewayConfigPath } from '../src/gateway/config-file.ts'
import { readMemoryTranscript } from '../src/memory/transcript.ts'
import { SessionJournal } from '../src/harness/session.ts'
import { Metrics } from '../src/metrics/metrics.ts'
import type { OutboxRow, Ticket } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'
import { Watchdog } from '../src/watchdog/watchdog.ts'
import { tempHome } from './fixtures.ts'

const OFFLINE_KEYS = [
  'DS_AGENT_API_BASE',
  'DS_AGENT_API_KEY',
  'DS_AGENT_API_MODEL',
  'DS_AGENT_API_TIMEOUT_MS',
  'DS_AGENT_PROVIDER',
  'DS_AGENT_GATEWAY_URL',
  'DS_AGENT_GATEWAY_TOKEN',
  'DS_AGENT_GATEWAY_MODEL',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'ZHIPU_API_KEY',
  'GLM_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
]

const RESUME_REPORT = 'resumed progress: login timeout still open'

interface CliResult {
  status: number | null
  stdout: string
  stderr: string
}

let modelBase = ''
let modelServer: Server | undefined

beforeAll(async () => {
  modelServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      let lastRole = ''
      let lastUser = ''
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
          messages?: Array<{ role?: string; content?: string | null }>
        }
        const messages = body.messages ?? []
        const last = messages[messages.length - 1]
        lastRole = last?.role ?? ''
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index]?.role === 'user') {
            lastUser = String(messages[index]?.content ?? '')
            break
          }
        }
      } catch {
        // A malformed body still gets a terminal completion so the CLI cannot hang.
      }
      const resumeWork = lastRole !== 'tool'
        && lastUser.includes('ticket_pause')
        && lastUser.includes('Continue the interrupted task')
      const message = resumeWork
        ? {
          content: '',
          tool_calls: [{
            id: 'call_resume',
            type: 'function',
            function: {
              name: 'report_to_router',
              arguments: JSON.stringify({
                ticketId: 'ticket_pause',
                text: RESUME_REPORT,
                kind: 'progress',
                deliver: false,
              }),
            },
          }],
        }
        : { content: 'idle' }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message }] }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    modelServer!.once('error', reject)
    modelServer!.listen(0, '127.0.0.1', () => resolve())
  })
  const address = modelServer.address() as AddressInfo
  modelBase = `http://127.0.0.1:${address.port}/v1`
})

afterAll(async () => {
  if (!modelServer) return
  await new Promise<void>((resolve, reject) => {
    modelServer!.close(error => error ? reject(error) : resolve())
  })
})

function offlineEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DS_AGENT_HOME: home,
    NODE_NO_WARNINGS: '1',
    ...extra,
  }
  for (const key of OFFLINE_KEYS) {
    if (!(key in extra)) delete env[key]
  }
  return env
}

function runCli(home: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], {
      cwd: path.resolve('.'),
      env: offlineEnv(home, extra),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 60_000)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', status => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

function liveModelEnv(): NodeJS.ProcessEnv {
  return {
    DS_AGENT_API_BASE: modelBase,
    DS_AGENT_API_KEY: 'test-key',
    DS_AGENT_API_MODEL: 'fake',
    DS_AGENT_API_TIMEOUT_MS: '20000',
  }
}

function ticket(overrides: Partial<Ticket> & Pick<Ticket, 'id' | 'createdAt'>): Ticket {
  const at = '2026-01-01T00:00:00.000Z'
  return {
    title: 'fix the login timeout',
    brief: 'fix the login timeout',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'fix the login timeout',
      actor: { source: 'cli', id: 'you' },
      basis: 'addressed',
    },
    threadKeys: ['cli:local'],
    channels: [{ source: 'cli', thread: 'local' }],
    inputs: [{
      id: `input_${overrides.id}`,
      kind: 'trigger',
      triggerId: `trg_${overrides.id}`,
      text: 'fix the login timeout',
      at,
      human: true,
    }],
    assignments: [{
      id: `asg_${overrides.id}`,
      state: 'running',
      speculative: false,
      workerSessionId: `worker_${overrides.id}`,
      startedAt: '2020-01-01T00:00:00.000Z',
      report: {
        kind: 'progress',
        text: 'still tracing the timeout',
        at: '2020-01-01T00:00:01.000Z',
      },
    }],
    speculative: false,
    originTriggerId: `trg_${overrides.id}`,
    ...overrides,
  }
}

function outbox(id: string, ticketId: string, status: OutboxRow['status']): OutboxRow {
  return {
    id,
    replyId: `reply_${id}`,
    ticketId,
    channel: 'im',
    thread: 'topic/login',
    target: { chat_id: 'oc_test' },
    text: `delivery ${id}`,
    status,
    idempotencyKey: `reply_${id}`,
    attempts: status === 'pending' ? 0 : 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function seed(home: string, tickets: Ticket[], rows: OutboxRow[] = []): void {
  const store = new Store(home)
  for (const item of tickets) store.putDoc('ticket', item.id, item)
  for (const row of rows) store.enqueueOutbox(row)
  store.close()
}

function readTicket(home: string, id: string): Ticket {
  const store = new Store(home)
  try {
    const stored = store.getDoc<Ticket>('ticket', id)
    if (!stored) throw new Error(`missing ticket ${id}`)
    return stored
  } finally {
    store.close()
  }
}

function settle(home: string, id: string): void {
  const store = new Store(home)
  try {
    const stored = store.getDoc<Ticket>('ticket', id)
    if (!stored) return
    const assignment = stored.assignments.at(-1)
    if (assignment && assignment.state !== 'ended') {
      assignment.state = 'ended'
      assignment.endedAt = '2026-01-04T00:00:00.000Z'
    }
    stored.ended = { at: '2026-01-04T00:00:00.000Z', outcome: 'ready', by: 'executor' }
    store.putDoc('ticket', stored.id, stored)
  } finally {
    store.close()
  }
}

describe('task view, pause, and resume', () => {
  it('lists a chat ticket and shows mandate, session, directory, report, and outbox counts', async () => {
    const home = tempHome()
    const init = await runCli(home, ['init'])
    expect(init.status, init.stderr).toBe(0)

    const chat = await runCli(home, ['chat', 'fix the login timeout'])
    expect(chat.status, chat.stderr).toBe(0)

    const tasks = await runCli(home, ['tasks'])
    expect(tasks.status, tasks.stderr).toBe(0)
    expect(tasks.stdout).toContain('ticket_1\tended/ready\tfix the login timeout')

    const panel = await runCli(home, ['panel'])
    expect(panel.status, panel.stderr).toBe(0)
    expect(panel.stdout).toContain('Panel · Execution')
    expect(panel.stdout).toContain('ticket_1\tended\tfix the login timeout')
    expect(panel.stdout).toContain('mandate: fix the login timeout (explicit, policy-v1)')
    expect(panel.stdout).toContain('executor: worker_ticket_1')
    expect(panel.stdout).toContain(`directory: ${home}/workspaces/worker_ticket_1`)
    expect(panel.stdout).toContain('report: ready — ready: investigation recorded')
    expect(panel.stdout).toContain('outbox: pending=0 sent=0 failed=0')
  })

  it('pauses an in-progress ticket, keeps the watchdog idle, survives restart, and resumes the report', async () => {
    const home = tempHome()
    const paused = ticket({ id: 'ticket_pause', createdAt: '2026-01-01T00:00:00.000Z' })
    const live = ticket({
      id: 'ticket_live',
      createdAt: '2026-01-02T00:00:00.000Z',
      title: 'keep the other ticket moving',
      assignments: [{
        id: 'asg_live',
        state: 'running',
        speculative: false,
        workerSessionId: 'worker_ticket_live',
        startedAt: '2020-01-01T00:00:00.000Z',
      }],
    })
    const blocked = ticket({
      id: 'ticket_blocked',
      createdAt: '2026-01-03T00:00:00.000Z',
      title: 'worker reported a blocker',
      assignments: [{
        id: 'asg_blocked',
        state: 'running',
        speculative: false,
        workerSessionId: 'worker_ticket_blocked',
        startedAt: '2026-01-03T00:00:00.000Z',
        report: {
          kind: 'blocked',
          text: 'needs a credential',
          at: '2099-01-01T00:00:00.000Z',
        },
      }],
    })
    seed(home, [paused, live, blocked], [
      outbox('out_pending', 'ticket_pause', 'pending'),
      outbox('out_sent', 'ticket_pause', 'sent'),
    ])

    const first = await runCli(home, ['pause', 'ticket_pause', '--reason', 'waiting on staging'])
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain('paused ticket_pause "fix the login timeout" — waiting on staging')
    expect(first.stdout).toContain('person/paused')
    const held = readTicket(home, 'ticket_pause')

    const again = await runCli(home, ['pause', 'ticket_pause', '--reason', 'a second pause'])
    expect(again.status, again.stderr).toBe(0)
    expect(again.stdout).toContain('ticket ticket_pause is already paused.')
    const kept = readTicket(home, 'ticket_pause')
    expect(kept.collab?.paused).toEqual(held.collab?.paused)
    const events = new Store(home)
    try {
      expect(events.listEvents().filter(event => event.type === 'ticket.paused')).toHaveLength(1)
    } finally {
      events.close()
    }

    const tasks = await runCli(home, ['tasks'])
    expect(tasks.status, tasks.stderr).toBe(0)
    expect(tasks.stdout).toContain('ticket_pause\tperson/paused\tfix the login timeout')

    const panel = await runCli(home, ['panel'])
    expect(panel.status, panel.stderr).toBe(0)
    expect(panel.stdout).toContain('ticket_pause\tpaused\tfix the login timeout')
    expect(panel.stdout).toContain('mandate: fix the login timeout (explicit, policy-v1)')
    expect(panel.stdout).toContain('executor: worker_ticket_pause')
    expect(panel.stdout).toContain(`directory: ${home}/workspaces/worker_ticket_pause`)
    expect(panel.stdout).toContain('report: progress — still tracing the timeout')
    expect(panel.stdout).toContain('outbox: pending=1 sent=1 failed=0')
    expect(panel.stdout).toContain('ticket_blocked\tblocked\tworker reported a blocker')

    const store = new Store(home)
    const logs: string[] = []
    const metrics = new Metrics(home)
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      metrics,
      log: line => logs.push(line),
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const watchdog = new Watchdog({
      store,
      engine: new Engine(host),
      journal: new SessionJournal(path.join(home, 'sessions'), store, () => {}),
      log: line => logs.push(line),
      metrics,
      intervalMs: 60_000,
      stuckMs: 1_000,
    })
    watchdog.tick()
    const nudged = store.listEvents()
      .filter(event => event.type === 'watchdog.nudge')
      .map(event => (event.payload as { ticketId?: string }).ticketId)
    expect(logs.join('\n')).toContain('stuck=1')
    expect(nudged).toEqual(['ticket_live'])
    expect(store.getDoc<Ticket>('ticket', 'ticket_pause')?.ended).toBeUndefined()
    expect(store.getDoc<Ticket>('ticket', 'ticket_pause')?.collab?.paused?.reason).toBe('waiting on staging')
    expect(store.getDoc<Ticket>('ticket', 'ticket_live')?.ended).toBeUndefined()
    store.close()

    const restarted = await runCli(home, ['tasks'])
    expect(restarted.status, restarted.stderr).toBe(0)
    expect(restarted.stdout).toContain('ticket_pause\tperson/paused\tfix the login timeout')
    const restartedPanel = await runCli(home, ['panel'])
    expect(restartedPanel.stdout).toContain('ticket_pause\tpaused\tfix the login timeout')

    // Resume starts a live runtime, which recovers every other running ticket.
    // End those siblings first so this command only continues the paused ticket.
    settle(home, 'ticket_live')
    settle(home, 'ticket_blocked')

    const guidance = 'Use pnpm for the reproduction'
    const correction = await runCli(home, ['intervene', 'ticket_pause', guidance])
    expect(correction.status, correction.stderr).toBe(0)
    const followup = 'Reproduce only with the staging database'
    const inputStore = new Store(home)
    try {
      const current = inputStore.getDoc<Ticket>('ticket', 'ticket_pause')!
      const at = new Date().toISOString()
      current.inputs.push(
        { id: 'human-followup', kind: 'text', at, human: true, text: followup },
        { id: 'scheduler-followup', kind: 'job', at, human: false, text: 'scheduler update' },
      )
      inputStore.putDoc('ticket', current.id, current)
    } finally {
      inputStore.close()
    }
    const resumed = await runCli(home, ['resume', 'ticket_pause', '--reason', 'human verified'], liveModelEnv())
    expect(resumed.status, `${resumed.stderr}\n${resumed.stdout}`).toBe(0)
    expect(resumed.stdout).toContain('resumed ticket_pause "fix the login timeout" — human verified')
    expect(resumed.stdout).toContain('stage: working')

    const afterTasks = await runCli(home, ['tasks'])
    expect(afterTasks.stdout).toContain('ticket_pause\tworking\tfix the login timeout')
    const afterPanel = await runCli(home, ['panel'])
    expect(afterPanel.stdout).toContain('ticket_pause\tworking\tfix the login timeout')
    expect(afterPanel.stdout).toContain(`report: progress — ${RESUME_REPORT}`)
    expect(afterPanel.stdout).not.toContain('ticket_pause\tpaused\t')
    const evidenceStore = new Store(home)
    try {
      const evidence = readMemoryTranscript(evidenceStore, 'worker_ticket_pause', {}, text => text)
      expect(evidence.entries).toContainEqual(expect.objectContaining({ role: 'user', text: [guidance, followup].join('\n') }))
    } finally {
      evidenceStore.close()
    }
  })

  it('runs memory dream when only the embedded gateway is configured', async () => {
    const home = tempHome()
    const sessionId = 'router:thread:fixture'
    const at = '2026-01-01T00:00:00.000Z'
    const store = new Store(home)
    store.upsertSession({ id: sessionId, role: 'router', status: 'idle', heartbeat: at, createdAt: at })
    store.close()
    writeFileSync(gatewayConfigPath(home), JSON.stringify({
      defaultModel: 'fixture',
      providers: [{ id: 'local', baseUrl: modelBase, apiKey: '', models: ['fixture'] }],
    }))

    const result = await runCli(home, ['memory', 'dream', '--session', sessionId])
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ summary: 'idle', writes: 0, limitReached: false })
  })

  it('reports an unknown ticket and leaves the existing ticket unchanged', async () => {
    const home = tempHome()
    const existing = ticket({ id: 'ticket_keep', createdAt: '2026-01-01T00:00:00.000Z' })
    seed(home, [existing])
    const before = readTicket(home, 'ticket_keep')

    const missing = await runCli(home, ['pause', 'ticket_nope'])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('unknown ticket ticket_nope')
    expect(readTicket(home, 'ticket_keep')).toEqual(before)

    const tasks = await runCli(home, ['tasks'])
    expect(tasks.status, tasks.stderr).toBe(0)
    expect(tasks.stdout).toContain('ticket_keep\tworking\tfix the login timeout')
  })

  it('resume of a ticket that is not paused leaves the stored ticket unchanged', async () => {
    const home = tempHome()
    const active = ticket({
      id: 'ticket_active',
      createdAt: '2026-01-01T00:00:00.000Z',
      assignments: [{
        id: 'asg_active',
        state: 'pending',
        speculative: false,
        report: { kind: 'progress', text: 'queued, not paused', at: '2026-01-01T00:00:00.000Z' },
      }],
    })
    seed(home, [active])
    const before = readTicket(home, 'ticket_active')

    const resumed = await runCli(home, ['resume', 'ticket_active'], liveModelEnv())
    expect(resumed.status, `${resumed.stderr}\n${resumed.stdout}`).toBe(0)
    expect(resumed.stdout).toContain('ticket ticket_active is not paused; nothing to resume.')
    expect(resumed.stdout).toContain('stage: working/queued')
    expect(readTicket(home, 'ticket_active')).toEqual(before)
  })

  it('pause latest holds only the newest live ticket', async () => {
    const home = tempHome()
    seed(home, [
      ticket({ id: 'ticket_old', createdAt: '2026-01-01T00:00:00.000Z', title: 'older work' }),
      ticket({ id: 'ticket_new', createdAt: '2026-02-01T00:00:00.000Z', title: 'newer work' }),
    ])

    const paused = await runCli(home, ['pause', 'latest', '--reason', 'hold the newest'])
    expect(paused.status, paused.stderr).toBe(0)
    expect(paused.stdout).toContain('paused ticket_new "newer work"')

    const tasks = await runCli(home, ['tasks'])
    expect(tasks.stdout).toContain('ticket_new\tperson/paused\tnewer work')
    expect(tasks.stdout).toContain('ticket_old\tworking\tolder work')
    expect(readTicket(home, 'ticket_old').collab?.paused).toBeUndefined()
  })
})
