import { UserError } from '../shared/errors.ts'
import type { Store } from '../store/sqlite.ts'

const MAX_ENTRIES = 12
const DEFAULT_ENTRIES = 6
const MAX_CANDIDATES = 96
const MAX_ENTRY_CHARS = 1_200
const MAX_PAGE_CHARS = 8_000
const MAX_QUERY_CHARS = 240
const MAX_REFERENCE_SESSION_CHARS = 512

export interface MemoryEvidenceRef {
  sessionId?: string
  id: number
}

interface TranscriptEvidence {
  id: number
  role: 'user' | 'assistant'
  at: string
  text: string
  truncated?: true
  ref?: MemoryEvidenceRef
}

interface TranscriptPage {
  entries: TranscriptEvidence[]
  /** Exclusive upper bound for the next page, when earlier rows may exist. */
  before?: number
}

// Legacy rows persisted assembled prompts as user messages. These envelopes
// contain scheduler instructions and recalled context alongside human text.
const SYNTHETIC_PREFIX = /^(?:[A-Z][A-Z_]+)\r?\n(?=[a-z]\w*=)/
const RESERVED_EVIDENCE_PREFIX = /^(?:PROACTIVE_IDLE|CONNECTOR_EVENT)\r?\n/

function evidenceText(body: string | null, role: TranscriptEvidence['role'], authoredOnly = false): string | undefined {
  if (body === null) return undefined
  try {
    const message = JSON.parse(body) as Record<string, unknown> | null
    if (message?.kind !== 'message' || message.role !== role) return undefined
    if (role === 'user' && Object.hasOwn(message, 'evidenceText')) {
      return typeof message.evidenceText === 'string' && (!authoredOnly || !RESERVED_EVIDENCE_PREFIX.test(message.evidenceText))
        ? message.evidenceText
        : undefined
    }
    if (authoredOnly || typeof message.content !== 'string') return undefined
    if (role === 'user' && SYNTHETIC_PREFIX.test(message.content)) return undefined
    return message.content
  } catch {
    // Old or torn journal rows can be absent or malformed.
    return undefined
  }
}

function integer(value: unknown, maximum: number, argument: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new UserError(`${argument} must be an integer between 1 and ${maximum}`)
  }
  return value
}

/** Read bounded chronological evidence from the current, harness-owned session.
 * The caller must bind sessionId from its own ToolContext, never from tool args.
 * Returned message text is historical data, and assistant text is unverified.
 */
export function readMemoryTranscript(
  store: Store,
  sessionId: string,
  args: Record<string, unknown>,
  redact: (text: string) => string,
): TranscriptPage {
  if (!sessionId || Object.keys(args).some(key => key !== 'before' && key !== 'limit')) {
    throw new UserError('transcript accepts only before and limit in the current session')
  }
  const before = args.before === undefined
    ? Number.MAX_SAFE_INTEGER
    : integer(args.before, Number.MAX_SAFE_INTEGER, 'before')
  const limit = args.limit === undefined ? DEFAULT_ENTRIES : integer(args.limit, MAX_ENTRIES, 'limit')

  return evidencePage(store.listTranscriptPage(sessionId, before, MAX_CANDIDATES + 1), limit, redact)
}

type EvidenceRow = ReturnType<Store['listTranscriptPage']>[number] & { ref?: MemoryEvidenceRef }

function evidencePage(
  rows: EvidenceRow[], limit: number, redact: (text: string) => string, query?: string, authoredOnly = false,
): TranscriptPage {
  const entries: TranscriptEvidence[] = []
  let chars = 0
  let consumed = 0
  for (const row of rows.slice(0, MAX_CANDIDATES)) {
    if (entries.length === limit) break
    const role = row.role
    if (role === 'user' || (!authoredOnly && role === 'assistant')) {
      const raw = evidenceText(row.body, role, authoredOnly)
      const text = raw === undefined ? undefined : redact(raw)
      if (text?.trim() && (query === undefined || text.toLowerCase().includes(query))) {
        const entry: TranscriptEvidence = {
          id: row.id,
          role,
          at: row.createdAt,
          text: text.slice(0, MAX_ENTRY_CHARS),
          ...(row.ref ? { ref: row.ref } : {}),
        }
        if (text.length > entry.text.length) entry.truncated = true
        let entryChars = JSON.stringify(entry).length + 1
        if (entryChars > MAX_PAGE_CHARS && chars === 0) {
          // The new reference also consumes the response budget. A single large
          // row must fit or advance the cursor even when text needs escaping.
          const overhead = JSON.stringify({ ...entry, text: '', truncated: true }).length + 1
          entry.text = entry.text.slice(0, Math.max(0, Math.floor((MAX_PAGE_CHARS - overhead) / 6)))
          entry.truncated = true
          entryChars = JSON.stringify(entry).length + 1
        }
        if (chars + entryChars > MAX_PAGE_CHARS && chars !== 0) break
        if (entryChars <= MAX_PAGE_CHARS) {
          chars += entryChars
          entries.push(entry)
        }
      }
    }
    consumed += 1
  }
  if (consumed < rows.length) return { entries, before: rows[consumed - 1]!.id }
  return { entries }
}

export function readScopedMemoryTranscript(
  store: Store,
  sessionId: string,
  args: Record<string, unknown>,
  redact: (text: string) => string,
  sharedThreads: string[] | undefined,
  scopeAllowed: boolean,
): TranscriptPage {
  if (Object.hasOwn(args, 'ref')) {
    const ref = args.ref as Partial<MemoryEvidenceRef> | undefined
    if (Object.keys(args).length !== 1 || !ref || typeof ref !== 'object'
      || Object.keys(ref).some(key => key !== 'id' && key !== 'sessionId')
      || (ref.sessionId !== undefined
        && (typeof ref.sessionId !== 'string' || !ref.sessionId.length || ref.sessionId.length > MAX_REFERENCE_SESSION_CHARS))) {
      throw new UserError('ref must contain an id and can include a sessionId')
    }
    const id = integer(ref.id, Number.MAX_SAFE_INTEGER, 'ref.id')
    const reference = ref.sessionId === undefined ? { id } : { id, sessionId: ref.sessionId }
    if (ref.sessionId === undefined || ref.sessionId === sessionId) {
      const row = store.getTranscriptEvidence(sessionId, id)
      if (row) return evidencePage([{ ...row, ref: reference }], 1, redact)
    }
    if (!sharedThreads) return { entries: [] }
    const [row] = store.listSharedTranscriptPage(sessionId, sharedThreads, Number.MAX_SAFE_INTEGER, 1, reference)
    return evidencePage(row ? [{ ...row, ref: reference }] : [], 1, redact, undefined, true)
  }
  if (args.scope !== 'memory' || Object.keys(args).some(key => !['scope', 'query', 'before', 'limit'].includes(key))) {
    throw new UserError('transcript search accepts scope: memory, query, before and limit')
  }
  if (args.query !== undefined && (typeof args.query !== 'string' || !args.query.trim() || args.query.length > MAX_QUERY_CHARS)) {
    throw new UserError(`query must be a nonempty string of at most ${MAX_QUERY_CHARS} characters`)
  }
  const query = (args.query as string | undefined)?.trim().toLowerCase()
  const before = args.before === undefined
    ? Number.MAX_SAFE_INTEGER
    : integer(args.before, Number.MAX_SAFE_INTEGER, 'before')
  const limit = args.limit === undefined ? DEFAULT_ENTRIES : integer(args.limit, MAX_ENTRIES, 'limit')
  if (!scopeAllowed) return { entries: [] }
  const rows = sharedThreads
    ? store.listSharedTranscriptPage(sessionId, sharedThreads, before, MAX_CANDIDATES + 1)
    : store.listTranscriptPage(sessionId, before, MAX_CANDIDATES + 1).map(row => ({ ...row, sessionId }))
  return evidencePage(
    rows.map(row => ({ ...row, ref: { id: row.id, sessionId: row.sessionId } })), limit, redact, query, true,
  )
}

/** Only user evidence contributes to unattended writes. Scan in journal order. */
export function readPendingMemoryEvidence(
  store: Store, sessionId: string, after: number, redact: (text: string) => string,
): { through: number; entries: { id: number; text: string }[] } {
  const rows = store.listTranscriptAfter(sessionId, after, 8)
  return {
    through: rows.at(-1)?.id ?? after,
    entries: rows.flatMap(row => {
      const text = evidenceText(row.body, 'user')
      return text?.trim() && !RESERVED_EVIDENCE_PREFIX.test(text)
        ? [{ id: row.id, text: redact(text).slice(0, MAX_ENTRY_CHARS) }]
        : []
    }),
  }
}
