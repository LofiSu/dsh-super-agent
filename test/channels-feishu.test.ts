import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  FeishuClient,
  FeishuOutboxAdapter,
  FeishuSource,
  decryptFeishuPayload,
  feishuConfigFromEnv,
  feishuMaxMessageAgeMs,
  feishuTriggerFromMessage,
  flattenFeishuMessage,
  parseFeishuWebhook,
  type FeishuConfig,
  type FeishuMessage,
} from '../src/channels/feishu.ts'
import { filterTrigger, ruleClassify } from '../src/ingress/filter.ts'
import { admissionRulesFromEnv } from '../src/runtime.ts'
import { FEISHU_TEXT_REQUEST_LIMIT_BYTES } from '../src/channels/feishu.ts'
import type { OutboxRow, Trigger } from '../src/shared/types.ts'

const config: FeishuConfig = {
  appId: 'cli_app',
  appSecret: 'secret',
  baseUrl: 'https://open.feishu.cn',
  chatId: 'oc_chat',
  verificationToken: 'verify-me',
  encryptKey: 'encrypt-key',
  botOpenId: 'ou_bot',
}

function message(overrides: Partial<FeishuMessage> = {}): FeishuMessage {
  return {
    message_id: 'om_1',
    chat_id: 'oc_chat',
    msg_type: 'text',
    body: { content: JSON.stringify({ text: '@ds-agent please fix the login timeout' }) },
    create_time: '1761958800000',
    sender: { id: 'ou_alice', sender_type: 'user' },
    ...overrides,
  }
}

/** API-shaped list item: unlike webhook messages, it omits chat_type. */
function apiMessage(overrides: Partial<Omit<FeishuMessage, 'chat_type'>> = {}): Omit<FeishuMessage, 'chat_type'> {
  return {
    message_id: 'om_poll',
    chat_id: 'oc_chat',
    msg_type: 'text',
    body: { content: JSON.stringify({ text: '你现在可以改了' }) },
    create_time: '1761958800000',
    sender: { id: 'ou_alice', sender_type: 'user' },
    ...overrides,
  }
}

function encrypt(plain: string, key: string): string {
  const digest = crypto.createHash('sha256').update(key).digest()
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', digest, iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, encrypted]).toString('base64')
}

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown }

function fakeFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    const result = handler(url, init)
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { fn, calls }
}

const tokenHandler: Handler = url => url.includes('tenant_access_token')
  ? { body: { code: 0, tenant_access_token: 'tok_1', expire: 7200 } }
  : { body: { code: 999, msg: `unexpected ${url}` } }

/** Deterministic semantic layer; admission itself stays on the fast path. */
const ruleSemantic = {
  name: 'RuleSemantic',
  classify: (trigger: Trigger) => ruleClassify(trigger),
  async complete() {
    return { text: '' }
  },
}

describe('Feishu config', () => {
  it('uses a positive finite message-age override and otherwise defaults to one hour', () => {
    expect(feishuMaxMessageAgeMs({ FEISHU_MAX_MESSAGE_AGE_MS: '1234' })).toBe(1234)
    expect(feishuMaxMessageAgeMs({ FEISHU_MAX_MESSAGE_AGE_MS: '0' })).toBe(60 * 60_000)
    expect(feishuMaxMessageAgeMs({ FEISHU_MAX_MESSAGE_AGE_MS: 'Infinity' })).toBe(60 * 60_000)
  })

  it('is absent when no app credentials are set', () => {
    expect(feishuConfigFromEnv({})).toBeNull()
  })

  it('throws on a half-configured app rather than silently disabling IM', () => {
    expect(() => feishuConfigFromEnv({ FEISHU_APP_ID: 'app' })).toThrow(/set together/)
    expect(() => feishuConfigFromEnv({ FEISHU_APP_SECRET: 'secret' })).toThrow(/set together/)
  })

  it('reads optional base, chat, token, encrypt key, and bot id', () => {
    expect(feishuConfigFromEnv({
      FEISHU_APP_ID: 'app',
      FEISHU_APP_SECRET: 'secret',
      FEISHU_CHAT_ID: 'oc_1',
      FEISHU_BASE_URL: 'https://open.larksuite.com/',
      FEISHU_VERIFICATION_TOKEN: 'v',
      FEISHU_ENCRYPT_KEY: 'k',
      FEISHU_BOT_OPEN_ID: 'ou_b',
    })).toEqual({
      appId: 'app',
      appSecret: 'secret',
      baseUrl: 'https://open.larksuite.com',
      chatId: 'oc_1',
      verificationToken: 'v',
      encryptKey: 'k',
      botOpenId: 'ou_b',
    })
  })
})

describe('Feishu message mapping', () => {
  it('flattens text messages', () => {
    expect(flattenFeishuMessage(message())).toBe('@ds-agent please fix the login timeout')
  })

  it('flattens rich post messages', () => {
    const post = message({
      msg_type: 'post',
      body: {
        content: JSON.stringify({
          title: 'Incident',
          content: [[{ tag: 'text', text: 'line one' }], [{ tag: 'text', text: 'line two' }]],
        }),
      },
    })
    expect(flattenFeishuMessage(post)).toContain('Incident')
    expect(flattenFeishuMessage(post)).toContain('line one')
    expect(flattenFeishuMessage(post)).toContain('line two')
  })

  it('maps a real chat message to an im Trigger with a Feishu target', () => {
    const trigger = feishuTriggerFromMessage(message(), config)
    expect(trigger.id).toBe('feishu_om_1')
    expect(trigger.source).toBe('im')
    expect(trigger.threads).toEqual([{ source: 'im', id: 'feishu:oc_chat' }])
    expect(trigger.actor).toEqual({ source: 'im', id: 'ou_alice' })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('mention')
    expect(trigger.channel?.address).toMatchObject({
      provider: 'feishu',
      chat_id: 'oc_chat',
      group: 'oc_chat',
      message_id: 'om_1',
    })
    expect(new Date(trigger.at).toISOString()).toBe('2025-11-01T01:00:00.000Z')
  })

  it('normalizes supplied chat modes and ignores visibility-only or unknown values', () => {
    const p2p = feishuTriggerFromMessage(message({ chat_type: 'p2p' }), config)
    const group = feishuTriggerFromMessage(message({ chat_type: 'topic' }), config)
    const visibility = feishuTriggerFromMessage(message({ chat_type: 'private' }), config)
    const unknown = feishuTriggerFromMessage(message({ chat_type: 'future-chat-kind' }), config)
    const missing = feishuTriggerFromMessage(message(), config)
    expect(p2p.channel?.address?.chat_type).toBe('p2p')
    expect(group.channel?.address?.chat_type).toBe('group')
    for (const trigger of [visibility, unknown, missing]) {
      expect(trigger.channel?.address).not.toHaveProperty('chat_type')
    }
  })

  it('admits a real chat message by its chat id and denies a different group', () => {
    const trigger = feishuTriggerFromMessage(message(), config)
    expect(trigger.channel?.address?.group).toBe('oc_chat')

    // The same id a deployment puts in DS_AGENT_GROUP_ALLOWLIST admits this trigger.
    const allowed = admissionRulesFromEnv({ DS_AGENT_GROUP_ALLOWLIST: 'oc_chat' })
    expect(filterTrigger(trigger, ruleSemantic, allowed)).toMatchObject({ action: 'pass' })

    const denied = admissionRulesFromEnv({ DS_AGENT_GROUP_ALLOWLIST: 'oc_other' })
    expect(filterTrigger(trigger, ruleSemantic, denied))
      .toMatchObject({ action: 'drop', layer: 'fast', reason: 'group-not-allowlisted' })
    // A message from a different chat is denied under the original allowlist.
    expect(filterTrigger(
      feishuTriggerFromMessage(message({ chat_id: 'oc_other' }), config),
      ruleSemantic,
      allowed,
    )).toMatchObject({ action: 'drop', layer: 'fast', reason: 'group-not-allowlisted' })
  })

  it('maps p2p direct mode without address.group and addressed=direct', () => {
    const prev = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
    try {
      const trigger = feishuTriggerFromMessage(message({
        chat_type: 'p2p',
        body: { content: JSON.stringify({ text: '你好' }) },
      }), config)
      expect(trigger.addressed).toBe('direct')
      expect(trigger.channel?.address?.group).toBeUndefined()
      expect(trigger.channel?.address?.chat_type).toBe('p2p')
      const groupScoped = admissionRulesFromEnv({
        DS_AGENT_GROUP_ALLOWLIST: 'oc_group_only',
        DS_AGENT_ACTOR_ALLOWLIST: 'ou_alice',
      })
      expect(filterTrigger(trigger, ruleSemantic, groupScoped)).toMatchObject({ action: 'pass' })
      expect(filterTrigger(trigger, ruleSemantic, admissionRulesFromEnv({
        DS_AGENT_GROUP_ALLOWLIST: 'oc_group_only',
        DS_AGENT_ACTOR_ALLOWLIST: 'ou_someone_else',
      }))).toMatchObject({ action: 'drop', reason: 'actor-not-allowlisted' })
    } finally {
      if (prev === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      else process.env.DS_AGENT_FEISHU_P2P_DIRECT = prev
    }
  })

  it('keeps group messages grouped under the p2p direct override', () => {
    const prev = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
    try {
      const trigger = feishuTriggerFromMessage(message({
        chat_id: 'oc_group',
        chat_type: 'group',
        body: { content: JSON.stringify({ text: '你好' }) },
      }), config)
      expect(trigger.addressed).toBeUndefined()
      expect(trigger.channel?.address?.group).toBe('oc_group')
      expect(filterTrigger(trigger, ruleSemantic, admissionRulesFromEnv({
        DS_AGENT_GROUP_ALLOWLIST: 'oc_allowed',
      }))).toMatchObject({
        action: 'drop',
        layer: 'fast',
        reason: 'group-not-allowlisted',
      })
      expect(filterTrigger(trigger, ruleSemantic)).toMatchObject({
        action: 'drop',
        layer: 'fast',
        reason: 'noise',
      })
    } finally {
      if (prev === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      else process.env.DS_AGENT_FEISHU_P2P_DIRECT = prev
    }
  })

  it('does not let a p2p address marker bypass the group allowlist without addressed=direct', () => {
    const groupScoped = admissionRulesFromEnv({ DS_AGENT_GROUP_ALLOWLIST: 'oc_allowed' })
    const base = feishuTriggerFromMessage(message({ chat_id: 'oc_chat' }), config)
    for (const addressed of [undefined, 'mention'] as const) {
      const trigger = {
        ...base,
        addressed,
        channel: {
          ...base.channel!,
          address: {
            provider: 'feishu',
            chat_id: 'oc_chat',
            chat_type: 'p2p',
            group: 'oc_restricted',
          },
        },
      }
      expect(filterTrigger(trigger, ruleSemantic, groupScoped)).toMatchObject({
        action: 'drop',
        layer: 'fast',
        reason: 'group-not-allowlisted',
      })
    }

    // Positive control: a genuinely direct-addressed p2p trigger keeps the
    // exemption even when a stale group field is present on the address.
    const direct = {
      ...base,
      addressed: 'direct' as const,
      channel: {
        ...base.channel!,
        address: {
          provider: 'feishu',
          chat_id: 'oc_chat',
          chat_type: 'p2p',
          group: 'oc_restricted',
        },
      },
    }
    expect(filterTrigger(direct, ruleSemantic, groupScoped).action).toBe('pass')
  })

  it('admits a genuine verified p2p bot mention but denies a group-marked forgery', () => {
    const groupScoped = admissionRulesFromEnv({ DS_AGENT_GROUP_ALLOWLIST: 'oc_allowed' })
    const previous = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
    try {
      // Genuine verified p2p mention: mapper sets addressed=mention and omits address.group.
      const genuine = feishuTriggerFromMessage(message({
        chat_id: 'oc_p2p',
        chat_type: 'p2p',
        body: { content: JSON.stringify({ text: '@ds-agent 你现在可以改了' }) },
        mentions: [{ id: { open_id: 'ou_bot' }, name: 'ds-agent' }],
      }), config)
      expect(genuine.addressed).toBe('mention')
      expect(genuine.channel?.address?.group).toBeUndefined()
      expect(filterTrigger(genuine, ruleSemantic, groupScoped)).toMatchObject({ action: 'pass' })

      // Forgery: same mention with a p2p marker plus a restricted group field.
      const forged = {
        ...genuine,
        channel: {
          ...genuine.channel!,
          address: { ...genuine.channel!.address!, group: 'oc_restricted' },
        },
      }
      expect(filterTrigger(forged, ruleSemantic, groupScoped)).toMatchObject({
        action: 'drop',
        layer: 'fast',
        reason: 'group-not-allowlisted',
      })
    } finally {
      if (previous === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      else process.env.DS_AGENT_FEISHU_P2P_DIRECT = previous
    }
  })

  it('honors DS_AGENT_FEISHU_P2P_DIRECT for short p2p utterances through filterTrigger', () => {
    const prev = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    const utterances = ['你现在可以改了', '在干嘛怎么回我那么慢'] as const
    try {
      delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      for (const text of utterances) {
        const trigger = feishuTriggerFromMessage(message({
          chat_type: 'p2p',
          body: { content: JSON.stringify({ text }) },
        }), config)
        expect(trigger.addressed).toBeUndefined()
        expect(trigger.channel?.address?.group).toBe('oc_chat')
        expect(filterTrigger(trigger, ruleSemantic))
          .toMatchObject({ action: 'drop', layer: 'fast', reason: 'noise' })
      }

      process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
      for (const text of utterances) {
        const trigger = feishuTriggerFromMessage(message({
          chat_type: 'p2p',
          body: { content: JSON.stringify({ text }) },
        }), config)
        expect(trigger.addressed).toBe('direct')
        expect(trigger.channel?.address?.group).toBeUndefined()
        expect(filterTrigger(trigger, ruleSemantic)).toMatchObject({ action: 'pass' })
      }

      process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
      const mentioned = feishuTriggerFromMessage(message({
        chat_type: 'p2p',
        body: { content: JSON.stringify({ text: '@ds-agent 你现在可以改了' }) },
        mentions: [{ id: { open_id: 'ou_bot' }, name: 'ds-agent' }],
      }), config)
      expect(mentioned.addressed).toBe('mention')
      expect(mentioned.channel?.address?.group).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      else process.env.DS_AGENT_FEISHU_P2P_DIRECT = prev
    }
  })

  it('treats an app sender as non-human and detects bot mention ids', () => {
    const trigger = feishuTriggerFromMessage(message({
      sender: { id: 'ou_bot', sender_type: 'app' },
      body: { content: JSON.stringify({ text: 'deploy finished' }) },
      mentions: [{ id: { open_id: 'ou_bot' }, name: 'ds-agent' }],
    }), config)
    expect(trigger.human).toBe(false)
    expect(trigger.addressed).toBe('mention')
  })

  it('aborts a hung Open Platform call so poll and outbox cannot stall', async () => {
    const hanging = (_url: string, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return
      const fail = () => reject(signal.reason ?? new Error('aborted'))
      if (signal.aborted) {
        fail()
        return
      }
      signal.addEventListener('abort', fail)
    })
    const client = new FeishuClient(config, hanging, 30)
    const started = Date.now()
    await expect(client.accessToken()).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1000)
  })

})

describe('Feishu webhook parser', () => {
  it('answers url_verification with the challenge', () => {
    expect(parseFeishuWebhook({
      type: 'url_verification',
      token: 'verify-me',
      challenge: 'challenge-123',
    }, config)).toEqual({ challenge: 'challenge-123' })
  })

  it('rejects a wrong verification token', () => {
    expect(() => parseFeishuWebhook({
      type: 'url_verification',
      token: 'wrong',
      challenge: 'x',
    }, config)).toThrow(/token mismatch/)
  })

  it('maps im.message.receive_v1 to a Trigger', () => {
    const result = parseFeishuWebhook({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', token: 'verify-me' },
      event: {
        sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user', tenant_key: 't1' },
        message: {
          message_id: 'om_webhook',
          chat_id: 'oc_chat',
          chat_type: 'p2p',
          msg_type: 'text',
          content: JSON.stringify({ text: '@ds-agent investigate this timeout' }),
          create_time: '1761958800000',
        },
      },
    }, config, { now: () => 1761958900000 })
    expect(result.trigger?.id).toBe('feishu_om_webhook')
    expect(result.trigger?.actor.id).toBe('ou_alice')
    expect(result.trigger?.threads[0]?.id).toBe('feishu:oc_chat')
    expect(result.trigger?.channel?.address?.chat_type).toBe('p2p')
  })

  it('skips stale webhook messages and keeps messages at the age boundary', () => {
    const now = 1761966000000
    const logs: string[] = []
    const parse = (createTime: string) => parseFeishuWebhook({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1' },
      event: {
        message: {
          message_id: `om_${createTime}`,
          chat_id: 'oc_chat',
          msg_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
          create_time: createTime,
        },
      },
    }, config, { now: () => now, maxMessageAgeMs: 60 * 60_000, log: line => logs.push(line) })

    expect(parse(String(now - 60 * 60_000)).trigger?.text).toBe('hello')
    expect(parse(String(now - 60 * 60_000 - 1))).toEqual({ ignored: 'stale-message' })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('skip stale')
  })

  it('fails closed for missing or unknown webhook chat types', () => {
    const parse = (chatType?: string) => parseFeishuWebhook({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1' },
      event: {
        message: {
          message_id: 'om_type_check',
          chat_id: 'oc_chat',
          ...(chatType === undefined ? {} : { chat_type: chatType }),
          msg_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
          create_time: '1761958800000',
        },
      },
    }, config, { now: () => 1761958900000 }).trigger
    const group = parse('group')
    const visibility = parse('private')
    const missing = parse()
    const unknown = parse('future-chat-kind')
    expect(group?.channel?.address?.chat_type).toBe('group')
    for (const trigger of [visibility, missing, unknown]) {
      expect(trigger?.channel?.address).not.toHaveProperty('chat_type')
    }
  })

  it('decrypts an encrypted envelope', () => {
    const plain = JSON.stringify({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', token: 'verify-me' },
      event: {
        sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
        message: {
          message_id: 'om_enc',
          chat_id: 'oc_chat',
          msg_type: 'text',
          content: JSON.stringify({ text: '@ds-agent encrypted hello' }),
          create_time: '1761958800000',
        },
      },
    })
    expect(decryptFeishuPayload(encrypt(plain, 'encrypt-key'), 'encrypt-key')).toBe(plain)
    const result = parseFeishuWebhook({ encrypt: encrypt(plain, 'encrypt-key') }, config, { now: () => 1761958900000 })
    expect(result.trigger?.text).toBe('@ds-agent encrypted hello')
  })

  it('ignores unrelated events', () => {
    expect(parseFeishuWebhook({
      schema: '2.0',
      header: { event_type: 'im.chat.updated_v1', token: 'verify-me' },
      event: {},
    }, config)).toEqual({ ignored: 'im.chat.updated_v1' })
  })
})

describe('Feishu client and outbox', () => {
  it('caps a history read at one page when requested, even when more pages exist', async () => {
    const { fn, calls } = fakeFetch(url => {
      if (url.includes('tenant_access_token')) return tokenHandler(url)
      return { body: { code: 0, data: { items: [apiMessage()], has_more: true, page_token: 'next-page' } } }
    })
    const items = await new FeishuClient(config, fn).listMessages('oc_chat', { pageSize: 1, maxPages: 1 })
    const historyCalls = calls.filter(call => call.url.includes('/open-apis/im/v1/messages?'))
    expect(items).toHaveLength(1)
    expect(historyCalls).toHaveLength(1)
    expect(new URL(historyCalls[0]!.url).searchParams.get('page_size')).toBe('1')
  })

  it('caches the tenant token and sends text to a chat', async () => {
    const { fn, calls } = fakeFetch((url, init) => {
      if (url.includes('tenant_access_token')) return tokenHandler(url, init)
      return { body: { code: 0, data: { message_id: 'om_sent' } } }
    })
    const client = new FeishuClient(config, fn)
    const result = await client.sendText('oc_chat', 'hello')
    expect(result.message_id).toBe('om_sent')
    expect(calls.filter(call => call.url.includes('tenant_access_token'))).toHaveLength(1)
    const send = calls.find(call => call.url.includes('/im/v1/messages?'))!
    expect(send.url).toContain('receive_id_type=chat_id')
    const request = JSON.parse(String(send.init?.body)) as { uuid: string }
    expect(request).toMatchObject({
      receive_id: 'oc_chat',
      msg_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    })
    expect(request.uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(request.uuid.length).toBeLessThanOrEqual(50)
    expect((send.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok_1')
  })

  it('replies in-thread when a message id is present', async () => {
    const { fn, calls } = fakeFetch((url, init) => {
      if (url.includes('tenant_access_token')) return tokenHandler(url, init)
      return { body: { code: 0, data: { message_id: 'om_reply' } } }
    })
    const client = new FeishuClient(config, fn)
    const adapter = new FeishuOutboxAdapter(client)
    const row: OutboxRow = {
      id: 'outbox_1',
      replyId: 'reply_1',
      ticketId: 'ticket_1',
      channel: 'im',
      thread: 'feishu:oc_chat',
      target: { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_1' },
      text: 'short reply',
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    const result = await adapter.send(row)
    expect(result.externalId).toBe('om_reply')
    const reply = calls.find(call => call.url.endsWith('/im/v1/messages/om_1/reply'))!
    expect(reply).toBeTruthy()
    expect((JSON.parse(String(reply.init?.body)) as { uuid: string }).uuid).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('polls a real chat through FeishuSource and maps messages to Triggers', async () => {
    const { fn } = fakeFetch((url, init) => {
      if (url.includes('tenant_access_token')) return tokenHandler(url, init)
      if (url.includes('/im/v1/chats/')) {
        return { body: { code: 0, data: { chat_mode: 'p2p', chat_type: 'private' } } }
      }
      return {
        body: {
          code: 0,
          data: {
            has_more: false,
            items: [
              message({ message_id: 'om_a', create_time: '1761958800000' }),
              message({ message_id: 'om_b', create_time: '1761958860000', body: { content: JSON.stringify({ text: 'second' }) } }),
            ],
          },
        },
      }
    })
    const client = new FeishuClient(config, fn)
    const source = new FeishuSource(client, 'oc_chat', { sinceMs: 1761958000000, config, now: () => 1761958900000 })
    const triggers = await source.pull()
    expect(triggers.map(trigger => trigger.id)).toEqual(['feishu_om_a', 'feishu_om_b'])
    expect(triggers[0]?.channel?.address?.chat_type).toBe('p2p')
    expect(triggers[1]!.text).toBe('second')
  })

  it.each([undefined, '', '0', ' 0 '])('does not mark messages direct when direct mode is disabled (%s)', async flag => {
    const { fn, calls } = fakeFetch(url => {
      if (url.includes('tenant_access_token')) return tokenHandler(url)
      if (url.includes('/open-apis/im/v1/messages?')) {
        return { body: { code: 0, data: { has_more: false, items: [apiMessage()] } } }
      }
      return { body: { code: 230002, msg: 'chat metadata permission absent' } }
    })
    const logs: string[] = []
    const source = new FeishuSource(new FeishuClient(config, fn), 'oc_chat', {
      sinceMs: 1761958000000,
      now: () => 1761958900000,
      config,
      log: line => logs.push(line),
    })
    const previous = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    if (flag === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
    else process.env.DS_AGENT_FEISHU_P2P_DIRECT = flag
    try {
      for (let pull = 0; pull < 2; pull += 1) {
        const trigger = (await source.pull())[0]!
        expect(trigger.addressed).toBeUndefined()
        expect(trigger.channel?.address?.group).toBe('oc_chat')
        expect(filterTrigger(trigger, ruleSemantic)).toMatchObject({ action: 'drop', reason: 'noise' })
      }
      // Connector wake still classifies the chat when direct mode is off,
      // but the trigger stays conservatively grouped and unaddressed.
      expect(calls.filter(call => call.url.endsWith('/open-apis/im/v1/chats/oc_chat'))).toHaveLength(2)
    } finally {
      if (previous === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      else process.env.DS_AGENT_FEISHU_P2P_DIRECT = previous
    }
  })

  it('resolves API-shaped polled messages as p2p from verified chat_mode p2p', async () => {
    const { fn, calls } = fakeFetch(url => {
      if (url.includes('tenant_access_token')) return tokenHandler(url)
      if (url.includes('/open-apis/im/v1/messages?')) {
        return { body: { code: 0, data: { has_more: false, items: [apiMessage()] } } }
      }
      if (url.endsWith('/open-apis/im/v1/chats/oc_chat')) {
        return { body: { code: 0, data: { chat_mode: 'p2p' } } }
      }
      return { body: { code: 999, msg: `unexpected ${url}` } }
    })
    const client = new FeishuClient(config, fn)
    const source = new FeishuSource(client, 'oc_chat', { sinceMs: 1761958000000, config, now: () => 1761958900000 })
    const previous = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
    try {
      const trigger = (await source.pull())[0]!
      expect(trigger.addressed).toBe('direct')
      expect(trigger.channel?.address?.group).toBeUndefined()
      expect(trigger.channel?.address?.chat_type).toBe('p2p')
      expect(filterTrigger(trigger, ruleSemantic)).toMatchObject({ action: 'pass' })
      expect(calls.some(call => call.url.endsWith('/open-apis/im/v1/chats/oc_chat'))).toBe(true)

      await source.pull()
      expect(calls.filter(call => call.url.endsWith('/open-apis/im/v1/chats/oc_chat'))).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      else process.env.DS_AGENT_FEISHU_P2P_DIRECT = previous
    }
  })

  it('keeps chat_mode private under group admission and noise rules', async () => {
    const { fn } = fakeFetch(url => {
      if (url.includes('tenant_access_token')) return tokenHandler(url)
      if (url.includes('/open-apis/im/v1/messages?')) {
        return { body: { code: 0, data: { has_more: false, items: [apiMessage()] } } }
      }
      if (url.endsWith('/open-apis/im/v1/chats/oc_chat')) {
        return { body: { code: 0, data: { chat_mode: 'private' } } }
      }
      return { body: { code: 999, msg: `unexpected ${url}` } }
    })
    const source = new FeishuSource(new FeishuClient(config, fn), 'oc_chat', {
      sinceMs: 1761958000000,
      now: () => 1761958900000,
      config,
    })
    const previous = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
    try {
      const trigger = (await source.pull())[0]!
      expect(trigger.addressed).toBeUndefined()
      expect(trigger.channel?.address?.group).toBe('oc_chat')
      expect(trigger.channel?.address?.chat_type).toBeUndefined()
      expect(filterTrigger(trigger, ruleSemantic, admissionRulesFromEnv({
        DS_AGENT_GROUP_ALLOWLIST: 'oc_chat',
      }))).toMatchObject({ action: 'drop', layer: 'fast', reason: 'noise' })
      expect(filterTrigger(trigger, ruleSemantic, admissionRulesFromEnv({
        DS_AGENT_GROUP_ALLOWLIST: 'oc_other',
      }))).toMatchObject({ action: 'drop', layer: 'fast', reason: 'group-not-allowlisted' })
    } finally {
      if (previous === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      else process.env.DS_AGENT_FEISHU_P2P_DIRECT = previous
    }
  })

  it('keeps API-shaped polled group messages under group admission and noise rules', async () => {
    const { fn } = fakeFetch(url => {
      if (url.includes('tenant_access_token')) return tokenHandler(url)
      if (url.includes('/open-apis/im/v1/messages?')) {
        return { body: { code: 0, data: { has_more: false, items: [apiMessage()] } } }
      }
      if (url.endsWith('/open-apis/im/v1/chats/oc_chat')) {
        return { body: { code: 0, data: { chat_mode: 'group', chat_type: 'private' } } }
      }
      return { body: { code: 999, msg: `unexpected ${url}` } }
    })
    const client = new FeishuClient(config, fn)
    const source = new FeishuSource(client, 'oc_chat', { sinceMs: 1761958000000, config, now: () => 1761958900000 })
    const previous = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
    try {
      const trigger = (await source.pull())[0]!
      expect(trigger.addressed).toBeUndefined()
      expect(trigger.channel?.address?.group).toBe('oc_chat')
      expect(trigger.channel?.address?.chat_type).toBe('group')
      expect(filterTrigger(trigger, ruleSemantic, admissionRulesFromEnv({
        DS_AGENT_GROUP_ALLOWLIST: 'oc_chat',
      }))).toMatchObject({ action: 'drop', layer: 'fast', reason: 'noise' })
      expect(filterTrigger(trigger, ruleSemantic, admissionRulesFromEnv({
        DS_AGENT_GROUP_ALLOWLIST: 'oc_other',
      }))).toMatchObject({ action: 'drop', layer: 'fast', reason: 'group-not-allowlisted' })
    } finally {
      if (previous === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      else process.env.DS_AGENT_FEISHU_P2P_DIRECT = previous
    }
  })

  it.each([
    ['missing chat mode', { body: { code: 0, data: {} } }],
    ['unknown chat mode', { body: { code: 0, data: { chat_mode: 'future-mode' } } }],
    ['chat metadata error', { body: { code: 230002, msg: 'metadata unavailable' } }],
  ])('keeps polled messages conservative on %s', async (_case, metadataResponse) => {
    const { fn, calls } = fakeFetch(url => {
      if (url.includes('tenant_access_token')) return tokenHandler(url)
      if (url.includes('/open-apis/im/v1/messages?')) {
        return {
          body: {
            code: 0,
            data: {
              has_more: false,
              items: [apiMessage(), apiMessage({ message_id: 'om_poll_2', create_time: '1761958860000' })],
            },
          },
        }
      }
      if (url.endsWith('/open-apis/im/v1/chats/oc_chat')) return metadataResponse
      return { body: { code: 999, msg: `unexpected ${url}` } }
    })
    const client = new FeishuClient(config, fn)
    const logs: string[] = []
    const source = new FeishuSource(client, 'oc_chat', {
      sinceMs: 1761958000000,
      now: () => 1761958900000,
      config,
      log: line => logs.push(line),
    })
    const previous = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
    try {
      const triggers = await source.pull()
      const trigger = triggers[0]!
      expect(triggers).toHaveLength(2)
      expect(logs).toHaveLength(2)
      expect(logs[0]).toContain('chat=oc_chat')
      expect(logs[0]).toMatch(/chat mode lookup (failed|unverified)/)
      expect(logs.some(line => /chat metadata lookup failed|unrecognized chat_mode/.test(line))).toBe(true)
      expect(trigger.addressed).toBeUndefined()
      expect(trigger.channel?.address?.group).toBe('oc_chat')
      expect(trigger.channel?.address?.chat_type).toBeUndefined()
      expect(filterTrigger(trigger, ruleSemantic, admissionRulesFromEnv({
        DS_AGENT_GROUP_ALLOWLIST: 'oc_chat',
      }))).toMatchObject({ action: 'drop', layer: 'fast', reason: 'noise' })
      await source.pull()
      expect(logs).toHaveLength(2)
      expect(calls.filter(call => call.url.endsWith('/open-apis/im/v1/chats/oc_chat'))).toHaveLength(2)
      // Our warning redacts provider details; the raw-detail log is emitted once.
      expect(logs[0]).not.toContain('future-mode')
      expect(logs[0]).not.toContain('metadata unavailable')
    } finally {
      if (previous === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      else process.env.DS_AGENT_FEISHU_P2P_DIRECT = previous
    }
  })

  it('retries failed chat-mode verification across pulls, warns once, then caches verified mode', async () => {
    let listCalls = 0
    let metadataCalls = 0
    const { fn, calls } = fakeFetch(url => {
      if (url.includes('tenant_access_token')) return tokenHandler(url)
      if (url.includes('/open-apis/im/v1/messages?')) {
        listCalls += 1
        return {
          body: {
            code: 0,
            data: {
              has_more: false,
              items: [apiMessage({
                message_id: `om_retry_${listCalls}`,
                create_time: String(1761958800000 + listCalls * 1_000),
              })],
            },
          },
        }
      }
      if (url.endsWith('/open-apis/im/v1/chats/oc_chat')) {
        metadataCalls += 1
        if (metadataCalls === 1) {
          return { body: { code: 230002, msg: 'private provider details should not be logged' } }
        }
        if (metadataCalls === 2) throw new Error('private custom-fetch details should not be logged')
        return { body: { code: 0, data: { chat_mode: 'p2p', chat_type: 'private' } } }
      }
      return { body: { code: 999, msg: `unexpected ${url}` } }
    })
    const client = new FeishuClient(config, fn)
    const logs: string[] = []
    const source = new FeishuSource(client, 'oc_chat', {
      sinceMs: 1761958000000,
      now: () => 1761958900000,
      config,
      log: line => logs.push(line),
    })
    const previous = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
    try {
      const first = (await source.pull())[0]!
      const second = (await source.pull())[0]!
      expect(first.addressed).toBeUndefined()
      expect(first.channel?.address?.group).toBe('oc_chat')
      expect(second.addressed).toBeUndefined()
      expect(second.channel?.address?.group).toBe('oc_chat')
      expect(metadataCalls).toBe(2)
      expect(logs).toHaveLength(2)
      expect(logs[0]).toContain('code=230002')
      expect(logs[0]).not.toContain('private provider details')
      expect(logs[0]).not.toContain('private custom-fetch details')

      const verified = (await source.pull())[0]!
      expect(verified.addressed).toBe('direct')
      expect(verified.channel?.address?.chat_type).toBe('p2p')
      expect(verified.channel?.address?.group).toBeUndefined()
      await source.pull()
      expect(metadataCalls).toBe(3)
      expect(calls.filter(call => call.url.endsWith('/open-apis/im/v1/chats/oc_chat'))).toHaveLength(3)
      expect(logs).toHaveLength(2)
    } finally {
      if (previous === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      else process.env.DS_AGENT_FEISHU_P2P_DIRECT = previous
    }
  })

  it('skips stale poll messages while advancing the cursor past them', async () => {
    const now = 1761966000000
    const staleAt = now - 2 * 60 * 60_000
    const freshAt = now - 60 * 60_000
    const { fn } = fakeFetch(url => {
      if (url.includes('tenant_access_token')) return tokenHandler(url)
      if (url.includes('/im/v1/chats/')) return { body: { code: 0, data: { chat_mode: 'p2p' } } }
      return {
        body: {
          code: 0,
          data: {
            has_more: false,
            items: [
              message({ message_id: 'om_stale', create_time: String(staleAt) }),
              message({ message_id: 'om_fresh', create_time: String(freshAt) }),
            ],
          },
        },
      }
    })
    const logs: string[] = []
    const source = new FeishuSource(new FeishuClient(config, fn), 'oc_chat', {
      sinceMs: staleAt - 1,
      config,
      now: () => now,
      log: line => logs.push(line),
    })

    const triggers = await source.pull()
    expect(triggers.map(trigger => trigger.id)).toEqual(['feishu_om_fresh'])
    expect(source.cursorMs).toBe(freshAt)
    expect(logs.some(line => line.includes('skip stale message_id=om_stale'))).toBe(true)
  })

  it('advances the poll cursor when every pulled message is stale', async () => {
    const now = 1761966000000
    const staleAt = now - 2 * 60 * 60_000
    const { fn } = fakeFetch(url => {
      if (url.includes('tenant_access_token')) return tokenHandler(url)
      if (url.includes('/im/v1/chats/')) return { body: { code: 0, data: { chat_mode: 'p2p' } } }
      return {
        body: {
          code: 0,
          data: {
            has_more: false,
            items: [message({ message_id: 'om_old', create_time: String(staleAt) })],
          },
        },
      }
    })
    const source = new FeishuSource(new FeishuClient(config, fn), 'oc_chat', {
      sinceMs: staleAt - 1,
      config,
      now: () => now,
    })

    const triggers = await source.pull()
    expect(triggers).toEqual([])
    expect(source.cursorMs).toBe(staleAt)
  })

  it('aborts a hung history list request when the source signal aborts', async () => {
    let listStarted!: () => void
    const started = new Promise<void>(resolve => { listStarted = resolve })
    let listSignal: AbortSignal | undefined
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.includes('tenant_access_token')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      }
      listSignal = init?.signal as AbortSignal | undefined
      listStarted()
      return new Promise<Response>((_resolve, reject) => {
        listSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    const source = new FeishuSource(new FeishuClient(config, fetchImpl), 'oc_chat', {
      sinceMs: 1761958000000,
      config,
    })
    const controller = new AbortController()
    const startedAt = Date.now()
    const pulling = source.pull(controller.signal)
    await started
    controller.abort()
    await expect(pulling).rejects.toThrow()
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(listSignal?.aborted).toBe(true)
  })

  it('bounds a hung official chat-mode lookup and honors shutdown abort', async () => {
    let chatStarted!: () => void
    const started = new Promise<void>(resolve => { chatStarted = resolve })
    const never = new Promise<Response>(() => undefined)
    let chatSignal: AbortSignal | undefined
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.includes('tenant_access_token')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      }
      if (input.includes('/im/v1/chats/')) {
        chatSignal = init?.signal as AbortSignal | undefined
        chatStarted()
        return never
      }
      return new Response(JSON.stringify({ code: 0, data: { items: [message()], has_more: false } }))
    }
    const timedSource = new FeishuSource(new FeishuClient(config, fetchImpl), 'oc_chat', { sinceMs: 1761958000000, config, now: () => 1761958900000 })
    const startedAt = Date.now()
    const timedTriggers = await timedSource.pull()
    expect(Date.now() - startedAt).toBeLessThan(6_500)
    expect(timedTriggers[0]?.channel?.address).not.toHaveProperty('chat_type')
    await started

    chatSignal = undefined
    const abortSource = new FeishuSource(new FeishuClient(config, fetchImpl), 'oc_chat', { sinceMs: 1761958000000, config, now: () => 1761958900000 })
    const controller = new AbortController()
    const pulling = abortSource.pull(controller.signal)
    await started
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await expect(pulling).rejects.toThrow()
    const observedSignal = chatSignal as unknown as AbortSignal | undefined
    expect(observedSignal).toBeDefined()
    expect(observedSignal?.aborted).toBe(true)
  }, 8_000)

  it('uses only chat_mode for poll classification and logs missing, unknown, or failed metadata', async () => {
    const cases: {
      mode?: string
      visibility?: string
      fail?: boolean
      expected?: string
      log?: RegExp
    }[] = [
      { mode: 'p2p', visibility: 'private', expected: 'p2p' },
      { mode: 'group', visibility: 'private', expected: 'group' },
      { mode: 'topic', visibility: 'public', expected: 'group' },
      { visibility: 'private', log: /unrecognized chat_mode.*\(missing\)/ },
      { mode: 'future-mode', visibility: 'public', log: /unrecognized chat_mode.*future-mode/ },
      { fail: true, log: /chat metadata lookup failed.*230002/ },
    ]
    for (const [index, entry] of cases.entries()) {
      const { fn } = fakeFetch(url => {
        if (url.includes('tenant_access_token')) return tokenHandler(url)
        if (url.includes('/im/v1/chats/')) {
          return entry.fail
            ? { body: { code: 230002, msg: 'permission denied' } }
            : { body: { code: 0, data: { ...(entry.mode ? { chat_mode: entry.mode } : {}), ...(entry.visibility ? { chat_type: entry.visibility } : {}) } } }
        }
        return {
          body: {
            code: 0,
            data: {
              has_more: false,
              items: [message({ message_id: `om_mode_${index}` })],
            },
          },
        }
      })
      const logs: string[] = []
      const source = new FeishuSource(new FeishuClient(config, fn), 'oc_chat', {
        sinceMs: 1761958000000,
        config,
        now: () => 1761958900000,
        log: line => logs.push(line),
      })
      const [trigger] = await source.pull()
      if (entry.expected) expect(trigger?.channel?.address?.chat_type).toBe(entry.expected)
      else expect(trigger?.channel?.address).not.toHaveProperty('chat_type')
      if (entry.log) expect(logs.some(line => entry.log!.test(line))).toBe(true)
    }
  })

  it('surfaces a Feishu API error instead of dropping it', async () => {
    const { fn } = fakeFetch(url => url.includes('tenant_access_token')
      ? { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
      : { body: { code: 230002, msg: 'bot not in chat' } })
    const client = new FeishuClient(config, fn)
    await expect(client.sendText('oc_chat', 'hi')).rejects.toThrow(/230002/)
  })
})

describe('Feishu Markdown card outbox formatting', () => {
  const makeRow = (text: string, target: OutboxRow['target'] = { provider: 'feishu', chat_id: 'oc_chat' }): OutboxRow => ({
    id: 'outbox_card',
    replyId: 'reply_card',
    ticketId: 'ticket_durable_1',
    channel: 'im',
    thread: 'feishu:oc_chat',
    target,
    text,
    status: 'pending',
    createdAt: new Date().toISOString(),
  })

  const withFormat = async (format: string | undefined, run: () => Promise<void>): Promise<void> => {
    const previous = process.env.FEISHU_REPLY_FORMAT
    if (format === undefined) delete process.env.FEISHU_REPLY_FORMAT
    else process.env.FEISHU_REPLY_FORMAT = format
    try {
      await run()
    } finally {
      if (previous === undefined) delete process.env.FEISHU_REPLY_FORMAT
      else process.env.FEISHU_REPLY_FORMAT = previous
    }
  }

  const sentCalls = (calls: { url: string; init?: RequestInit }[]) => calls.filter(call =>
    call.url.includes('/open-apis/im/v1/messages') && !call.url.includes('tenant_access_token'))

  it('retains provider and missing-target checks without making an API call', async () => {
    await withFormat(undefined, async () => {
      const { fn, calls } = fakeFetch(url => url.includes('tenant_access_token')
        ? { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        : { body: { code: 0, data: { message_id: 'unexpected' } } })
      const adapter = new FeishuOutboxAdapter(new FeishuClient(config, fn))
      await expect(adapter.send(makeRow('## Structured', { provider: 'github', chat_id: 'oc_chat' })))
        .rejects.toThrow(/targets github, not feishu/)
      await expect(adapter.send(makeRow('plain', { provider: 'feishu' })))
        .rejects.toThrow(/has no chat_id\/message_id/)
      expect(calls).toHaveLength(0)
    })
  })

  it('keeps a short plain answer as text by default on chat-send and thread-reply routes', async () => {
    await withFormat(undefined, async () => {
      const { fn, calls } = fakeFetch(url => url.includes('tenant_access_token')
        ? { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        : { body: { code: 0, data: { message_id: 'sent_plain' } } })
      const adapter = new FeishuOutboxAdapter(new FeishuClient(config, fn))
      await adapter.send(makeRow('A short answer.'))
      await adapter.send(makeRow('Another short answer.', { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_source' }))
      const [send, reply] = sentCalls(calls)
      expect(send.init?.method).toBe('POST')
      expect(send.url).toBe('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
      expect(JSON.parse(String(send.init?.body))).toMatchObject({ msg_type: 'text', content: JSON.stringify({ text: 'A short answer.' }) })
      expect(reply.init?.method).toBe('POST')
      expect(reply.url).toBe('https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply')
      expect(JSON.parse(String(reply.init?.body))).toMatchObject({ msg_type: 'text', content: JSON.stringify({ text: 'Another short answer.' }) })
    })
  })

  it.each([
    ['heading', '## Résultat\nC’est corrigé.'],
    ['list', 'Next steps:\n- restart\n- verify'],
    ['fenced code', '```ts\nconst ready = true\n```'],
  ])('sends a structured %s reply as official interactive card JSON', async (_kind, text) => {
    await withFormat(undefined, async () => {
      const { fn, calls } = fakeFetch(url => url.includes('tenant_access_token')
        ? { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        : { body: { code: 0, data: { message_id: 'sent_card' } } })
      const adapter = new FeishuOutboxAdapter(new FeishuClient(config, fn))
      await adapter.send(makeRow(text, { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_source' }))
      const [call] = sentCalls(calls)
      expect(call.init?.method).toBe('POST')
      expect(call.url).toBe('https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply')
      const request = JSON.parse(String(call.init?.body)) as { msg_type: string; content: string; uuid: string }
      expect(request.msg_type).toBe('interactive')
      expect(request.uuid).toMatch(/^[0-9a-f-]{36}$/)
      expect(request.uuid.length).toBeLessThanOrEqual(50)
      const card = JSON.parse(request.content) as { header: { title: { tag: string; content: string } }; elements: { tag: string; text: { tag: string; content: string } }[] }
      expect(card.header.title).toEqual({ tag: 'plain_text', content: 'ds-agent · 助手 🌱' })
      expect(card.elements).toHaveLength(1)
      expect(card.elements[0]).toMatchObject({ tag: 'div', text: { tag: 'lark_md', content: text } })
      expect(JSON.stringify(card)).not.toContain('button')
      expect(card.header.title.content).toBe('ds-agent · 助手 🌱')
    })
  })

  it('uses distinct uuids for different text hashes and chunk indexes', async () => {
    await withFormat('text', async () => {
      const { fn, calls } = fakeFetch(url => url.includes('tenant_access_token')
        ? { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        : { body: { code: 0, data: { message_id: `sent_${sentCalls(calls).length}` } } })
      const adapter = new FeishuOutboxAdapter(new FeishuClient(config, fn))
      const first = makeRow('same route, first content')
      const second = makeRow('same route, different content')
      await adapter.sendWithProgress(first, () => undefined)
      await adapter.sendWithProgress(second, () => undefined)
      const uuids = sentCalls(calls).map(call => String((JSON.parse(String(call.init?.body)) as { uuid: string }).uuid))
      expect(uuids).toHaveLength(2)
      expect(new Set(uuids).size).toBe(2)

      const chunks = '界🙂'.repeat(30_000)
      await adapter.sendWithProgress(makeRow(chunks), () => undefined)
      const chunkUuids = sentCalls(calls).slice(2).map(call => String((JSON.parse(String(call.init?.body)) as { uuid: string }).uuid))
      expect(chunkUuids.length).toBeGreaterThan(1)
      expect(new Set(chunkUuids).size).toBe(chunkUuids.length)
    })
  })

  it('treats JSON, mention tags, and button declarations as body text only', async () => {
    await withFormat(undefined, async () => {
      const body = '## Details\n```json\n{"buttons":[{"text":"do it"}]}\n```\n<at user_id="ou_fake">name</at>'
      const { fn, calls } = fakeFetch(url => url.includes('tenant_access_token')
        ? { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        : { body: { code: 0, data: { message_id: 'sent_card' } } })
      await new FeishuOutboxAdapter(new FeishuClient(config, fn)).send(makeRow(body))
      const req = JSON.parse(String(sentCalls(calls)[0]?.init?.body)) as { content: string }
      const card = JSON.parse(req.content) as { elements: { text: { content: string } }[] }
      expect(card.elements).toHaveLength(1)
      expect(card.elements[0]?.text.content).toBe(body)
      expect(JSON.stringify(card)).not.toContain('"tag":"button"')
      expect(JSON.stringify(card)).not.toContain('"tag":"action"')
    })
  })

  it('forces structured replies to text when FEISHU_REPLY_FORMAT=text', async () => {
    await withFormat('text', async () => {
      const { fn, calls } = fakeFetch(url => url.includes('tenant_access_token')
        ? { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        : { body: { code: 0, data: { message_id: 'sent_text' } } })
      await new FeishuOutboxAdapter(new FeishuClient(config, fn)).send(makeRow('# Heading\n- item'))
      const request = JSON.parse(String(sentCalls(calls)[0]?.init?.body))
      expect(request.msg_type).toBe('text')
      expect(request.content).toBe(JSON.stringify({ text: '# Heading\n- item' }))
    })
  })

  it('preserves Chinese and emoji in serialized card content', async () => {
    await withFormat(undefined, async () => {
      const { fn, calls } = fakeFetch(url => url.includes('tenant_access_token')
        ? { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        : { body: { code: 0, data: { message_id: 'sent_card' } } })
      await new FeishuOutboxAdapter(new FeishuClient(config, fn)).send(makeRow('## 完成 ✅\n- 你好 🌱'))
      const request = JSON.parse(String(sentCalls(calls)[0]?.init?.body)) as { content: string }
      expect(request.content).toContain('ds-agent')
      expect(request.content).toContain('完成 ✅')
      expect(request.content).toContain('你好 🌱')
    })
  })

  it.each([
    ['chat send', { provider: 'feishu', chat_id: 'oc_chat' } as OutboxRow['target']],
    ['reply', { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_source' } as OutboxRow['target']],
  ])('sends the complete text when the card is oversized but text fits (%s)', async (_route, target) => {
    await withFormat(undefined, async () => {
      const { fn, calls } = fakeFetch(url => url.includes('tenant_access_token')
        ? { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        : { body: { code: 0, data: { message_id: 'sent_text' } } })
      const text = '## 结论 ✅\n```ts\n' + '界🙂'.repeat(20_000)
      await new FeishuOutboxAdapter(new FeishuClient(config, fn)).send(makeRow(text, target))
      const sent = sentCalls(calls)
      expect(sent).toHaveLength(1)
      const req = JSON.parse(String(sent[0]?.init?.body)) as { msg_type: string; content: string }
      expect(req.msg_type).toBe('text')
      expect(JSON.parse(req.content)).toEqual({ text })
      expect(sent.some(call => JSON.parse(String(call.init?.body)).msg_type === 'interactive')).toBe(false)
      expect(req.content).not.toContain('内容已截断')
    })
  })

  it('persists split chunk uuids before send and reuses them after an ack-window crash', async () => {
    await withFormat('text', async () => {
      const createdByUuid = new Map<string, string>()
      const requests: { url: string; body: Record<string, unknown> }[] = []
      const { fn } = fakeFetch((url, init) => {
        if (url.includes('tenant_access_token')) return { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        requests.push({ url, body })
        const uuid = String(body.uuid)
        let messageId = createdByUuid.get(uuid)
        if (!messageId) {
          messageId = `created_${createdByUuid.size + 1}`
          createdByUuid.set(uuid, messageId)
        }
        return { body: { code: 0, data: { message_id: messageId } } }
      })
      const adapter = new FeishuOutboxAdapter(new FeishuClient(config, fn))
      const text = '界🙂'.repeat(30_000)
      let target: OutboxRow['target'] = { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_source' }
      let threwAfterFirstAck = false
      await expect(adapter.sendWithProgress(makeRow(text, target), (next, externalId) => {
        if (externalId && !threwAfterFirstAck) {
          threwAfterFirstAck = true
          throw new Error('simulated crash before accepted progress')
        }
        target = next
      })).rejects.toThrow(/simulated crash/)

      const firstAttempt = requests[0]!.body
      const firstUuid = String(firstAttempt.uuid)
      expect(firstUuid).toMatch(/^[0-9a-f-]{32,36}$/)
      expect(firstUuid.length).toBeLessThanOrEqual(50)
      expect(target.__ds_feishu_text_progress).toBeTruthy()
      expect(createdByUuid.size).toBe(1)
      const acceptedFirstId = createdByUuid.get(firstUuid)

      const result = await adapter.sendWithProgress(makeRow(text, target), next => { target = next })
      expect(result.externalId).toBe(acceptedFirstId)
      expect(requests.filter(request => request.body.uuid === firstUuid)).toHaveLength(2)
      expect(createdByUuid.get(firstUuid)).toBe(acceptedFirstId)
      expect(createdByUuid.size).toBeGreaterThan(1)
      const uuids = requests.map(request => String(request.body.uuid))
      expect(new Set(uuids).size).toBe(createdByUuid.size)
      expect(requests.every(request => request.url.endsWith('/om_source/reply'))).toBe(true)
    })
  })

  it('sends complete oversized text in marked in-chat chunks within the request body limit', async () => {
    await withFormat(undefined, async () => {
      const { fn, calls } = fakeFetch(url => url.includes('tenant_access_token')
        ? { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        : { body: { code: 0, data: { message_id: `sent_${sentCalls(calls).length}` } } })
      const text = '## 结论 ✅\n```ts\n' + '界🙂'.repeat(30_000)
      await new FeishuOutboxAdapter(new FeishuClient(config, fn)).send(makeRow(text, {
        provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_source',
      }))
      const sent = sentCalls(calls)
      expect(sent.length).toBeGreaterThan(1)
      expect(sent.every(call => call.url === 'https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply')).toBe(true)
      const messages = sent.map(call => {
        const body = String(call.init?.body)
        expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(FEISHU_TEXT_REQUEST_LIMIT_BYTES)
        const request = JSON.parse(body) as { msg_type: string; content: string }
        expect(request.msg_type).toBe('text')
        return (JSON.parse(request.content) as { text: string }).text
      })
      expect(messages[0]).toMatch(/^（1\/\d+）\n## 结论 ✅/)
      expect(messages.slice(1).every(message => /^（续 \d+\/\d+）\n/.test(message))).toBe(true)
      const total = messages[0]?.match(/^（1\/(\d+)）/)?.[1]
      expect(messages.every(message => message.includes(`/${total}）`))).toBe(true)
      const original = messages.map(message => message.replace(/^（(?:续 )?\d+\/\d+）\n/, '')).join('')
      expect(original).toBe(text)
    })
  })

  it('skips Feishu when a single text acceptance was persisted before the caller lost the result', async () => {
    await withFormat('text', async () => {
      const { fn, calls } = fakeFetch(url => url.includes('tenant_access_token')
        ? { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        : { body: { code: 0, data: { message_id: 'text_accepted' } } })
      const adapter = new FeishuOutboxAdapter(new FeishuClient(config, fn))
      const row = makeRow('short accepted text', { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_source' })
      let durableTarget = row.target
      const firstResult = await adapter.sendWithProgress(row, target => { durableTarget = target })
      const retryResult = await adapter.sendWithProgress({ ...row, target: durableTarget }, target => { durableTarget = target })

      expect(retryResult.externalId).toBe(firstResult.externalId)
      expect(JSON.parse(durableTarget.__ds_feishu_text_progress ?? '{}')).toMatchObject({
        nextChunk: 1,
        total: 1,
        firstExternalId: firstResult.externalId,
      })
      expect(sentCalls(calls)).toHaveLength(1)
      expect(sentCalls(calls)[0]?.url).toContain('/om_source/reply')
    })
  })

  it('skips Feishu when an interactive card acceptance was persisted before the caller lost the result', async () => {
    await withFormat(undefined, async () => {
      const calls: { url: string; body: Record<string, unknown> }[] = []
      const { fn } = fakeFetch((url, init) => {
        if (url.includes('tenant_access_token')) return { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return { body: { code: 0, data: { message_id: `card_${calls.length}` } } }
      })
      const adapter = new FeishuOutboxAdapter(new FeishuClient(config, fn))
      const row = makeRow('## Structured\n- body', { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_source' })
      let durableTarget = row.target
      const firstResult = await adapter.sendWithProgress(row, target => { durableTarget = target })
      const retryResult = await adapter.sendWithProgress({ ...row, target: durableTarget }, target => { durableTarget = target })

      expect(retryResult.externalId).toBe(firstResult.externalId)
      expect(JSON.parse(durableTarget.__ds_feishu_text_progress ?? '{}')).toMatchObject({
        interactiveHash: expect.any(String),
        interactiveExternalId: firstResult.externalId,
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.body.msg_type).toBe('interactive')
      expect(calls[0]?.url).toContain('/om_source/reply')
    })
  })

  it('reuses a persisted interactive uuid when the caller loses the accepted result', async () => {
    await withFormat(undefined, async () => {
      const createdByUuid = new Map<string, string>()
      const calls: { url: string; body: Record<string, unknown> }[] = []
      const { fn } = fakeFetch((url, init) => {
        if (url.includes('tenant_access_token')) return { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        calls.push({ url, body })
        const uuid = String(body.uuid)
        let messageId = createdByUuid.get(uuid)
        if (!messageId) {
          messageId = `card_${createdByUuid.size + 1}`
          createdByUuid.set(uuid, messageId)
        }
        return { body: { code: 0, data: { message_id: messageId } } }
      })
      const adapter = new FeishuOutboxAdapter(new FeishuClient(config, fn))
      const row = makeRow('## Structured\n- body', { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_source' })
      let durableTarget = row.target
      await expect(adapter.sendWithProgress(row, (target, externalId) => {
        if (externalId) throw new Error('simulated loss before accepted progress was persisted')
        durableTarget = target
      })).rejects.toThrow(/simulated loss/)
      const retryResult = await adapter.sendWithProgress({ ...row, target: durableTarget }, () => undefined)
      expect(retryResult.externalId).toBe('card_1')
      expect(calls).toHaveLength(2)
      expect(calls[0]?.body.uuid).toBe(calls[1]?.body.uuid)
      expect(createdByUuid.size).toBe(1)
      expect(calls.every(call => call.url.endsWith('/om_source/reply'))).toBe(true)
    })
  })

  it('reuses persisted text fallback acceptance before retrying a rejected card', async () => {
    await withFormat(undefined, async () => {
      const requests: { url: string; body: Record<string, unknown> }[] = []
      const { fn } = fakeFetch((url, init) => {
        if (url.includes('tenant_access_token')) return { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        requests.push({ url, body })
        if (requests.length === 1) return { status: 400, body: { code: 230099, msg: 'card content rejected' } }
        return { body: { code: 0, data: { message_id: requests.length === 2 ? 'text_accepted' : 'card_2' } } }
      })
      const adapter = new FeishuOutboxAdapter(new FeishuClient(config, fn))
      const row = makeRow('## Structured\n- body')
      let durableTarget = row.target
      const firstResult = await adapter.sendWithProgress(row, target => { durableTarget = target })
      const savedTextProgress = JSON.parse(durableTarget.__ds_feishu_text_progress ?? '{}') as Record<string, unknown>

      expect(firstResult.externalId).toBe('text_accepted')
      expect(savedTextProgress).toMatchObject({
        textHash: expect.any(String),
        nextChunk: 1,
        total: 1,
        firstExternalId: 'text_accepted',
      })
      expect(requests).toHaveLength(2)
      expect(requests.map(request => request.body.msg_type)).toEqual(['interactive', 'text'])

      const retryResult = await adapter.sendWithProgress({ ...row, target: durableTarget }, target => { durableTarget = target })

      expect(retryResult.externalId).toBe('text_accepted')
      expect(requests).toHaveLength(2)
    })
  })

  it('falls back once to text only for documented card rejection codes', async () => {
    await withFormat(undefined, async () => {
      const { fn, calls } = fakeFetch(url => {
        if (url.includes('tenant_access_token')) return { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        const count = calls.filter(call => call.url.includes('/open-apis/im/v1/messages')).length
        return count === 1
          ? { status: 400, body: { code: 230099, msg: 'card content rejected' } }
          : { body: { code: 0, data: { message_id: 'sent_text' } } }
      })
      const result = await new FeishuOutboxAdapter(new FeishuClient(config, fn)).send(makeRow('## Structured\n- body'))
      const sent = sentCalls(calls)
      expect(sent).toHaveLength(2)
      const cardRequest = JSON.parse(String(sent[0]?.init?.body)) as { msg_type: string; uuid: string }
      const textRequest = JSON.parse(String(sent[1]?.init?.body)) as { msg_type: string; content: string; uuid: string }
      expect(cardRequest.msg_type).toBe('interactive')
      expect(textRequest).toMatchObject({ msg_type: 'text', content: JSON.stringify({ text: '## Structured\n- body' }) })
      expect(cardRequest.uuid).not.toBe(textRequest.uuid)
      expect(result.externalId).toBe('sent_text')
    })
  })

  it('does not send a text follow-up after a hung request timeout or HTTP 429', async () => {
    await withFormat(undefined, async () => {
      const timeoutCalls: { url: string; init?: RequestInit }[] = []
      const hangingFetch = async (url: string, init?: RequestInit): Promise<Response> => {
        timeoutCalls.push({ url, init })
        if (url.includes('tenant_access_token')) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
        }
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) return reject(new Error('request hung without abort signal'))
          const abort = () => reject(signal.reason ?? new Error('aborted'))
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
      }
      await expect(new FeishuOutboxAdapter(new FeishuClient(config, hangingFetch, 20)).send(makeRow('## Structured\n- body'))).rejects.toThrow()
      expect(sentCalls(timeoutCalls)).toHaveLength(1)
      expect(JSON.parse(String(sentCalls(timeoutCalls)[0]?.init?.body)).msg_type).toBe('interactive')

      const { fn, calls } = fakeFetch(url => url.includes('tenant_access_token')
        ? { body: { code: 0, tenant_access_token: 'tok', expire: 7200 } }
        : { status: 429, body: { code: 999, msg: 'rate limited' } })
      await expect(new FeishuOutboxAdapter(new FeishuClient(config, fn)).send(makeRow('## Structured\n- body'))).rejects.toThrow()
      expect(sentCalls(calls)).toHaveLength(1)
      expect(JSON.parse(String(sentCalls(calls)[0]?.init?.body)).msg_type).toBe('interactive')
    })
  })
})
