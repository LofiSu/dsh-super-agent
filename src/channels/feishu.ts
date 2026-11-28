import crypto from 'node:crypto'
import type { OutboxRow, Trigger } from '../shared/types.ts'
import type { OutboxProgress, OutboundAdapter } from './outbox-adapter.ts'
import { FEISHU_CARD_CONTENT_LIMIT_BYTES, hasFeishuMarkdownStructure, renderFeishuMarkdownCard } from './feishu-card.ts'

/** Feishu documents a 150 KB maximum for serialized text-message request bodies. */
export const FEISHU_TEXT_REQUEST_LIMIT_BYTES = 150 * 1024

// Reserve ample room for the send API's receive_id envelope without using a real
// chat id. This also safely covers the smaller reply API request body.
const FEISHU_RECEIVE_ID_RESERVE = 'x'.repeat(256)
const FEISHU_TEXT_PROGRESS_KEY = '__ds_feishu_text_progress'

function textRequestBodyBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify({
    receive_id: FEISHU_RECEIVE_ID_RESERVE,
    msg_type: 'text',
    content: JSON.stringify({ text }),
  }), 'utf8')
}

function textChunkMarker(index: number, total: number): string {
  return index === 1 ? `（${index}/${total}）\n` : `（续 ${index}/${total}）\n`
}

/** Split on Unicode code points while keeping each serialized send body under Feishu's cap. */
function splitFeishuText(text: string): string[] {
  const points = Array.from(text)
  let totalGuess = 2
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const chunks: string[] = []
    let offset = 0
    while (offset < points.length) {
      const marker = textChunkMarker(chunks.length + 1, totalGuess)
      let low = 1
      let high = points.length - offset
      let best = 0
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const candidate = marker + points.slice(offset, offset + middle).join('')
        if (textRequestBodyBytes(candidate) <= FEISHU_TEXT_REQUEST_LIMIT_BYTES) {
          best = middle
          low = middle + 1
        } else {
          high = middle - 1
        }
      }
      if (best === 0) throw new Error('Feishu text chunk marker exceeds the request body limit')
      chunks.push(marker + points.slice(offset, offset + best).join(''))
      offset += best
    }
    if (chunks.length === totalGuess) return chunks
    totalGuess = chunks.length
  }
  throw new Error('Could not determine Feishu text chunk count')
}

/**
 * Production Feishu/Lark IM channel.
 *
 * Inbound: event-webhook parser (`im.message.receive_v1`, plaintext or
 * AES-256-CBC encrypted) plus a polling Source over the message-list API.
 * Outbound: real message API (`/im/v1/messages` or `/im/v1/messages/:id/reply`).
 *
 * Required env for a live run:
 *   FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_CHAT_ID
 * Optional:
 *   FEISHU_BASE_URL (default https://open.feishu.cn; use https://open.larksuite.com)
 *   FEISHU_VERIFICATION_TOKEN, FEISHU_ENCRYPT_KEY, FEISHU_BOT_OPEN_ID
 *
 * Bot permissions: im:message, im:message.send_as_bot, im:message:readonly (or
 * the corresponding granular scopes), plus im:message.group_msg for group
 * history. Polling chat classification (connector wake, and
 * DS_AGENT_FEISHU_P2P_DIRECT when enabled) needs im:chat:readonly (or
 * im:chat:read / im:chat); the direct path verifies chat_mode. The bot must be
 * a member of the chat.
 */

export interface FeishuConfig {
  appId: string
  appSecret: string
  baseUrl: string
  chatId?: string
  verificationToken?: string
  encryptKey?: string
  botOpenId?: string
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

/** `null` when Feishu is not configured; throws on a half-set app credential. */
export function feishuConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FeishuConfig | null {
  const appId = read(env, 'FEISHU_APP_ID')
  const appSecret = read(env, 'FEISHU_APP_SECRET')
  if (!appId && !appSecret) return null
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set together; refusing a half-configured Feishu channel.')
  }
  return {
    appId,
    appSecret,
    baseUrl: (read(env, 'FEISHU_BASE_URL') ?? 'https://open.feishu.cn').replace(/\/$/, ''),
    chatId: read(env, 'FEISHU_CHAT_ID'),
    verificationToken: read(env, 'FEISHU_VERIFICATION_TOKEN'),
    encryptKey: read(env, 'FEISHU_ENCRYPT_KEY'),
    botOpenId: read(env, 'FEISHU_BOT_OPEN_ID'),
  }
}

export interface FeishuSender {
  id?: string
  id_type?: string
  sender_type?: string
  tenant_key?: string
}

export interface FeishuMention {
  key?: string
  name?: string
  id?: { open_id?: string; user_id?: string; union_id?: string }
}

/** Shape of one item from `/open-apis/im/v1/messages` (and the webhook event.message). */
export interface FeishuMessage {
  message_id: string
  chat_id: string
  chat_type?: 'p2p' | 'group' | string
  msg_type: string
  body?: { content?: string }
  content?: string
  create_time: string
  update_time?: string
  thread_id?: string
  root_id?: string
  parent_id?: string
  sender?: FeishuSender
  mentions?: FeishuMention[]
  deleted?: boolean
}

export interface FeishuListOptions {
  startTimeSec?: number
  endTimeSec?: number
  pageSize?: number
  maxPages?: number
  signal?: AbortSignal
  threadId?: string
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Bound every Open Platform call so a hung DNS/proxy cannot stall poll or outbox. */
export const FEISHU_FETCH_TIMEOUT_MS = 8_000

export const DEFAULT_FEISHU_MAX_MESSAGE_AGE_MS = 60 * 60_000

export function feishuMaxMessageAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.FEISHU_MAX_MESSAGE_AGE_MS)
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_FEISHU_MAX_MESSAGE_AGE_MS
}

function isStaleFeishuMessage(message: FeishuMessage, nowMs: number, maxAgeMs: number): boolean {
  const createdAt = Number(message.create_time)
  return Number.isFinite(createdAt) && nowMs - createdAt > maxAgeMs
}

export class FeishuApiError extends Error {
  constructor(readonly code: number, message: string, readonly path: string, readonly status?: number) {
    super(`Feishu ${path} failed code=${code}: ${message}`)
    this.name = 'FeishuApiError'
  }
}

/** Minimal real Feishu Open Platform client with a cached tenant access token. */
export class FeishuClient {
  private token?: { value: string; expiresAt: number }

  constructor(
    private readonly config: FeishuConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs: number = FEISHU_FETCH_TIMEOUT_MS,
  ) {}

  private fetchInit(init: RequestInit = {}): RequestInit {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    return { ...init, signal }
  }

  async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value
    const response = await this.fetchImpl(`${this.config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, this.fetchInit({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      ...(signal ? { signal } : {}),
    }))
    const json = await response.json() as {
      code?: number
      msg?: string
      tenant_access_token?: string
      expire?: number
    }
    if (!response.ok || json.code !== 0 || !json.tenant_access_token) {
      throw new FeishuApiError(json.code ?? response.status, json.msg ?? 'no tenant_access_token', 'auth/v3/tenant_access_token', response.status)
    }
    const ttlMs = Math.max(60, Number(json.expire ?? 3600) - 60) * 1000
    this.token = { value: json.tenant_access_token, expiresAt: Date.now() + ttlMs }
    return this.token.value
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined>; signal?: AbortSignal } = {}): Promise<T> {
    const token = await this.accessToken(init.signal)
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) params.set(key, String(value))
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : ''
    const response = await this.fetchImpl(`${this.config.baseUrl}${path}${suffix}`, this.fetchInit({
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    }))
    const json = await response.json() as { code?: number; msg?: string; data?: T }
    if (!response.ok || json.code !== 0) {
      throw new FeishuApiError(json.code ?? response.status, json.msg ?? 'request failed', path, response.status)
    }
    return (json.data ?? {}) as T
  }

  /** All messages in a chat since `startTimeSec`, oldest first, page-limited. */
  async listMessages(chatId: string, options: FeishuListOptions = {}): Promise<FeishuMessage[]> {
    const items: FeishuMessage[] = []
    let pageToken: string | undefined
    const maxPages = Math.max(1, Math.min(20, Math.floor(options.maxPages ?? 20)))
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.request<{
        items?: FeishuMessage[]
        has_more?: boolean
        page_token?: string
      }>('/open-apis/im/v1/messages', {
        query: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: options.startTimeSec,
          end_time: options.endTimeSec,
          sort_type: 'ByCreateTimeAsc',
          page_size: options.pageSize ?? 50,
          page_token: pageToken,
        },
        ...(options.signal ? { signal: options.signal } : {}),
      })
      for (const item of data.items ?? []) items.push(item)
      if (!data.has_more || !data.page_token) break
      pageToken = data.page_token
    }
    return items.filter(item => !item.deleted)
  }

  async sendText(chatId: string, text: string, uuid: string = crypto.randomUUID()): Promise<{ message_id: string }> {
    return this.request<{ message_id: string }>('/open-apis/im/v1/messages', {
      method: 'POST',
      query: { receive_id_type: 'chat_id' },
      body: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid },
    })
  }

  async replyText(messageId: string, text: string, uuid: string = crypto.randomUUID()): Promise<{ message_id: string }> {
    return this.request<{ message_id: string }>(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      body: { msg_type: 'text', content: JSON.stringify({ text }), uuid },
    })
  }

  async sendInteractive(chatId: string, content: string, uuid: string = crypto.randomUUID()): Promise<{ message_id: string }> {
    return this.request<{ message_id: string }>('/open-apis/im/v1/messages', {
      method: 'POST',
      query: { receive_id_type: 'chat_id' },
      body: { receive_id: chatId, msg_type: 'interactive', content, uuid },
    })
  }

  async replyInteractive(messageId: string, content: string, uuid: string = crypto.randomUUID()): Promise<{ message_id: string }> {
    return this.request<{ message_id: string }>(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      body: { msg_type: 'interactive', content, uuid },
    })
  }

  async getMessage(messageId: string): Promise<FeishuMessage | undefined> {
    const data = await this.request<{ items?: FeishuMessage[] }>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
    )
    return data.items?.[0]
  }

  async getChatMode(chatId: string, signal?: AbortSignal): Promise<string | undefined> {
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let removeAbortListener: (() => void) | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Feishu chat metadata lookup timed out'))
      }, 5_000)
      if (signal) {
        const onAbort = (): void => {
          controller.abort()
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        }
        if (signal.aborted) onAbort()
        else {
          signal.addEventListener('abort', onAbort, { once: true })
          removeAbortListener = () => signal.removeEventListener('abort', onAbort)
        }
      }
    })
    try {
      const request = this.request<{ chat_mode?: unknown }>(
        `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
        { signal: combined },
      )
      const data = await Promise.race([request, deadline])
      return typeof data.chat_mode === 'string' && data.chat_mode.length > 0
        ? data.chat_mode
        : undefined
    } finally {
      if (timer) clearTimeout(timer)
      removeAbortListener?.()
    }
  }
}

/** Flatten the text-bearing parts of a Feishu message (`text`, `post`, cards). */
export function flattenFeishuMessage(message: FeishuMessage): string {
  const raw = message.body?.content ?? message.content ?? ''
  if (message.msg_type === 'text') {
    try {
      const parsed = JSON.parse(raw) as { text?: string }
      return parsed.text ?? raw
    } catch {
      return raw
    }
  }
  if (message.msg_type === 'post') {
    try {
      const parsed = JSON.parse(raw) as { title?: string; content?: unknown }
      const parts: string[] = []
      if (parsed.title) parts.push(parsed.title)
      collectPostText(parsed.content, parts)
      return parts.join('\n').trim()
    } catch {
      return raw
    }
  }
  if (message.msg_type === 'image') return '[image]'
  if (message.msg_type === 'file') return '[file]'
  if (message.msg_type === 'audio') return '[audio]'
  return raw
}

function collectPostText(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node)
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) collectPostText(item, out)
    return
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>
    if (typeof record.text === 'string') out.push(record.text)
    if (typeof record.content === 'string') out.push(record.content)
    for (const value of Object.values(record)) {
      if (value !== record.text && typeof value !== 'string') collectPostText(value, out)
    }
  }
}

export function feishuThread(chatId: string, threadId?: string): string {
  return threadId ? `feishu:${chatId}:${threadId}` : `feishu:${chatId}`
}

export function normalizeFeishuChatMode(mode: unknown): 'p2p' | 'group' | undefined {
  // Message `chat_type` is visibility metadata: `p2p`/`group`/`topic` are
  // discriminators, while `private`/`public` must stay unverified.
  if (mode === 'p2p') return 'p2p'
  if (mode === 'group' || mode === 'topic') return 'group'
  return undefined
}

/** Chat-information API `chat_mode` recognizes only its documented modes. */
export function normalizeFeishuChatModeForDirect(mode: unknown): 'p2p' | 'group' | undefined {
  if (mode === 'p2p') return 'p2p'
  if (mode === 'group' || mode === 'topic') return 'group'
  return undefined
}

function mentionsBot(message: FeishuMessage, config?: FeishuConfig): boolean {
  const text = flattenFeishuMessage(message)
  if (/@ds-agent\b/i.test(text)) return true
  const mentions = message.mentions ?? []
  return mentions.some(mention =>
    (config?.botOpenId != null && mention.id?.open_id === config.botOpenId)
    || /ds-agent/i.test(mention.name ?? ''))
}

export function feishuTriggerFromMessage(message: FeishuMessage, config?: FeishuConfig): Trigger {
  const text = flattenFeishuMessage(message)
  const thread = feishuThread(message.chat_id, message.thread_id)
  // The override applies only when Feishu identifies this message as a p2p chat.
  // Missing or unknown chat types retain group admission and noise filtering.
  const p2pDirect = message.chat_type === 'p2p'
    && process.env.DS_AGENT_FEISHU_P2P_DIRECT?.trim() === '1'
  const addressed = mentionsBot(message, config) ? 'mention' as const : (p2pDirect ? 'direct' as const : undefined)
  const senderType = message.sender?.sender_type
  const chatType = normalizeFeishuChatMode(message.chat_type)
  return {
    id: `feishu_${message.message_id}`,
    source: 'im',
    threads: [{ source: 'im', id: thread }],
    actor: { source: 'im', id: message.sender?.id ?? 'unknown' },
    human: senderType !== 'app' && senderType !== 'bot',
    addressed,
    at: new Date(Number(message.create_time)).toISOString(),
    text,
    channel: {
      source: 'im',
      thread,
      address: {
        provider: 'feishu',
        chat_id: message.chat_id,
        // Group admission reads only `address.group`; a Feishu chat is the group.
        // The p2p marker scopes the direct override and its group-allowlist exemption.
        ...(p2pDirect
          ? { chat_type: 'p2p' as const }
          : { ...(chatType ? { chat_type: chatType } : {}), group: message.chat_id }),
        message_id: message.message_id,
        ...(message.thread_id ? { thread_id: message.thread_id } : {}),
      },
    },
    meta: {
      provider: 'feishu',
      chat_id: message.chat_id,
      message_id: message.message_id,
      msg_type: message.msg_type,
      sender_type: senderType ?? 'unknown',
      ...(message.thread_id ? { thread_id: message.thread_id } : {}),
      ...(message.root_id ? { root_id: message.root_id } : {}),
      ...(message.parent_id ? { parent_id: message.parent_id } : {}),
    },
  }
}

/** Polling Source over a real Feishu chat. Repeated pulls are safe (Trigger ids dedupe). */
export class FeishuSource {
  private cursorMsValue: number
  private readonly chatTypeCache = new Map<string, 'p2p' | 'group'>()
  private readonly warnedChatModeLookupChatIds = new Set<string>()
  private readonly rawModeLoggedChatIds = new Set<string>()

  constructor(
    private readonly client: FeishuClient,
    private readonly chatId: string,
    options: {
      sinceMs?: number
      threadId?: string
      pageSize?: number
      config?: FeishuConfig
      log?: (line: string) => void
      now?: () => number
      maxMessageAgeMs?: number
    } = {},
  ) {
    this.cursorMsValue = options.sinceMs ?? Date.now() - 5 * 60_000
    this.threadId = options.threadId
    this.pageSize = options.pageSize
    this.config = options.config
    this.log = options.log ?? (() => undefined)
    this.now = options.now ?? Date.now
    this.maxMessageAgeMs = options.maxMessageAgeMs ?? feishuMaxMessageAgeMs()
  }

  private readonly threadId?: string
  private readonly pageSize?: number
  private readonly config?: FeishuConfig
  private readonly log: (line: string) => void
  private readonly now: () => number
  private readonly maxMessageAgeMs: number

  private warnChatModeLookupOnce(chatId: string, category: string): void {
    if (this.warnedChatModeLookupChatIds.has(chatId)) return
    this.warnedChatModeLookupChatIds.add(chatId)
    this.log(`[feishu] chat mode lookup ${category} chat=${chatId}; keeping conservative group admission`)
  }

  /**
   * Resolve and cache Feishu's trusted chat_mode for a chat. Returns the
   * normalized type plus the raw mode so callers can log precisely once.
   */
  private async verifiedChatType(
    chatId: string,
    signal?: AbortSignal,
  ): Promise<{ type: 'p2p' | 'group' | undefined; mode: string | undefined; failed?: string }> {
    const cached = this.chatTypeCache.get(chatId)
    if (cached) return { type: cached, mode: undefined }
    let mode: string | undefined
    try {
      mode = await this.client.getChatMode(chatId, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      // Metadata is advisory for polling; failure keeps conservative group admission.
      // Provider/custom-fetch messages may contain arbitrary or sensitive details.
      const code = error instanceof FeishuApiError
        && Number.isSafeInteger(error.code)
        && Math.abs(error.code) <= 999_999_999
        ? `api_error code=${error.code}`
        : 'lookup_error'
      this.warnChatModeLookupOnce(chatId, `failed category=${code}`)
      const publicDetail = error instanceof FeishuApiError && Number.isSafeInteger(error.code)
        ? String(error.code)
        : 'lookup error'
      return { type: undefined, mode: undefined, failed: publicDetail }
    }
    if (signal?.aborted) return { type: undefined, mode: undefined }
    const type = normalizeFeishuChatModeForDirect(mode)
    if (type) this.chatTypeCache.set(chatId, type)
    else {
      const category = mode === undefined ? 'unverified category=missing_mode' : 'unverified category=unrecognized_mode'
      this.warnChatModeLookupOnce(chatId, category)
    }
    return { type, mode }
  }
  /**
   * Highest message `create_time` (ms) observed so far, or the seed when none
   * was seen. A polling loop persists this as its durable cursor.
   */
  get cursorMs(): number {
    return this.cursorMsValue
  }

  /**
   * Reset the in-memory cursor, e.g. to the value it had before a pull whose
   * triggers were not all ingested. The next `pull` then re-reads the window;
   * repeated Trigger ids are deduped by `Runtime.ingest`.
   */
  restoreCursor(cursorMs: number): void {
    this.cursorMsValue = cursorMs
  }

  async pull(signal?: AbortSignal): Promise<Trigger[]> {
    const startTimeSec = Math.max(0, Math.floor((this.cursorMsValue - 1_000) / 1_000))
    const items = await this.client.listMessages(this.chatId, {
      startTimeSec,
      pageSize: this.pageSize,
      signal,
    })
    const p2pDirectEnabled = process.env.DS_AGENT_FEISHU_P2P_DIRECT?.trim() === '1'
    const resolvedTypes = new Map<string, 'p2p' | 'group' | undefined>()
    if (items.length > 0) {
      // Connector wake classifies the single polled chat regardless of direct
      // mode; the verified type is also what gates the p2p-direct override.
      const { type, mode, failed } = await this.verifiedChatType(this.chatId, signal)
      resolvedTypes.set(this.chatId, type)
      if (type === undefined && !this.rawModeLoggedChatIds.has(this.chatId)) {
        this.rawModeLoggedChatIds.add(this.chatId)
        if (failed) {
          this.log(`[feishu] chat metadata lookup failed chat=${this.chatId}: ${failed}`)
        } else {
          this.log(`[feishu] unrecognized chat_mode chat=${this.chatId} mode=${mode ?? '(missing)'}`)
        }
      }
    }
    if (signal?.aborted) return []
    const triggers: Trigger[] = []
    const nowMs = this.now()
    for (const item of items) {
      if (this.threadId && item.thread_id !== this.threadId) continue
      const at = Number(item.create_time)
      if (Number.isFinite(at) && at > this.cursorMsValue) this.cursorMsValue = at
      if (isStaleFeishuMessage(item, nowMs, this.maxMessageAgeMs)) {
        this.log(`[feishu] skip stale message_id=${item.message_id}`)
        continue
      }
      // Resolve other chat ids defensively when direct mode is enabled; cached
      // results and one warning per chat keep repeated pulls quiet.
      let chatType = resolvedTypes.get(item.chat_id)
      if (p2pDirectEnabled && chatType === undefined && item.chat_id !== this.chatId) {
        const resolved = await this.verifiedChatType(item.chat_id, signal)
        chatType = resolved.type
        resolvedTypes.set(item.chat_id, chatType)
      }
      const message: FeishuMessage = {
        ...item,
        // List-message chat_type is visibility metadata, not a private/group
        // discriminator; only verified chat_mode may set the marker.
        ...(chatType ? { chat_type: chatType } : { chat_type: undefined }),
      }
      triggers.push(feishuTriggerFromMessage(message, this.config))
    }
    return triggers
  }
}

/** Decrypt a Feishu event envelope (AES-256-CBC, key = SHA-256(Encrypt Key)). */
export function decryptFeishuPayload(encrypted: string, encryptKey: string): string {
  if (!encryptKey) throw new Error('FEISHU_ENCRYPT_KEY is required for an encrypted Feishu payload')
  const key = crypto.createHash('sha256').update(encryptKey).digest()
  const buffer = Buffer.from(encrypted, 'base64')
  if (buffer.length <= 16) throw new Error('encrypted Feishu payload is too short')
  const iv = buffer.subarray(0, 16)
  const data = buffer.subarray(16)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

export interface FeishuWebhookResult {
  /** Return this to Feishu for `url_verification`. */
  challenge?: string
  trigger?: Trigger
  ignored?: string
}

/**
 * Parse a Feishu event-callback body. Handles URL verification, encrypted
 * envelopes, and `im.message.receive_v1`. Verification tokens are enforced
 * when `FEISHU_VERIFICATION_TOKEN` is configured.
 */
export function parseFeishuWebhook(
  payload: unknown,
  config: FeishuConfig,
  options: { now?: () => number; maxMessageAgeMs?: number; log?: (line: string) => void } = {},
): FeishuWebhookResult {
  let body = payload
  if (body && typeof body === 'object' && typeof (body as { encrypt?: unknown }).encrypt === 'string') {
    body = JSON.parse(decryptFeishuPayload((body as { encrypt: string }).encrypt, config.encryptKey ?? '')) as unknown
  }
  if (!body || typeof body !== 'object') return { ignored: 'not-an-object' }
  const record = body as Record<string, unknown>

  // URL verification (v1 callback).
  if (record.type === 'url_verification') {
    if (config.verificationToken && record.token !== config.verificationToken) {
      throw new Error('Feishu url_verification token mismatch')
    }
    return { challenge: String(record.challenge ?? '') }
  }

  const header = record.header as { event_type?: string; token?: string } | undefined
  if (config.verificationToken && header?.token && header.token !== config.verificationToken) {
    throw new Error('Feishu event token mismatch')
  }
  if (header?.event_type !== 'im.message.receive_v1') {
    return { ignored: header?.event_type ?? 'unknown-event' }
  }
  const event = record.event as {
    sender?: { sender_id?: { open_id?: string; user_id?: string; union_id?: string }; sender_type?: string; tenant_key?: string }
    message?: Omit<FeishuMessage, 'chat_id' | 'sender'> & { chat_id?: string }
  } | undefined
  const message = event?.message
  if (!message?.message_id || !message.chat_id) return { ignored: 'no-message' }
  if (isStaleFeishuMessage(
    message as FeishuMessage,
    (options.now ?? Date.now)(),
    options.maxMessageAgeMs ?? feishuMaxMessageAgeMs(),
  )) {
    options.log?.(`[feishu] skip stale message_id=${message.message_id}`)
    return { ignored: 'stale-message' }
  }
  const sender = event?.sender
  const senderId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? sender?.sender_id?.union_id
  return {
    trigger: feishuTriggerFromMessage({
      ...message,
      chat_id: message.chat_id,
      sender: {
        id: senderId,
        sender_type: sender?.sender_type,
        tenant_key: sender?.tenant_key,
      },
    } as FeishuMessage, config),
  }
}

/** Real outbound adapter for Feishu IM. Replies in-thread when a message id is known. */
export class FeishuOutboxAdapter implements OutboundAdapter {
  readonly channel = 'im'

  constructor(
    private readonly client: FeishuClient,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  async send(row: OutboxRow): Promise<{ externalId: string }> {
    return this.sendRow(row)
  }

  async sendWithProgress(row: OutboxRow, onProgress: OutboxProgress): Promise<{ externalId: string }> {
    return this.sendRow(row, onProgress)
  }

  private async sendRow(row: OutboxRow, onProgress?: OutboxProgress): Promise<{ externalId: string }> {
    const provider = row.target.provider
    if (provider && provider !== 'feishu') {
      throw new Error(`im outbox row ${row.id} targets ${provider}, not feishu`)
    }
    const messageId = row.target.message_id
    const chatId = row.target.chat_id
    if (!messageId && !chatId) throw new Error(`feishu outbox row ${row.id} has no chat_id/message_id`)

    type ProgressMetadata = {
      textHash?: string
      nextChunk?: number
      total?: number
      firstExternalId?: string
      interactiveHash?: string
      interactiveExternalId?: string
      sendUuids?: Record<string, string>
    }
    let metadata: ProgressMetadata = {}
    try {
      const saved = JSON.parse(row.target[FEISHU_TEXT_PROGRESS_KEY] ?? '') as ProgressMetadata
      if (saved && typeof saved === 'object') metadata = saved
    } catch {
      // Old rows and malformed progress metadata safely start without saved keys.
    }
    metadata.sendUuids ??= {}
    const route = messageId ? `reply:${messageId}` : `send:${chatId}`
    const uuidFor = (kind: string, content: string, index = 0, logicalHash?: string): string => {
      const contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex')
      const key = `${route}:${kind}:${logicalHash ?? contentHash}:${contentHash}:${index}`
      const existing = metadata.sendUuids![key]
      if (existing) return existing
      const uuid = crypto.randomUUID()
      metadata.sendUuids![key] = uuid
      if (onProgress) {
        onProgress({ ...row.target, [FEISHU_TEXT_PROGRESS_KEY]: JSON.stringify(metadata) })
      }
      return uuid
    }
    const sendTextBody = (text: string, uuid: string): Promise<{ message_id: string }> => messageId
      ? this.client.replyText(messageId, text, uuid)
      : this.client.sendText(chatId!, text, uuid)
    const sendTextDelivery = async (text: string): Promise<{ message_id: string }> => {
      const chunks = textRequestBodyBytes(text) <= FEISHU_TEXT_REQUEST_LIMIT_BYTES
        ? [text]
        : splitFeishuText(text)
      const textHash = crypto.createHash('sha256').update(text, 'utf8').digest('hex')
      let progress: ProgressMetadata | undefined
      if (metadata.textHash === textHash && metadata.total === chunks.length
        && Number.isInteger(metadata.nextChunk) && metadata.nextChunk! > 0 && metadata.nextChunk! <= chunks.length
        && typeof metadata.firstExternalId === 'string' && metadata.firstExternalId.length > 0) {
        progress = metadata
      }
      let firstResult: { message_id: string } | undefined = progress
        ? { message_id: progress.firstExternalId! }
        : undefined
      if (progress?.nextChunk === chunks.length) return firstResult!
      for (let index = progress?.nextChunk ?? 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!
        const uuid = uuidFor('text', chunk, index, textHash)
        const sent = await sendTextBody(chunk, uuid)
        if (!sent.message_id) throw new Error(`Feishu send returned no message_id for outbox row ${row.id}`)
        firstResult ??= sent
        if (onProgress) {
          metadata = {
            ...metadata,
            textHash,
            nextChunk: index + 1,
            total: chunks.length,
            firstExternalId: firstResult.message_id,
          }
          onProgress({ ...row.target, [FEISHU_TEXT_PROGRESS_KEY]: JSON.stringify(metadata) }, firstResult.message_id)
        }
      }
      if (!firstResult) throw new Error(`Feishu send produced no text chunks for outbox row ${row.id}`)
      return firstResult
    }
    const format = process.env.FEISHU_REPLY_FORMAT?.trim().toLowerCase()
    let result: { message_id: string }
    if (format !== 'text' && hasFeishuMarkdownStructure(row.text)) {
      const rendered = renderFeishuMarkdownCard(row.text, row.ticketId)
      if (rendered.truncated || Buffer.byteLength(rendered.content, 'utf8') > FEISHU_CARD_CONTENT_LIMIT_BYTES) {
        result = await sendTextDelivery(row.text)
      } else {
        const interactiveHash = crypto.createHash('sha256').update(rendered.content, 'utf8').digest('hex')
        if (metadata.interactiveHash === interactiveHash
          && typeof metadata.interactiveExternalId === 'string' && metadata.interactiveExternalId.length > 0) {
          result = { message_id: metadata.interactiveExternalId }
        } else {
          const uuid = uuidFor('interactive', rendered.content)
          let acceptedAsCard = false
          try {
            result = messageId
              ? await this.client.replyInteractive(messageId, rendered.content, uuid)
              : await this.client.sendInteractive(chatId!, rendered.content, uuid)
            acceptedAsCard = true
          } catch (error) {
            // Only documented format/size rejection codes guarantee that the
            // card was rejected before acceptance and permit a text fallback.
            if (!(error instanceof FeishuApiError) || ![230025, 230099].includes(error.code)) throw error
            result = await sendTextDelivery(row.text)
          }
          if (acceptedAsCard && onProgress && result.message_id) {
            metadata = { ...metadata, interactiveHash, interactiveExternalId: result.message_id }
            onProgress({ ...row.target, [FEISHU_TEXT_PROGRESS_KEY]: JSON.stringify(metadata) }, result.message_id)
          }
        }
      }
    } else {
      result = await sendTextDelivery(row.text)
    }
    if (!result.message_id) throw new Error(`Feishu send returned no message_id for outbox row ${row.id}`)
    this.log(`[feishu] outbound message_id=${result.message_id}`)
    return { externalId: result.message_id }
  }
}
