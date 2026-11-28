import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Outbox, PermanentDeliveryError, type OutboundAdapter } from '../src/channels/outbox-adapter.ts'
import { FeishuClient, FeishuOutboxAdapter } from '../src/channels/feishu.ts'
import {
  EXTERNAL_OP_KIND,
  finalizeUncertainExternalEffects,
  UNKNOWN_OUTCOME_PREFIX,
  type ExternalOperationRecord,
} from '../src/core/external-effects.ts'
import { Replies, splitChatText } from '../src/core/replies.ts'
import type { Host } from '../src/core/host.ts'
import type { OutboxRow, Ticket, Trigger } from '../src/shared/types.ts'
import { Store } from '../src/store/sqlite.ts'

const homes: string[] = []

function tempStore(): Store {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lofibot-outbox-'))
  homes.push(home)
  return new Store(home)
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'ticket_1',
    title: 'real issue',
    brief: 'real issue',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: 'real issue',
      actor: { source: 'github', id: 'LofiSu' },
      basis: 'addressed',
    },
    threadKeys: ['github:issue:7'],
    channels: [{ source: 'github', thread: 'issue:7', address: { provider: 'github', repo: 'LofiSu/x', issue: '7' } }],
    inputs: [],
    assignments: [{ id: 'asg_1', state: 'running', speculative: false }],
    speculative: false,
    originTriggerId: 'gh_issue_1_body',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'outbox_1',
    replyId: 'reply_1',
    ticketId: 'ticket_1',
    channel: 'github',
    thread: 'issue:7',
    target: { provider: 'github', repo: 'LofiSu/x', issue: '7' },
    text: 'lofibot note',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('durable outbox', () => {
  it('Replies enqueues instead of claiming delivery', () => {
    const store = tempStore()
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: () => undefined,
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const replies = new Replies(host)
    replies.acknowledge(ticket())
    expect(store.listReplies()).toHaveLength(1)
    expect(store.listReplies()[0]!.status).toBe('pending')
    const queued = store.listOutbox('pending')
    expect(queued).toHaveLength(1)
    expect(queued[0]!.channel).toBe('github')
    expect(queued[0]!.thread).toBe('issue:7')
    expect(queued[0]!.target.issue).toBe('7')
    expect(queued[0]!.text).toContain('LofiBot note')
    store.close()
  })

  it('targets the latest human Feishu message on the selected thread', () => {
    const store = tempStore()
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: () => undefined,
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const first: Trigger = {
      id: 'feishu_origin', source: 'im', threads: [{ source: 'im', id: 'feishu:oc_chat' }],
      actor: { source: 'im', id: 'alice' }, human: true, at: '2026-01-01T00:00:00.000Z',
      text: 'start', channel: { source: 'im', thread: 'feishu:oc_chat', address: { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_origin' } }, meta: {},
    }
    const latest: Trigger = {
      ...first, id: 'feishu_latest', at: '2026-01-01T00:01:00.000Z', text: 'follow up',
      channel: { ...first.channel!, address: { ...first.channel!.address!, message_id: 'om_latest' } },
    }
    store.putDoc('trigger', first.id, first)
    store.putDoc('trigger', latest.id, latest)
    store.putDoc('thread', 'im:feishu:oc_chat', {
      key: 'im:feishu:oc_chat', ref: { source: 'im', id: 'feishu:oc_chat' }, createdAt: first.at,
      subscriptions: [], correlated: [], pending: [], meta: {},
    })
    const feishuTicket = ticket({
      threadKeys: ['im:feishu:oc_chat'],
      channels: [{ source: 'im', thread: 'feishu:oc_chat', address: { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_origin' } }],
      inputs: [
        { id: 'input_origin', kind: 'trigger', triggerId: first.id, text: first.text, at: first.at, human: true },
        { id: 'input_latest', kind: 'trigger', triggerId: latest.id, text: latest.text, at: latest.at, human: true },
      ],
    })

    new Replies(host).answer(feishuTicket, 'response')
    expect(store.listOutbox('pending')[0]?.target.message_id).toBe('om_latest')
    store.close()
  })

  it('keeps Feishu quote targets and stop-quoting preferences scoped to the selected chat', () => {
    const store = tempStore()
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: () => undefined,
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const first: Trigger = {
      id: 'feishu_a_origin', source: 'im', threads: [{ source: 'im', id: 'feishu:oc_a' }],
      actor: { source: 'im', id: 'alice' }, human: true, at: '2026-01-01T00:00:00.000Z',
      text: 'start',
      channel: { source: 'im', thread: 'feishu:oc_a', address: { provider: 'feishu', chat_id: 'oc_a', message_id: 'om_a_origin' } }, meta: {},
    }
    const latestA: Trigger = {
      ...first, id: 'feishu_a_latest', at: '2026-01-01T00:01:00.000Z', text: 'ordinary follow up',
      channel: { ...first.channel!, address: { ...first.channel!.address!, message_id: 'om_a_latest' } },
    }
    const stopB: Trigger = {
      ...first, id: 'feishu_b_stop', threads: [{ source: 'im', id: 'feishu:oc_b' }],
      at: '2026-01-01T00:02:00.000Z', text: '别用回复了你直接给我发吧',
      channel: { source: 'im', thread: 'feishu:oc_b', address: { provider: 'feishu', chat_id: 'oc_b', message_id: 'om_b_stop' } },
    }
    for (const trigger of [first, latestA, stopB]) store.putDoc('trigger', trigger.id, trigger)
    for (const trigger of [first, stopB]) {
      const ref = trigger.threads[0]!
      const key = `${ref.source}:${ref.id}`
      store.putDoc('thread', key, {
        key, ref, createdAt: trigger.at, subscriptions: [], correlated: [], pending: [], meta: {},
      })
    }
    const feishuTicket = ticket({
      threadKeys: ['im:feishu:oc_a', 'im:feishu:oc_b'],
      channels: [
        { source: 'im', thread: 'feishu:oc_a', address: { provider: 'feishu', chat_id: 'oc_a', message_id: 'om_a_origin' } },
        { source: 'im', thread: 'feishu:oc_b', address: { provider: 'feishu', chat_id: 'oc_b', message_id: 'om_b_stop' } },
      ],
      inputs: [first, latestA, stopB].map(trigger => ({
        id: `input_${trigger.id}`, kind: 'trigger' as const, triggerId: trigger.id,
        text: trigger.text, at: trigger.at, human: true,
      })),
    })

    new Replies(host).answer(feishuTicket, 'response')
    const target = store.listOutbox('pending')[0]?.target
    expect(target?.chat_id).toBe('oc_a')
    expect(target?.message_id).toBe('om_a_latest')
    expect(store.getDoc<{ meta: Record<string, unknown> }>('thread', 'im:feishu:oc_a')?.meta.feishuStopQuoting).toBeUndefined()
    expect(store.getDoc<{ meta: Record<string, unknown> }>('thread', 'im:feishu:oc_b')?.meta.feishuStopQuoting).toBeUndefined()
    store.close()
  })

  it('persists a Feishu stop-quoting request and omits message_id on later sends', () => {
    const store = tempStore()
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: () => undefined,
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const inbound: Trigger = {
      id: 'feishu_stop', source: 'im', threads: [{ source: 'im', id: 'feishu:oc_chat' }],
      actor: { source: 'im', id: 'alice' }, human: true, at: '2026-01-01T00:02:00.000Z',
      text: '别用回复了你直接给我发吧',
      channel: { source: 'im', thread: 'feishu:oc_chat', address: { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_stop' } }, meta: {},
    }
    store.putDoc('trigger', inbound.id, inbound)
    store.putDoc('thread', 'im:feishu:oc_chat', {
      key: 'im:feishu:oc_chat', ref: { source: 'im', id: 'feishu:oc_chat' }, createdAt: inbound.at,
      subscriptions: [], correlated: [], pending: [], meta: {},
    })
    const feishuTicket = ticket({
      threadKeys: ['im:feishu:oc_chat'],
      channels: [{ source: 'im', thread: 'feishu:oc_chat', address: { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_origin' } }],
      inputs: [{ id: 'input_stop', kind: 'trigger', triggerId: inbound.id, text: inbound.text, at: inbound.at, human: true }],
    })
    const replies = new Replies(host)

    replies.answer(feishuTicket, 'first direct response')
    replies.answer(feishuTicket, 'later direct response')
    const ordinary: Trigger = {
      ...inbound, id: 'feishu_ordinary', at: '2026-01-01T00:03:00.000Z', text: 'ordinary follow up',
      channel: { ...inbound.channel!, address: { ...inbound.channel!.address!, message_id: 'om_ordinary' } },
    }
    store.putDoc('trigger', ordinary.id, ordinary)
    replies.answer({
      ...feishuTicket,
      inputs: [{ id: 'input_ordinary', kind: 'trigger', triggerId: ordinary.id, text: ordinary.text, at: ordinary.at, human: true }],
    }, 'response after stop request')
    const queued = store.listOutbox('pending')
    expect(queued).toHaveLength(3)
    expect(queued.every(row => !('message_id' in row.target))).toBe(true)
    expect(store.getDoc<{ meta: Record<string, unknown> }>('thread', 'im:feishu:oc_chat')?.meta.feishuStopQuoting).toBe(true)
    store.close()
  })

  it('does not send the canned acknowledgement into an iMessage conversation', () => {
    const store = tempStore()
    const lines: string[] = []
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: line => { lines.push(line) },
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const imessageTicket = ticket({
      threadKeys: ['imessage:chat:any;-;+1'],
      channels: [{
        source: 'imessage',
        thread: 'chat:any;-;+1',
        address: { handle: '+1', chatGuid: 'any;-;+1' },
      }],
    })
    const replies = new Replies(host)
    replies.acknowledge(imessageTicket, 'imessage:chat:any;-;+1')
    expect(store.listReplies()).toHaveLength(0)
    expect(store.listOutbox('pending')).toHaveLength(0)
    expect(lines.some(line => line.includes('ack-suppressed') && line.includes('channel=imessage'))).toBe(true)

    // Only the acknowledgement is suppressed; the real answer still goes out.
    replies.answer(imessageTicket, '你好，我在。')
    expect(store.listReplies()).toHaveLength(1)
    expect(store.listOutbox('pending')).toHaveLength(1)
    store.close()
  })

  it('does not send the canned acknowledgement into a Feishu conversation', () => {
    const store = tempStore()
    const lines: string[] = []
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: line => { lines.push(line) },
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const feishuTicket = ticket({
      threadKeys: ['im:feishu:oc_chat'],
      channels: [{
        source: 'im',
        thread: 'feishu:oc_chat',
        address: { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_1' },
      }],
    })
    const replies = new Replies(host)
    replies.acknowledge(feishuTicket, 'im:feishu:oc_chat')
    expect(store.listReplies()).toHaveLength(0)
    expect(store.listOutbox('pending')).toHaveLength(0)
    expect(lines.some(line => line.includes('ack-suppressed') && line.includes('channel=im'))).toBe(true)

    replies.answer(feishuTicket, '在，我在。')
    expect(store.listReplies()).toHaveLength(1)
    expect(store.listOutbox('pending')).toHaveLength(1)
    store.close()
  })

  it('sends a direct chat answer as a few short bubbles', () => {
    const store = tempStore()
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: () => undefined,
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const imessageTicket = ticket({
      threadKeys: ['imessage:chat:any;-;+1'],
      channels: [{
        source: 'imessage',
        thread: 'chat:any;-;+1',
        address: { handle: '+1', chatGuid: 'any;-;+1' },
      }],
    })
    new Replies(host).answer(imessageTicket, '第一段。\n\n第二段，稍微长一点。\n\n第三段。\n\n第四段。')
    const queued = store.listOutbox('pending')
    expect(queued).toHaveLength(3)
    expect(queued[2]!.text).toContain('第三段')
    expect(queued[2]!.text).toContain('第四段')
    store.close()
  })

  it('keeps a group chat answer in one bubble', () => {
    const store = tempStore()
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: () => undefined,
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const groupTicket = ticket({
      threadKeys: ['imessage:group:g1'],
      channels: [{
        source: 'imessage',
        thread: 'group:g1',
        address: { provider: 'imessage', group: 'g1' },
      }],
    })
    new Replies(host).answer(groupTicket, '第一段。\n\n第二段。')
    expect(store.listOutbox('pending')).toHaveLength(1)
    store.close()
  })

  it('splits only on boundaries and never drops text', () => {
    const parts = splitChatText('一二三四五六七八九十。'.repeat(40) + '\n\n尾巴。')
    expect(parts.length).toBe(3)
    expect(parts.join('')).toContain('尾巴。')
    expect(splitChatText('一句话。')).toEqual(['一句话。'])
  })

  it('keeps the spaces between English sentences when it splits', () => {
    const parts = splitChatText('Hello there. '.repeat(40))
    expect(parts.length).toBe(2)
    expect(parts.some(part => /\.\s+Hello/.test(part))).toBe(true)
    expect(parts.every(part => !/\.Hello/.test(part))).toBe(true)
  })

  it('resumes Feishu text chunks from durable progress after a later chunk fails', async () => {
    const store = tempStore()
    const text = '界🙂'.repeat(30_000)
    const target = { provider: 'feishu', chat_id: 'oc_chat', message_id: 'om_source' }
    store.enqueueOutbox(row({ channel: 'im', thread: 'feishu:oc_chat', target, text }))

    const requests: { url: string; body: string }[] = []
    let sendRequests = 0
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.includes('tenant_access_token')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }))
      }
      const body = JSON.parse(String(init?.body)) as { uuid: string }
      const sending = store.listOutbox()[0]!
      const metadata = JSON.parse(sending.target.__ds_feishu_text_progress!) as { sendUuids: Record<string, string> }
      expect(Object.values(metadata.sendUuids)).toContain(body.uuid)
      expect(body.uuid).toBeTruthy()
      expect(body.uuid.length).toBeLessThanOrEqual(50)
      requests.push({ url: input, body: String(init?.body) })
      sendRequests += 1
      if (sendRequests === 2) {
        return new Response(JSON.stringify({ code: 999, msg: 'rate limited' }), { status: 429 })
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: `om_chunk_${sendRequests}` } }))
    }
    const adapter = new FeishuOutboxAdapter(new FeishuClient({
      appId: 'app', appSecret: 'secret', baseUrl: 'https://open.feishu.cn', chatId: 'oc_chat',
    }, fetchImpl))
    const outbox = new Outbox(store, [adapter])

    const firstAttempt = await outbox.flush()
    expect(firstAttempt).toMatchObject({ sent: 0, failed: 0, pending: 1 })
    expect(requests).toHaveLength(2)
    expect(requests.every(request => request.url === 'https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply')).toBe(true)
    const requestTexts = requests.map(request => {
      const body = JSON.parse(request.body) as { msg_type: string; content: string }
      expect(body.msg_type).toBe('text')
      return (JSON.parse(body.content) as { text: string }).text
    })
    expect(requestTexts[0]).toMatch(/^（1\/(\d+)）\n/)
    expect(requestTexts[1]).toMatch(/^（续 2\/\d+）\n/)

    const stored = store.listOutbox()[0]!
    expect(stored.status).toBe('pending')
    expect(stored.externalId).toBe('om_chunk_1')
    expect(stored.target.__ds_feishu_text_progress).toBeTruthy()
    store.markOutboxRetry(stored.id, 'rate limited', new Date(Date.now() - 1_000).toISOString(), stored.attempts ?? 1)

    const retryStart = requests.length
    const retry = await outbox.flush()
    expect(retry).toEqual({ sent: 1, failed: 0, pending: 0 })
    const retryRequests = requests.slice(retryStart)
    expect(retryRequests.length).toBeGreaterThan(0)
    expect(retryRequests.every(request => request.url === 'https://open.feishu.cn/open-apis/im/v1/messages/om_source/reply')).toBe(true)
    const retryTexts = retryRequests.map(request => {
      const body = JSON.parse(request.body) as { msg_type: string; content: string }
      expect(body.msg_type).toBe('text')
      return (JSON.parse(body.content) as { text: string }).text
    })
    const acceptedTexts = [requestTexts[0]!, ...retryTexts]
    const total = requestTexts[0]!.match(/^（1\/(\d+)）/)?.[1]
    expect(total).toBeTruthy()
    expect(retryTexts).toHaveLength(Number(total) - 1)
    expect(retryTexts[0]).toBe(requestTexts[1])
    const uuidOf = (request: { body: string }): string => String((JSON.parse(request.body) as { uuid: string }).uuid)
    expect(uuidOf(retryRequests[0]!)).toBe(uuidOf(requests[1]!))
    expect(uuidOf(requests[0]!)).not.toBe(uuidOf(requests[1]!))
    expect(acceptedTexts.slice(1).every(chunk => /^（续 \d+\/\d+）\n/.test(chunk))).toBe(true)
    expect(acceptedTexts.every(chunk => chunk.includes(`/${total}）`))).toBe(true)
    expect(acceptedTexts.map(chunk => chunk.replace(/^（(?:续 )?\d+\/\d+）\n/, '')).join('')).toBe(text)
    expect(store.listOutbox()[0]?.externalId).toBe('om_chunk_1')
    store.close()
  })

  it('flushes through the matching adapter and records the provider id', async () => {
    const store = tempStore()
    store.addReply({
      id: 'reply_1',
      ticketId: 'ticket_1',
      channel: 'github',
      purpose: 'acknowledgement',
      text: 'lofibot note',
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    store.enqueueOutbox(row())

    const sent: OutboxRow[] = []
    const adapter: OutboundAdapter = {
      channel: 'github',
      send: async outboxRow => {
        sent.push(outboxRow)
        return { externalId: '4242' }
      },
    }
    const outbox = new Outbox(store, [adapter])
    const result = await outbox.flush()
    expect(result).toEqual({ sent: 1, failed: 0, pending: 0 })
    expect(sent.map(item => item.id)).toEqual(['outbox_1'])
    const after = store.listOutbox()[0]!
    expect(after.status).toBe('sent')
    expect(after.externalId).toBe('4242')
    expect(after.sentAt).toBeTruthy()
    expect(store.listReplies()[0]!.status).toBe('sent')
    store.close()
  })

  it('marks an unconfigured channel failed and a CLI row local-sent', async () => {
    const store = tempStore()
    store.enqueueOutbox(row({ id: 'outbox_gh', replyId: 'reply_gh', channel: 'github' }))
    store.enqueueOutbox(row({ id: 'outbox_cli', replyId: 'reply_cli', channel: 'cli', target: {} }))
    const outbox = new Outbox(store, [])
    const result = await outbox.flush()
    expect(result.failed).toBe(1)
    expect(result.sent).toBe(1)
    const rows = store.listOutbox()
    expect(rows.find(item => item.id === 'outbox_gh')!.status).toBe('failed')
    expect(rows.find(item => item.id === 'outbox_gh')!.error).toMatch(/no outbound adapter/)
    expect(rows.find(item => item.id === 'outbox_cli')!.status).toBe('sent')
    store.close()
  })

  it('fails an unroutable row on the first flush without scheduling a retry', async () => {
    const store = tempStore()
    store.addReply({
      id: 'reply_1',
      ticketId: 'ticket_1',
      channel: 'github',
      purpose: 'acknowledgement',
      text: 'lofibot note',
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    store.enqueueOutbox(row())

    let calls = 0
    const adapter: OutboundAdapter = {
      channel: 'github',
      send: async () => {
        calls += 1
        throw new PermanentDeliveryError('targets group without a chatGuid')
      },
    }
    const outbox = new Outbox(store, [adapter])
    const result = await outbox.flush()
    expect(result).toEqual({ sent: 0, failed: 1, pending: 0 })
    expect(calls).toBe(1)

    const after = store.listOutbox()[0]!
    expect(after.status).toBe('failed')
    expect(after.error).toBe('targets group without a chatGuid')
    // A permanent failure is terminal on the first attempt: no retry counter,
    // no backoff deadline, and the reply is not marked sent.
    expect(after.attempts ?? 0).toBe(0)
    expect(after.nextAttemptAt).toBeUndefined()
    expect(store.listReplies()[0]!.status).toBe('pending')

    await outbox.flush()
    expect(calls).toBe(1)
    expect(store.listOutbox()[0]!.status).toBe('failed')
    store.close()
  })

  it('retries a transient send failure with backoff instead of failing early', async () => {
    const store = tempStore()
    store.enqueueOutbox(row())

    let calls = 0
    const adapter: OutboundAdapter = {
      channel: 'github',
      send: async () => {
        calls += 1
        throw new Error('network down')
      },
    }
    const outbox = new Outbox(store, [adapter])
    const result = await outbox.flush()
    expect(result).toEqual({ sent: 0, failed: 0, pending: 1 })
    expect(calls).toBe(1)

    const after = store.listOutbox()[0]!
    expect(after.status).toBe('pending')
    expect(after.error).toBe('network down')
    expect(after.attempts).toBe(1)
    expect(after.nextAttemptAt).toBeTruthy()
    expect(new Date(after.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now())

    // The row is not due until the backoff elapses, and it is not failed.
    await outbox.flush()
    expect(calls).toBe(1)
    expect(store.listOutbox()[0]!.status).toBe('pending')
    store.close()
  })

  it('closes the started send op when a retry is scheduled', async () => {
    const store = tempStore()
    store.enqueueOutbox(row())
    // Seed an open ticket so a stray unknown_outcome op would queue an approval.
    store.putDoc('ticket', 'ticket_1', ticket())

    const adapter: OutboundAdapter = {
      channel: 'github',
      send: async () => {
        throw new Error('network down')
      },
    }
    const outbox = new Outbox(store, [adapter])
    const result = await outbox.flush()
    expect(result).toEqual({ sent: 0, failed: 0, pending: 1 })

    const after = store.listOutbox()[0]!
    expect(after.status).toBe('pending')
    expect(after.attempts).toBe(1)
    expect(after.nextAttemptAt).toBeTruthy()

    // The throw is a known failed attempt, not an interrupted in-flight send.
    const op = store.getDoc<ExternalOperationRecord>(EXTERNAL_OP_KIND, 'outbox_outbox_1')
    expect(op?.phase).toBe('failed')

    const now = new Date().toISOString()
    const finalized = finalizeUncertainExternalEffects(store, now)
    expect(finalized.unknownOps).toBe(0)
    expect(store.getDoc<ExternalOperationRecord>(EXTERNAL_OP_KIND, 'outbox_outbox_1')?.phase).toBe('failed')
    const saved = store.getDoc<Ticket>('ticket', 'ticket_1')!
    const unknownApprovals = (saved.collab?.approvals ?? []).filter(
      item => item.status === 'pending' && item.action.startsWith(UNKNOWN_OUTCOME_PREFIX),
    )
    expect(unknownApprovals).toHaveLength(0)
    store.close()
  })

  it('completes the send operation on a later successful retry', async () => {
    const store = tempStore()
    store.enqueueOutbox(row())

    let calls = 0
    const adapter: OutboundAdapter = {
      channel: 'github',
      send: async () => {
        calls += 1
        if (calls === 1) throw new Error('network down')
        return { externalId: '4242' }
      },
    }
    const outbox = new Outbox(store, [adapter])
    await outbox.flush()
    expect(calls).toBe(1)
    expect(store.getDoc<ExternalOperationRecord>(EXTERNAL_OP_KIND, 'outbox_outbox_1')?.phase).toBe('failed')

    // Make the row due again without waiting for the real backoff.
    store.markOutboxRetry('outbox_1', 'network down', new Date(Date.now() - 1_000).toISOString(), 1)
    const result = await outbox.flush()
    expect(result).toEqual({ sent: 1, failed: 0, pending: 0 })
    expect(calls).toBe(2)

    const after = store.listOutbox()[0]!
    expect(after.status).toBe('sent')
    expect(after.externalId).toBe('4242')
    expect(store.getDoc<ExternalOperationRecord>(EXTERNAL_OP_KIND, 'outbox_outbox_1')?.phase).toBe('completed')
    store.close()
  })

  it('serializes overlapping flushes so a row is sent once', async () => {
    const store = tempStore()
    store.enqueueOutbox(row())
    let calls = 0
    const adapter: OutboundAdapter = {
      channel: 'github',
      send: async () => {
        calls += 1
        await new Promise(resolve => setTimeout(resolve, 20))
        return { externalId: String(calls) }
      },
    }
    const outbox = new Outbox(store, [adapter])
    const [first, second] = await Promise.all([outbox.flush(), outbox.flush()])
    expect(calls).toBe(1)
    expect(first.sent + second.sent).toBe(1)
    store.close()
  })
})
