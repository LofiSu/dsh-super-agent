import type { ChannelRef, Thread, Ticket, Trigger } from '../shared/types.ts'
import type { Host } from './host.ts'

export const CONVERSATION_SCOPE = 'conversation-layer'

/** Persistent 1:1 conversation envelope: no Worker, not ended per utterance. */
export function isConversationTicket(ticket: Ticket): boolean {
  return ticket.conversation === true
    || ticket.channels.some(channel => channel.address?.conversation === '1')
}

/** Human 1:1 IM ingress (Feishu P2P, iMessage direct). Not CLI or other sources. */
export function isDirectConversationIngress(trigger: Trigger): boolean {
  if (!trigger.human || trigger.addressed !== 'direct') return false
  const ref = trigger.threads[0]
  if (!ref) return false
  if (ref.source === 'imessage') return !trigger.channel?.address?.group
  if (ref.source === 'im') return !trigger.channel?.address?.group
  return false
}

export function conversationEnvelopeId(thread: Thread): string | undefined {
  const fromMeta = thread.meta?.conversationTicketId
  return typeof fromMeta === 'string' && fromMeta.trim() ? fromMeta.trim() : undefined
}

/**
 * Drop ended subscribers and mark any leftover open work ticket context-only
 * so it cannot own the inbox on this direct thread.
 */
export function cleanupDirectThreadSubscriptions(host: Host, thread: Thread): void {
  const envelopeId = conversationEnvelopeId(thread)
  const live: string[] = []
  for (const ticketId of thread.subscriptions) {
    const ticket = host.repo.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) continue
    if (ticket.ended) {
      host.repo.addEvent('subscription.removed', {
        ticketId,
        threadKey: thread.key,
        reason: 'conversation-cleanup-ended',
      })
      host.log(`[conversation] unsubscribe ended ticketId=${ticketId} thread=${thread.key}`)
      continue
    }
    if (ticketId === envelopeId || isConversationTicket(ticket)) {
      live.push(ticketId)
      continue
    }
    const meta = thread.subscriptionMeta?.[ticketId]
    const contextOnly = meta?.contextOnly === true
      || thread.contextOnly?.includes(ticketId)
      || ticket.contextOnlyThreads?.includes(thread.key)
    if (!contextOnly) {
      thread.subscriptionMeta = {
        ...(thread.subscriptionMeta ?? {}),
        [ticketId]: { ...(meta ?? {}), contextOnly: true, at: host.now() },
      }
      thread.contextOnly = [...new Set([...(thread.contextOnly ?? []), ticketId])]
      ticket.contextOnlyThreads = [...new Set([...(ticket.contextOnlyThreads ?? []), thread.key])]
      host.repo.putDoc('ticket', ticketId, ticket)
      host.log(`[conversation] context-only work ticketId=${ticketId} thread=${thread.key}`)
    }
    live.push(ticketId)
  }
  thread.subscriptions = live
  host.repo.putDoc('thread', thread.key, thread)
}

export function ensureConversationEnvelope(
  host: Host,
  thread: Thread,
  trigger: Trigger,
): Ticket {
  cleanupDirectThreadSubscriptions(host, thread)
  const existingId = conversationEnvelopeId(thread)
  if (existingId) {
    const existing = host.repo.getDoc<Ticket>('ticket', existingId)
    if (existing && !existing.ended) {
      if (!thread.subscriptions.includes(existingId)) {
        thread.subscriptions.push(existingId)
        host.repo.putDoc('thread', thread.key, thread)
      }
      return existing
    }
  }
  const now = host.now()
  const id = host.repo.nextId('ticket')
  const channel = channelFromTrigger(trigger)
  const ticket: Ticket = {
    id,
    title: 'conversation',
    brief: '',
    conversation: true,
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-v1',
      scope: CONVERSATION_SCOPE,
      actor: trigger.actor,
      basis: 'conversation',
    },
    threadKeys: [thread.key],
    channels: [channel],
    inputs: [],
    assignments: [],
    speculative: false,
    originTriggerId: trigger.id,
    createdAt: now,
  }
  host.repo.putDoc('ticket', id, ticket)
  thread.meta = { ...thread.meta, conversationTicketId: id }
  if (!thread.subscriptions.includes(id)) thread.subscriptions.push(id)
  thread.subscriptionMeta = {
    ...(thread.subscriptionMeta ?? {}),
    [id]: { at: now },
  }
  host.repo.putDoc('thread', thread.key, thread)
  host.repo.addSubscription(thread.key, id, now)
  host.repo.addEvent('thread.subscribed', { threadKey: thread.key, ticketId: id })
  host.log(`[conversation] envelope ticketId=${id} thread=${thread.key}`)
  return ticket
}

export function attachInboundToEnvelope(
  host: Host,
  envelope: Ticket,
  trigger: Trigger,
): void {
  const at = host.now()
  envelope.inputs.push({
    id: host.repo.nextId('input'),
    kind: 'trigger',
    triggerId: trigger.id,
    text: trigger.text,
    spillId: typeof trigger.meta.spillId === 'string' ? trigger.meta.spillId : undefined,
    at,
    human: trigger.human,
  })
  envelope.brief = trigger.text
  host.repo.putDoc('ticket', envelope.id, envelope)
}

function channelFromTrigger(trigger: Trigger): ChannelRef {
  if (trigger.channel) {
    return {
      ...trigger.channel,
      address: { ...(trigger.channel.address ?? {}), conversation: '1' },
    }
  }
  const ref = trigger.threads[0]!
  return { source: ref.source, thread: ref.id, address: { conversation: '1' } }
}

/** Whether startup cleanup should demote stale subscriptions on this thread. */
export function isDirectConversationThread(thread: Thread, repo: Host['repo']): boolean {
  if (typeof thread.meta?.conversationTicketId === 'string') return true
  const ref = thread.ref
  if (ref.source === 'imessage' && !String(ref.id).startsWith('group')) return true
  if (ref.source !== 'im') return false
  if (thread.subscriptions.some(id => {
    const ticket = repo.getDoc<Ticket>('ticket', id)
    return ticket && isConversationTicket(ticket)
  })) return true
  for (const ticketId of thread.subscriptions) {
    const ticket = repo.getDoc<Ticket>('ticket', ticketId)
    if (!ticket) continue
    for (const channel of ticket.channels) {
      if (channel.source !== 'im') continue
      if (channel.address?.group) return false
      if (channel.address?.provider === 'feishu' || channel.address?.chat_id) return true
    }
  }
  return false
}
