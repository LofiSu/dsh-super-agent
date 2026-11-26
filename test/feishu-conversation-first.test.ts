import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockModel, type Model } from '../src/harness/model.ts'
import {
  cleanupDirectThreadSubscriptions,
  ensureConversationEnvelope,
  isConversationTicket,
} from '../src/core/conversation.ts'
import { bypassEligible } from '../src/core/intake.ts'
import { isDirectConversationIngress } from '../src/core/conversation.ts'
import { feishuTriggerFromMessage, type FeishuConfig, type FeishuMessage } from '../src/channels/feishu.ts'
import { coalesceTriggers } from '../src/cli/channel-loop.ts'
import { filterTriggerWithPolicy } from '../src/ingress/policy.ts'
import { ruleClassify } from '../src/ingress/filter.ts'
import type { Host } from '../src/core/host.ts'
import { conversationPromptFor } from '../src/harness/loop.ts'
import { directChatThread } from '../src/harness/session.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Disposition, Thread, Ticket, Trigger } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { field, lastPrompt, ScriptedModel } from './scripted-model.ts'
import { Store } from '../src/store/sqlite.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
})

function feishuDirectTrigger(id: string, text: string, messageId = 'om_x'): Trigger {
  return {
    id,
    source: 'im',
    threads: [{ source: 'im', id: 'feishu:oc_p2p' }],
    actor: { source: 'im', id: 'ou_user' },
    human: true,
    addressed: 'direct',
    at: new Date().toISOString(),
    text,
    channel: {
      source: 'im',
      thread: 'feishu:oc_p2p',
      address: { provider: 'feishu', chat_id: 'oc_p2p', message_id: messageId },
    },
    meta: {},
  }
}

const feishuConfig: FeishuConfig = {
  appId: 'cli_app',
  appSecret: 'secret',
  baseUrl: 'https://open.feishu.cn',
  chatId: 'oc_p2p',
  botOpenId: 'ou_bot',
}

function mappedFeishuMention(id: string, chatType: 'p2p' | 'group' = 'p2p'): Trigger {
  const message: FeishuMessage = {
    message_id: id,
    chat_id: chatType === 'p2p' ? 'oc_p2p' : 'oc_group',
    chat_type: chatType,
    msg_type: 'text',
    body: { content: JSON.stringify({ text: '@ds-agent haha' }) },
    create_time: '1795737600000',
    sender: { id: 'ou_user', sender_type: 'user' },
    mentions: [{ id: { open_id: 'ou_bot' }, name: 'ds-agent' }],
  }
  return feishuTriggerFromMessage(message, feishuConfig)
}

function makeRuntime(model?: Model, env: NodeJS.ProcessEnv = {}): Runtime {
  const runtime = freshRuntime({
    model: model ?? new MockModel(),
    allowMockModel: true,
    env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1', DS_AGENT_ACTOR_ALLOWLIST: 'ou_user', ...env },
    batchWindowMs: 60_000,
    jobDelayMs: 0,
  })
  runtime.start({ assessPending: false })
  runtimes.push(runtime)
  return runtime
}

describe('Feishu conversation-first 1:1', () => {
  it('keeps verified p2p bot mentions on the conversation path', async () => {
    const previous = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
    try {
      const first = mappedFeishuMention('om_mention_1')
      const second = mappedFeishuMention('om_mention_2')
      expect(first.addressed).toBe('mention')
      expect(first.channel?.address?.group).toBeUndefined()
      expect(first.channel?.address?.chat_type).toBe('p2p')
      expect(isDirectConversationIngress(first)).toBe(true)
      expect(isDirectConversationIngress({ ...first, human: false })).toBe(false)
      await expect(filterTriggerWithPolicy(first, { name: 'rules', classify: ruleClassify }))
        .resolves.toMatchObject({ action: 'pass', layer: 'fast', semantic: 'skip:direct' })
      expect(ruleClassify(first)).toMatchObject({ pass: true })
      expect(bypassEligible({
        id: 'ticket_leftover',
        title: 'leftover',
        brief: '',
        mandate: {
          strength: 'explicit',
          policyVersion: 'policy-v1',
          scope: 'work',
          actor: { source: 'im', id: 'ou_user' },
          basis: 'addressed',
        },
        threadKeys: ['im:feishu:oc_p2p'],
        channels: [{ source: 'im', thread: 'feishu:oc_p2p' }],
        inputs: [],
        assignments: [],
        speculative: false,
        originTriggerId: 'old',
        createdAt: new Date().toISOString(),
      }, first)).toBe(false)
      expect(coalesceTriggers([first, second])).toHaveLength(1)

      const runtime = makeRuntime()
      const threadKey = 'im:feishu:oc_p2p'
      const thread: Thread = {
        key: threadKey,
        ref: { source: 'im', id: 'feishu:oc_p2p' },
        createdAt: new Date().toISOString(),
        subscriptions: ['ticket_leftover'],
        correlated: [],
        pending: [],
        meta: {},
      }
      const leftover: Ticket = {
        id: 'ticket_leftover',
        title: 'leftover',
        brief: '',
        mandate: {
          strength: 'explicit',
          policyVersion: 'policy-v1',
          scope: 'work',
          actor: { source: 'im', id: 'ou_user' },
          basis: 'addressed',
        },
        threadKeys: [threadKey],
        channels: [{ source: 'im', thread: 'feishu:oc_p2p' }],
        inputs: [],
        assignments: [{ id: 'asg_leftover', state: 'running', speculative: false }],
        speculative: false,
        originTriggerId: 'old',
        createdAt: new Date().toISOString(),
      }
      runtime.store.putDoc('thread', threadKey, thread)
      runtime.store.putDoc('ticket', leftover.id, leftover)
      expect(runtime.ingest(first)).toBe('stored')
      expect(runtime.ingest(second)).toBe('stored')

      const tickets = runtime.store.listDocs<Ticket>('ticket')
      expect(tickets.filter(isConversationTicket)).toHaveLength(1)
      expect(tickets.filter(ticket => !isConversationTicket(ticket))).toHaveLength(1)
      const updatedThread = runtime.store.getDoc<Thread>('thread', threadKey)
      expect(updatedThread?.contextOnly).toContain('ticket_leftover')
      expect(runtime.store.getDoc<Disposition>('disposition', first.id)?.fanout).toEqual([])
      expect(runtime.store.getDoc<Disposition>('disposition', second.id)?.fanout).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      else process.env.DS_AGENT_FEISHU_P2P_DIRECT = previous
    }
  })

  it('keeps group mentions outside the conversation path and noise exemption', async () => {
    const previous = process.env.DS_AGENT_FEISHU_P2P_DIRECT
    process.env.DS_AGENT_FEISHU_P2P_DIRECT = '1'
    try {
      const groupMention = mappedFeishuMention('om_group_mention', 'group')
      expect(groupMention.addressed).toBe('mention')
      expect(groupMention.channel?.address?.group).toBe('oc_group')
      expect(isDirectConversationIngress(groupMention)).toBe(false)
      await expect(filterTriggerWithPolicy(groupMention, { name: 'rules', classify: ruleClassify }))
        .resolves.toMatchObject({ action: 'drop', layer: 'semantic', reason: 'noise' })
    } finally {
      if (previous === undefined) delete process.env.DS_AGENT_FEISHU_P2P_DIRECT
      else process.env.DS_AGENT_FEISHU_P2P_DIRECT = previous
    }
  })

  it('casual 在吗 uses one conversation envelope and does not open a work ticket per message', () => {
    const runtime = makeRuntime()
    expect(runtime.ingest(feishuDirectTrigger('trg_1', '在吗'))).toBe('stored')
    expect(runtime.ingest(feishuDirectTrigger('trg_2', '还在吗'))).toBe('stored')

    const tickets = runtime.store.listDocs<Ticket>('ticket')
    const envelopes = tickets.filter(t => isConversationTicket(t))
    const work = tickets.filter(t => !isConversationTicket(t) && t.assignments.length > 0)
    expect(envelopes).toHaveLength(1)
    expect(work).toHaveLength(0)

    const thread = runtime.store.getDoc<Thread>('thread', 'im:feishu:oc_p2p')
    expect(thread?.pending ?? []).toEqual([])
    expect(thread?.meta?.conversationTicketId).toBe(envelopes[0]!.id)

    expect(runtime.store.listOutbox('pending')).toHaveLength(0)
    expect(runtime.log.text()).not.toMatch(/Acknowledged.*Working on it/)
    expect(runtime.store.listDocs<Disposition>('disposition').every(d => (d.fanout ?? []).length <= 1)).toBe(true)
  })

  it('never actionable-fanouts one inbound message to multiple tickets', () => {
    const runtime = makeRuntime()
    const store = runtime.store
    const threadKey = 'im:feishu:oc_p2p'
    const thread: Thread = {
      key: threadKey,
      ref: { source: 'im', id: 'feishu:oc_p2p' },
      createdAt: new Date().toISOString(),
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: {},
    }
    store.putDoc('thread', threadKey, thread)

    for (let i = 1; i <= 3; i++) {
      const workId = `ticket_${i}`
      const work: Ticket = {
        id: workId,
        title: `work ${i}`,
        brief: 'brief',
        mandate: {
          strength: 'explicit',
          policyVersion: 'policy-v1',
          scope: 'scope',
          actor: { source: 'im', id: 'ou_user' },
          basis: 'addressed',
        },
        threadKeys: [threadKey],
        channels: [{ source: 'im', thread: 'feishu:oc_p2p' }],
        inputs: [],
        assignments: [{ id: `asg_${i}`, state: 'running', speculative: false }],
        speculative: false,
        originTriggerId: `trg_old_${i}`,
        createdAt: new Date().toISOString(),
      }
      store.putDoc('ticket', workId, work)
      thread.subscriptions.push(workId)
    }
    store.putDoc('thread', threadKey, thread)

    runtime.ingest(feishuDirectTrigger('trg_new', '在吗'))
    const disposition = store.getDoc<Disposition>('disposition', 'trg_new')
    expect(disposition?.fanout ?? []).toEqual([])
    expect((disposition?.fanout ?? []).length).toBeLessThanOrEqual(1)

    const open = store.listDocs<Ticket>('ticket').filter(t => !t.ended && t.assignments.some(a => a.state === 'running'))
    for (const t of open) {
      expect(t.contextOnlyThreads).toContain(threadKey)
    }
  })

  it('cleans ended subscriptions and demotes open work to context-only on the direct thread', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-cleanup-'))
    const store = new Store(dir)
    const lines: string[] = []
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: line => { lines.push(line) },
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const threadKey = 'im:feishu:oc_p2p'
    const thread: Thread = {
      key: threadKey,
      ref: { source: 'im', id: 'feishu:oc_p2p' },
      createdAt: new Date().toISOString(),
      subscriptions: ['ticket_ended', 'ticket_open'],
      correlated: [],
      pending: [],
      meta: {},
    }
    store.putDoc('thread', threadKey, thread)
    store.putDoc('ticket', 'ticket_ended', {
      id: 'ticket_ended',
      title: 'old',
      brief: '',
      mandate: {
        strength: 'explicit',
        policyVersion: 'policy-v1',
        scope: 'x',
        actor: { source: 'im', id: 'ou' },
        basis: 'addressed',
      },
      threadKeys: [threadKey],
      channels: [],
      inputs: [],
      assignments: [{ id: 'asg_e', state: 'ended', speculative: false }],
      speculative: false,
      originTriggerId: 'trg_e',
      createdAt: new Date().toISOString(),
      ended: { at: new Date().toISOString(), outcome: 'stopped', by: 'router' },
    })
    store.putDoc('ticket', 'ticket_open', {
      id: 'ticket_open',
      title: 'open',
      brief: '',
      mandate: {
        strength: 'explicit',
        policyVersion: 'policy-v1',
        scope: 'open work',
        actor: { source: 'im', id: 'ou' },
        basis: 'addressed',
      },
      threadKeys: [threadKey],
      channels: [{ source: 'im', thread: 'feishu:oc_p2p' }],
      inputs: [],
      assignments: [{ id: 'asg_o', state: 'running', speculative: false }],
      speculative: false,
      originTriggerId: 'trg_o',
      createdAt: new Date().toISOString(),
    })

    cleanupDirectThreadSubscriptions(host, thread)
    const updated = store.getDoc<Thread>('thread', threadKey)
    expect(updated?.subscriptions).not.toContain('ticket_ended')
    expect(updated?.subscriptions).toContain('ticket_open')
    expect(updated?.contextOnly).toContain('ticket_open')
    expect(bypassEligible(store.getDoc<Ticket>('ticket', 'ticket_open')!, feishuDirectTrigger('t', 'hi'), { contextOnly: true })).toBe(false)
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('conversation prompt is not TICKET_CREATED and allows reply-first', () => {
    const envelope: Ticket = {
      id: 'ticket_conv',
      title: 'conversation',
      brief: '在吗',
      conversation: true,
      mandate: {
        strength: 'explicit',
        policyVersion: 'policy-v1',
        scope: 'conversation-layer',
        actor: { source: 'im', id: 'ou' },
        basis: 'conversation',
      },
      threadKeys: ['im:feishu:oc_p2p'],
      channels: [{ source: 'im', thread: 'feishu:oc_p2p', address: { provider: 'feishu', chat_id: 'oc_p2p' } }],
      inputs: [],
      assignments: [],
      speculative: false,
      originTriggerId: 'trg_1',
      createdAt: new Date().toISOString(),
    }
    const prompt = conversationPromptFor(envelope, feishuDirectTrigger('trg_1', '在吗'))
    expect(prompt).toContain('CONVERSATION_INBOUND')
    expect(prompt).not.toContain('TICKET_CREATED')
    expect(prompt).toContain('message=在吗')
    expect(prompt).toContain('direct-chat=true')
    expect(directChatThread(envelope)).toBe('feishu:oc_p2p')
  })

  it('ingest does not await a hanging jobsSettled during direct poll (smoke)', async () => {
    const runtime = makeRuntime()
    runtime.jobsSettled = () => new Promise(() => undefined)
    const hung = runtime.ingest(feishuDirectTrigger('trg_hang', '你好'))
    await expect(Promise.race([hung, Promise.resolve('fast')])).resolves.toBe('stored')
  })

  it('work path: Router reply then dispatch_work opens a worker ticket (conversation envelope kept)', async () => {
    const model = new ScriptedModel(request => {
      const prompt = lastPrompt(request)
      if (request.role !== 'router' || !prompt.startsWith('CONVERSATION_INBOUND')) {
        return { text: 'noop' }
      }
      const replied = request.messages.some(m => m.role === 'tool' && m.name === 'reply_user')
      if (!replied) {
        return {
          toolCalls: [{
            id: 'r1',
            name: 'reply_user',
            args: {
              ticketId: field(prompt, 'conversationTicketId'),
              text: '好的，我先查一下代码。',
              purpose: 'progress',
              thread: 'im:feishu:oc_p2p',
            },
          }],
        }
      }
      const dispatched = request.messages.some(m => m.role === 'tool' && m.name === 'dispatch_work')
      if (!dispatched) {
        return {
          toolCalls: [{
            id: 'd1',
            name: 'dispatch_work',
            args: {
              triggerId: field(prompt, 'triggerId'),
              conversationTicketId: field(prompt, 'conversationTicketId'),
              title: '查登录超时',
              scope: '调查登录超时问题',
              thread: 'im:feishu:oc_p2p',
            },
          }],
        }
      }
      return { text: 'done' }
    })
    const runtime = makeRuntime(model)
    runtime.ingest(feishuDirectTrigger('trg_work', '帮我查下登录超时'))
    await vi.waitFor(() => {
      const work = runtime.store.listDocs<Ticket>('ticket').filter(t => !isConversationTicket(t))
      expect(work.length).toBeGreaterThanOrEqual(1)
    }, { timeout: 15_000 })

    const envelopes = runtime.store.listDocs<Ticket>('ticket').filter(isConversationTicket)
    expect(envelopes).toHaveLength(1)
    expect(runtime.store.listReplies().some(r => r.text.includes('查'))).toBe(true)
    const work = runtime.store.listDocs<Ticket>('ticket').find(t => !isConversationTicket(t))!
    expect(work.assignments.some(a => a.state === 'pending' || a.state === 'running')).toBe(true)
  })
})

describe('conversation envelope unit', () => {
  it('ensureConversationEnvelope is idempotent per thread', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-env-'))
    const store = new Store(dir)
    const host: Host = {
      repo: store,
      now: () => new Date().toISOString(),
      log: () => undefined,
      metrics: { increment: () => undefined } as unknown as Host['metrics'],
      scope: { admit: () => ({ listened: true, reason: 'test' }) },
    }
    const threadKey = 'im:feishu:oc_p2p'
    const thread: Thread = {
      key: threadKey,
      ref: { source: 'im', id: 'feishu:oc_p2p' },
      createdAt: new Date().toISOString(),
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: {},
    }
    store.putDoc('thread', threadKey, thread)
    const t1 = feishuDirectTrigger('a', 'hi')
    const e1 = ensureConversationEnvelope(host, thread, t1)
    const e2 = ensureConversationEnvelope(host, store.getDoc<Thread>('thread', threadKey)!, feishuDirectTrigger('b', 'again'))
    expect(e1.id).toBe(e2.id)
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
