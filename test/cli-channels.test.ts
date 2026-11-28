import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IMESSAGE_ADMISSION_ERROR,
  ImessageSource,
  type ImessageApi,
} from '../src/channels/imessage.ts'
import {
  checkFeishuChannel,
  checkImessageChannel,
  resolveServeChannelConfigs,
  runChannelsCheck,
  startServeChannels,
} from '../src/cli/channels.ts'
import { runImessageLoop } from '../src/cli/channel-loop.ts'
import { MockModel } from '../src/harness/model.ts'
import { Runtime } from '../src/runtime.ts'

const dirs: string[] = []
const runtimes: Runtime[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function chatDb(dir: string, text = 'TOP SECRET message body'): string {
  const dbPath = path.join(dir, 'chat.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT,
      style INTEGER, room_name TEXT
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
      date INTEGER, service TEXT, handle_id INTEGER, is_from_me INTEGER
    );
    CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
  `)
  db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+15550000000')
  db.prepare(
    'INSERT INTO chat (ROWID, guid, chat_identifier, style) VALUES (1, ?, ?, 45)',
  ).run('iMessage;-;+15550000000', '+15550000000')
  db.prepare(
    `INSERT INTO message
      (ROWID, guid, text, attributedBody, date, service, handle_id, is_from_me)
     VALUES (1, 'G1', ?, NULL, 0, 'iMessage', 1, 0)`,
  ).run(text)
  db.prepare('INSERT INTO chat_message_join (message_id, chat_id) VALUES (1, 1)').run()
  db.close()
  return dbPath
}

function runtime(home = tempDir('ds-agent-channels-home-')): Runtime {
  const created = Runtime.create({
    home,
    model: new MockModel(),
    jobDelayMs: 0,
    watchdogIntervalMs: 60_000,
    env: { ...process.env, DS_AGENT_GROUP_ALLOWLIST: 'oc_check' },
  })
  created.start()
  runtimes.push(created)
  return created
}

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...overrides,
  }
}

function bothConfigs(dbPath: string) {
  return resolveServeChannelConfigs(
    [
      'node', 'ds-agent', 'serve', '--imessage', '--feishu',
      '--handle', '+15550000000', '--db', dbPath, '--chat', 'oc_check', '--since', '1',
    ],
    baseEnv({
      FEISHU_APP_ID: 'app',
      FEISHU_APP_SECRET: 'app-secret-value',
      FEISHU_CHAT_ID: 'oc_env',
    }),
  )
}

afterEach(async () => {
  for (const created of runtimes.splice(0)) {
    if (created.store.isOpen) {
      created.daemon.stop()
      await created.finish().catch(() => undefined)
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('combined serve channels', () => {
  it('resolves both configurations and keeps independent failure isolation', async () => {
    const dir = tempDir('ds-agent-channels-both-')
    const configs = bothConfigs(path.join(dir, 'chat.db'))
    expect(configs.imessage?.handle).toBe('+15550000000')
    expect(configs.feishu?.chatId).toBe('oc_check')

    const rt = runtime()
    const closed: string[] = []
    let imessageStarted = false
    let feishuStarted = false
    let feishuAborted = false
    const api: ImessageApi & { close(): void } = {
      async pull() { return [] },
      async maxRowId() { return 0 },
      async send() { return { externalId: 'unused' } },
      close() { closed.push('imessage-close') },
    }

    const started = startServeChannels({
      runtime: rt,
      imessage: configs.imessage!,
      feishu: configs.feishu!,
      createImessageApi: () => api,
      runImessage: async () => {
        imessageStarted = true
        throw new Error('imessage boom')
      },
      runFeishu: async ({ signal }) => {
        feishuStarted = true
        await new Promise<void>(resolve => {
          if (signal?.aborted) {
            feishuAborted = true
            resolve()
            return
          }
          signal?.addEventListener('abort', () => {
            feishuAborted = true
            resolve()
          }, { once: true })
        })
      },
    })

    await waitFor(() => imessageStarted && feishuStarted)
    await waitFor(() => rt.log.text().includes('[imessage] loop stopped error=imessage boom'))
    // The failed loop did not kill the other loop or close the shared store.
    expect(feishuAborted).toBe(false)
    expect(rt.store.isOpen).toBe(true)
    expect(closed).toEqual([])

    started.abort()
    await withTimeout(started.wait())
    started.close()
    expect(feishuAborted).toBe(true)
    expect(closed).toEqual(['imessage-close'])
    expect(rt.store.isOpen).toBe(true)
  })

  it('fails closed before Runtime/SQLite when either combined config is missing', () => {
    expect(() => resolveServeChannelConfigs(
      ['node', 'ds-agent', 'serve', '--imessage', '--feishu', '--chat', 'oc_check'],
      baseEnv(),
    )).toThrow(/cannot start both inbound channels[\s\S]*iMessage:[\s\S]*Feishu:/)

    expect(() => resolveServeChannelConfigs(
      ['node', 'ds-agent', 'serve', '--imessage', '--feishu', '--handle', '+15550000000'],
      baseEnv({
        FEISHU_APP_ID: 'app',
        FEISHU_APP_SECRET: 'secret',
      }),
    )).toThrow(/cannot start both inbound channels[\s\S]*Feishu:[\s\S]*FEISHU_CHAT_ID/)

    // A single missing channel keeps the historical, focused error text.
    expect(() => resolveServeChannelConfigs(
      ['node', 'ds-agent', 'serve', '--imessage'],
      baseEnv(),
    )).toThrow(IMESSAGE_ADMISSION_ERROR)
  })
})

describe('channels check preflight', () => {
  it('reports iMessage metadata, admission, and the manual Automation command without message text', () => {
    const dir = tempDir('ds-agent-check-imessage-')
    const dbPath = chatDb(dir)
    const result = checkImessageChannel({
      argv: ['node', 'ds-agent', 'channels', 'check', '--imessage', '--db', dbPath],
      env: baseEnv({ DS_AGENT_IMESSAGE_HANDLE: '+15550000000' }),
      findExecutable: () => '/usr/bin/osascript',
    })
    const output = result.lines.join('\n')
    expect(result.ready).toBe(true)
    expect(output).toContain('[imessage] schema: ok')
    expect(output).toContain('count=1 latest_rowid=1')
    expect(output).toContain('admission: allowed handle=+15550000000')
    expect(output).toContain('osascript: found')
    expect(output).toContain('tell application "Messages" to get name')
    expect(output).toContain('System Settings > Privacy & Security > Automation')
    expect(output).not.toContain('TOP SECRET message body')
  })

  it('maps a TCC denial to Full Disk Access guidance and never reports ready', () => {
    const dir = tempDir('ds-agent-check-imessage-tcc-')
    const dbPath = path.join(dir, 'chat.db')
    fs.writeFileSync(dbPath, '')
    const result = checkImessageChannel({
      argv: ['node', 'ds-agent', 'channels', 'check', '--imessage', '--db', dbPath],
      env: baseEnv({ DS_AGENT_IMESSAGE_HANDLE: '+15550000000' }),
      findExecutable: () => '/usr/bin/osascript',
      openDatabase: () => { throw new Error('authorization denied') },
    })
    const output = result.lines.join('\n')
    expect(result.ready).toBe(false)
    expect(output).toContain('permission denied')
    expect(output).toContain('Grant Full Disk Access to your terminal')
    expect(output).toContain('System Settings > Privacy & Security > Full Disk Access')
    expect(output).toContain('[imessage] NOT READY')
  })

  it('reports missing Feishu credentials without going online', async () => {
    let fetched = false
    const result = await checkFeishuChannel({
      argv: ['node', 'ds-agent', 'channels', 'check', '--feishu', '--chat', 'oc_check'],
      env: baseEnv(),
      fetchImpl: async () => {
        fetched = true
        throw new Error('network must stay off')
      },
    })
    const output = result.lines.join('\n')
    expect(result.ready).toBe(false)
    expect(fetched).toBe(false)
    expect(output).toContain('FEISHU_APP_ID')
    expect(output).toContain('FEISHU_APP_SECRET')
    expect(output).toContain('network: skipped')
  })

  it('reports a ready offline Feishu config without printing the app secret', async () => {
    let fetched = false
    const result = await checkFeishuChannel({
      argv: ['node', 'ds-agent', 'channels', 'check', '--feishu', '--chat', 'oc_check'],
      env: baseEnv({
        FEISHU_APP_ID: 'app',
        FEISHU_APP_SECRET: 'app-secret-value',
        FEISHU_CHAT_ID: 'oc_env',
      }),
      fetchImpl: async () => {
        fetched = true
        throw new Error('network must stay off')
      },
    })
    const output = result.lines.join('\n')
    expect(result.ready).toBe(true)
    expect(fetched).toBe(false)
    expect(output).toContain('credentials: present')
    expect(output).toContain('chat: present (polling exactly one chat)')
    expect(output).toContain('base URL: https://open.feishu.cn')
    expect(output).toContain('im:chat:readonly')
    expect(output).toContain('im:chat:read or im:chat also work')
    expect(output).toContain('even when direct mode is off')
    expect(output).toContain('network: skipped')
    expect(output).not.toContain('app-secret-value')
  })

  it('checks Feishu credentials with an injected network call and hides the token', async () => {
    let calls = 0
    const result = await checkFeishuChannel({
      argv: ['node', 'ds-agent', 'channels', 'check', '--feishu', '--chat', 'oc_check', '--network'],
      env: baseEnv({
        FEISHU_APP_ID: 'app',
        FEISHU_APP_SECRET: 'app-secret-value',
      }),
      network: true,
      fetchImpl: async () => {
        calls += 1
        return new Response(JSON.stringify({
          code: 0,
          tenant_access_token: 'token-value-must-not-print',
          expire: 7200,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })
    const output = result.lines.join('\n')
    expect(result.ready).toBe(true)
    expect(calls).toBe(1)
    expect(output).toContain('tenant_access_token: ok')
    expect(output).not.toContain('app-secret-value')
    expect(output).not.toContain('token-value-must-not-print')
  })

  it('keeps --network token-only and probes token, metadata, then one history item for --check-chat', async () => {
    const secret = 'fixture-secret-never-print'
    const token = 'fixture-token-never-print'
    const chat = 'oc_fixture_chat_never_print'
    const body = 'fixture-message-body-never-print'
    const calls: string[] = []
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push(input)
      if (input.includes('tenant_access_token')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: token, expire: 7200 }))
      }
      if (input.includes('/im/v1/chats/')) {
        return new Response(JSON.stringify({ code: 0, data: { chat_mode: 'p2p' } }))
      }
      const query = new URL(input).searchParams
      expect(query.get('page_size')).toBe('1')
      expect(init?.method ?? 'GET').toBe('GET')
      return new Response(JSON.stringify({
        code: 0,
        data: { items: [{ body: { content: body } }], has_more: true, page_token: 'second-page-token' },
      }))
    }
    const env = baseEnv({ FEISHU_APP_ID: 'fixture-app', FEISHU_APP_SECRET: secret, FEISHU_CHAT_ID: chat })
    const tokenOnly = await checkFeishuChannel({
      argv: ['node', 'ds-agent', 'channels', 'check', '--feishu'],
      env,
      network: true,
      fetchImpl,
    })
    expect(tokenOnly.ready).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('tenant_access_token')

    calls.length = 0
    const probe = await runChannelsCheck({
      channels: ['feishu'],
      argv: ['node', 'ds-agent', 'channels', 'check', '--feishu', '--check-chat'],
      env,
      fetchImpl,
    })
    const output = probe.lines.join('\n')
    expect(probe.ready).toBe(true)
    expect(calls).toHaveLength(3)
    expect(calls[0]).toContain('tenant_access_token')
    expect(calls[1]).toContain('/open-apis/im/v1/chats/')
    expect(calls[2]).toContain('/open-apis/im/v1/messages?')
    expect(output).toContain('chat metadata: ok')
    expect(output).toContain('chat history: ok (API /open-apis/im/v1/messages; items=1; one-message probe)')
    expect(output).toContain('send capability: 未验证')
    for (const forbidden of [secret, token, chat, body, 'second-page-token']) expect(output).not.toContain(forbidden)
  })

  it('accepts empty history and reports chat missing without metadata/history requests', async () => {
    let calls = 0
    const fetchImpl = async (input: string): Promise<Response> => {
      calls += 1
      if (input.includes('tenant_access_token')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token-fixture', expire: 7200 }))
      }
      if (input.includes('/im/v1/chats/')) return new Response(JSON.stringify({ code: 0, data: {} }))
      return new Response(JSON.stringify({ code: 0, data: { items: [], has_more: false } }))
    }
    const base = ['node', 'ds-agent', 'channels', 'check', '--feishu', '--check-chat']
    const empty = await checkFeishuChannel({
      argv: [...base, '--chat', 'oc_empty_fixture'],
      env: baseEnv({ FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret' }),
      fetchImpl,
    })
    expect(empty.ready).toBe(true)
    expect(empty.lines.join('\n')).toContain('items=0')
    expect(calls).toBe(3)

    calls = 0
    const missing = await checkFeishuChannel({
      argv: base,
      env: baseEnv({ FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret' }),
      fetchImpl,
    })
    const output = missing.lines.join('\n')
    expect(missing.ready).toBe(false)
    expect(output).toContain('chat metadata: FAILED chat missing / not configured')
    expect(output).toContain('chat history: FAILED chat missing / not configured')
    expect(calls).toBe(1)
  })

  it('stops after failed token or chat metadata and reports sanitized API status and code', async () => {
    const secret = 'credential-fixture-secret'
    const chat = 'oc_error_fixture'
    const common = {
      argv: ['node', 'ds-agent', 'channels', 'check', '--feishu', '--check-chat', '--chat', chat],
      env: baseEnv({ FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: secret }),
    }
    const tokenCalls: string[] = []
    const rejected = await checkFeishuChannel({
      ...common,
      fetchImpl: async input => {
        tokenCalls.push(input)
        return new Response(JSON.stringify({ code: 99991663, msg: secret }), { status: 401 })
      },
    })
    const rejectedOutput = rejected.lines.join('\n')
    expect(rejected.ready).toBe(false)
    expect(tokenCalls).toHaveLength(1)
    expect(rejectedOutput).toContain('tenant_access_token: FAILED API auth/v3/tenant_access_token')
    expect(rejectedOutput).toContain('HTTP 401 Feishu code=99991663')
    expect(rejectedOutput).toContain('chat metadata: skipped (prior token stage failed)')
    expect(rejectedOutput).not.toContain(secret)

    const unreadable = await checkFeishuChannel({
      ...common,
      fetchImpl: async input => {
        if (input.includes('tenant_access_token')) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token-fixture', expire: 7200 }))
        }
        return new Response(JSON.stringify({ code: 230002, msg: 'private provider details' }), { status: 403 })
      },
    })
    const unreadableOutput = unreadable.lines.join('\n')
    expect(unreadable.ready).toBe(false)
    expect(unreadableOutput).toContain('HTTP 403 Feishu code=230002')
    expect(unreadableOutput).toContain('bot is not in the chat')
    expect(unreadableOutput).toContain('chat is not visible')
    expect(unreadableOutput).toContain('required chat read scope is unavailable')
    expect(unreadableOutput).toContain('chat history: skipped (prior chat metadata stage failed)')
    expect(unreadableOutput).not.toContain('private provider details')
    expect(unreadableOutput).not.toContain(secret)
  })

  it('reports history denial and bounded probe timeouts without exposing fixture data', async () => {
    const shared = {
      argv: ['node', 'ds-agent', 'channels', 'check', '--feishu', '--check-chat', '--chat', 'oc_history_fixture'],
      env: baseEnv({ FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret-fixture' }),
    }
    const denied = await checkFeishuChannel({
      ...shared,
      fetchImpl: async input => {
        if (input.includes('tenant_access_token')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'token-hidden', expire: 7200 }))
        if (input.includes('/im/v1/chats/')) return new Response(JSON.stringify({ code: 0, data: { chat_mode: 'group' } }))
        return new Response(JSON.stringify({ code: 230002, msg: 'history fixture body' }), { status: 403 })
      },
    })
    const deniedOutput = denied.lines.join('\n')
    expect(denied.ready).toBe(false)
    expect(deniedOutput).toContain('chat history: FAILED API /open-apis/im/v1/messages failed HTTP 403 Feishu code=230002')
    for (const forbidden of ['secret-fixture', 'token-hidden', 'history fixture body', 'oc_history_fixture']) {
      expect(deniedOutput).not.toContain(forbidden)
    }

    const timedOut = await checkFeishuChannel({
      ...shared,
      fetchImpl: async (input, init) => {
        if (input.includes('tenant_access_token')) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: 'timeout-token', expire: 7200 }))
        }
        if (input.includes('/im/v1/chats/')) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        }
        return new Response(JSON.stringify({ code: 0, data: {} }))
      },
    })
    const timeoutOutput = timedOut.lines.join('\n')
    expect(timedOut.ready).toBe(false)
    expect(timeoutOutput).toContain('chat metadata: FAILED API /open-apis/im/v1/chats/:chat_id timeout')
    expect(timeoutOutput).toContain('chat history: skipped (prior chat metadata stage failed)')
    expect(timeoutOutput).not.toContain('timeout-token')
  }, 8_000)

  it('exits non-zero when any selected channel is not ready', async () => {
    const dir = tempDir('ds-agent-check-code-')
    const dbPath = chatDb(dir)
    const ready = await runChannelsCheck({
      channels: ['imessage'],
      argv: ['node', 'ds-agent', 'channels', 'check', '--imessage', '--db', dbPath],
      env: baseEnv({ DS_AGENT_IMESSAGE_HANDLE: '+15550000000' }),
      findExecutable: () => '/usr/bin/osascript',
    })
    expect(ready.code).toBe(0)

    const notReady = await runChannelsCheck({
      channels: ['feishu'],
      argv: ['node', 'ds-agent', 'channels', 'check', '--feishu'],
      env: baseEnv(),
    })
    expect(notReady.code).toBe(1)
    expect(notReady.lines.join('\n')).toContain('NOT READY')
  })

  it('stops retrying a standalone iMessage loop after a permission denial', async () => {
    const rt = runtime()
    let pulls = 0
    const api: ImessageApi = {
      async pull() {
        pulls += 1
        throw new Error('authorization denied')
      },
      async maxRowId() { return 0 },
      async send() { return { externalId: 'unused' } },
    }
    await expect(runImessageLoop({
      runtime: rt,
      source: new ImessageSource(api),
      api,
      dbPath: 'unused-chat.db',
      intervalMs: 5,
      once: true,
    })).rejects.toThrow(/Full Disk Access/)
    expect(pulls).toBe(1)
  })
})

describe('channel docs and help', () => {
  it('documents combined serve and preflight, and help no longer forbids the pair', () => {
    const help = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/main.ts', '--help'],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DS_AGENT_HOME: tempDir('ds-agent-help-') } },
    )
    expect(help.status, help.stderr).toBe(0)
    expect(help.stdout).toContain('channels check')
    expect(help.stdout).toContain('[--imessage] [--feishu]')
    expect(help.stdout).toContain('[--network] [--check-chat]')
    expect(help.stdout).toContain('one history item')
    expect(help.stdout).toContain('send capability remains unverified')
    expect(help.stdout).toContain('independent cursors')
    expect(help.stdout).not.toContain('cannot be combined')

    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8')
    const realChannels = fs.readFileSync(path.join(process.cwd(), 'docs/REAL_CHANNELS.md'), 'utf8')
    const imessage = fs.readFileSync(path.join(process.cwd(), 'docs/IMESSAGE.md'), 'utf8')
    expect(readme).toContain('ds-agent channels check')
    expect(readme).toContain('serve --imessage --feishu')
    expect(realChannels).toContain('Inbound webhooks')
    expect(realChannels).toContain('long-connection')
    expect(realChannels).toContain('--check-chat')
    expect(realChannels).toContain('one history item')
    expect(imessage).toContain('Full Disk Access')
    expect(imessage).toContain('channels check')
  })
})
