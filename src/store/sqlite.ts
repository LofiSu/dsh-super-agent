import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { LifecycleEvent } from '../core/lifecycle.ts'
import type { DomainEventName } from '../shared/events.ts'
import { UserError } from '../shared/errors.ts'
import type { JobRow, ObjectRef, OutboxRow, PublishApprovalBinding, ReplyRow, SessionRow } from '../shared/types.ts'
import { LATEST_SCHEMA_VERSION, migrate } from './schema.ts'

export type PublishObservationState =
  | 'admitted'
  | 'attempt_started'
  | 'returned'
  | 'unconfirmed'
  | 'legacy_unrecorded'
  | 'unsupported'

const PUBLISH_OBSERVATION_STATES: readonly string[] = [
  'admitted', 'attempt_started', 'returned', 'unconfirmed', 'legacy_unrecorded',
]

function parsePublishObservationState(value: string): PublishObservationState {
  return PUBLISH_OBSERVATION_STATES.includes(value)
    ? value as PublishObservationState
    : 'unsupported'
}

export interface PublishAdmissionRecord {
  ticketId: string
  approvalId: string
  admittedAt: string
  binding?: PublishApprovalBinding
  observationState: PublishObservationState
  result?: { number: number; branch: string; remote: string }
  observedAt?: string
}

export interface ReadonlyPublishAdmissions {
  admissions: PublishAdmissionRecord[]
  admissionLedgerAvailable: boolean
}

/**
 * Read publisher evidence without entering the writable Store lifecycle.
 * SQLite opens the existing file with SQLITE_OPEN_READONLY; no migration,
 * journal-mode change, or checkpoint is run here.
 */
export function readPublishAdmissionsReadOnly(home: string, ticketId: string): ReadonlyPublishAdmissions {
  const dbPath = path.join(home, 'lofibot.db')
  try {
    fs.statSync(dbPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { admissions: [], admissionLedgerAvailable: false }
    }
    throw error
  }

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const migrationTable = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`,
    ).get()
    const schemaVersion = migrationTable
      ? Number((db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null }).version ?? 0)
      : 0
    if (schemaVersion > LATEST_SCHEMA_VERSION) {
      throw new Error(`database schema version ${schemaVersion} is newer than this build supports (${LATEST_SCHEMA_VERSION})`)
    }

    const admissionTable = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'publish_approval_admissions'`,
    ).get()
    if (!admissionTable) return { admissions: [], admissionLedgerAvailable: false }

    const columns = new Set((db.prepare('PRAGMA table_info(publish_approval_admissions)').all() as { name: string }[])
      .map(column => column.name))
    for (const required of ['ticket_id', 'approval_id', 'admitted_at']) {
      if (!columns.has(required)) throw new Error(`publish admission ledger is missing required column ${required}`)
    }
    const hasObservationColumns = ['binding_json', 'observation_state', 'result_json', 'observed_at']
      .every(column => columns.has(column))
    if (schemaVersion >= LATEST_SCHEMA_VERSION && !hasObservationColumns) {
      throw new Error('publish admission ledger does not match the recorded schema version')
    }

    const rows = hasObservationColumns
      ? db.prepare(`SELECT ticket_id, approval_id, admitted_at, binding_json, observation_state, result_json, observed_at
                    FROM publish_approval_admissions WHERE ticket_id = ? ORDER BY admitted_at, approval_id`).all(ticketId)
      : db.prepare(`SELECT ticket_id, approval_id, admitted_at
                    FROM publish_approval_admissions WHERE ticket_id = ? ORDER BY admitted_at, approval_id`).all(ticketId)
    return {
      admissionLedgerAvailable: true,
      admissions: (rows as {
        ticket_id: string
        approval_id: string
        admitted_at: string
        binding_json?: string | null
        observation_state?: string
        result_json?: string | null
        observed_at?: string | null
      }[]).map(row => ({
        ticketId: row.ticket_id,
        approvalId: row.approval_id,
        admittedAt: row.admitted_at,
        ...(row.binding_json ? { binding: JSON.parse(row.binding_json) as PublishApprovalBinding } : {}),
        observationState: hasObservationColumns
          ? parsePublishObservationState(row.observation_state ?? '')
          : 'legacy_unrecorded',
        ...(row.result_json ? {
          result: JSON.parse(row.result_json) as PublishAdmissionRecord['result'],
        } : {}),
        ...(row.observed_at ? { observedAt: row.observed_at } : {}),
      })),
    }
  } finally {
    db.close()
  }
}

function readSchemaVersion(db: DatabaseSync): number {
  const ledger = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get()
  if (!ledger) return 0

  const rows = db.prepare(
    'SELECT version FROM schema_migrations',
  ).all() as { version: unknown }[]
  if (rows.length === 0) {
    throw new UserError('database schema ledger contains an invalid version')
  }
  let version = 0
  for (const row of rows) {
    if (typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1) {
      throw new UserError('database schema ledger contains an invalid version')
    }
    version = Math.max(version, row.version)
  }
  if (version > LATEST_SCHEMA_VERSION) {
    throw new UserError(
      `database schema version ${version} is newer than this build supports (${LATEST_SCHEMA_VERSION}); ` +
      'upgrade lofibot before opening this store',
    )
  }
  return version
}

export function supportsReadOnlyDatabaseSync(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major > 23 ||
    (major === 23 && minor >= 2) ||
    (major === 22 && minor >= 12)
}

export interface ReceiptTicket {
  id: string
  createdAt?: string
  ended?: { at?: string; outcome: string; by?: string }
  channels: Array<{ source: string }>
  inputs: Array<{ id: string; kind: string; at?: string }>
  assignments: Array<{
    id: string
    state: string
    startedAt?: string
    endedAt?: string
    report?: { kind: string; at?: string }
  }>
}

export interface ReceiptExternalOperation {
  id: string
  kind: string
  phase: string
  assignmentId?: string
  updatedAt?: string
}

export class Store {
  readonly path: string
  private readonly db: DatabaseSync
  private readonly readOnly: boolean
  private depth = 0
  private afterCommitEffects: (() => void)[] = []
  private closed = false
  private schemaVersionValue = 0

  static openReadOnly(home: string): Store {
    return new Store(home, { readOnly: true })
  }

  constructor(home: string, options: { readOnly?: boolean } = {}) {
    this.path = path.join(home, 'lofibot.db')
    this.readOnly = options.readOnly === true
    if (this.readOnly) {
      if (!supportsReadOnlyDatabaseSync()) {
        throw new Error('read-only SQLite access requires Node.js 22.12+ or 23.2+')
      }
      if (!fs.existsSync(this.path)) throw new Error('local state database does not exist')
      this.db = new DatabaseSync(this.path, { readOnly: true })
      try {
        this.schemaVersionValue = readSchemaVersion(this.db)
      } catch (error) {
        this.db.close()
        throw error
      }
      return
    }

    fs.mkdirSync(home, { recursive: true })
    this.db = new DatabaseSync(this.path)
    try {
      this.schemaVersionValue = migrate(this.db)
    } catch (error) {
      try {
        this.db.close()
      } catch {
        // The handle may already be unusable.
      }
      throw error
    }
    // Switch to WAL only after migrating: a database recorded at a newer
    // version must fail closed without touching the file.
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  /** The schema version recorded in this database after migration. */
  get schemaVersion(): number {
    return this.schemaVersionValue
  }

  get isOpen(): boolean {
    return !this.closed
  }

  private assertWritable(): void {
    if (this.readOnly) throw new Error('store is open read-only')
  }

  close(): void {
    if (this.closed) return
    if (!this.readOnly) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db.close()
    this.closed = true
  }

  health(): string {
    const row = this.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined
    if (row?.ok !== 1) throw new Error('sqlite health check failed')
    return 'ok'
  }

  atomic<T>(work: () => T): T {
    this.assertWritable()
    if (this.depth > 0) return work()
    this.depth += 1
    this.afterCommitEffects = []
    let committed = false
    let effects: (() => void)[] = []
    try {
      this.db.exec('BEGIN')
      const result = work()
      this.db.exec('COMMIT')
      committed = true
      effects = this.afterCommitEffects
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The transaction may already be closed.
      }
      throw error
    } finally {
      this.depth -= 1
      this.afterCommitEffects = []
      if (committed) for (const effect of effects) effect()
    }
  }

  /** Run an in-memory side effect only if the outermost transaction commits. */
  afterCommit(effect: () => void): void {
    if (this.depth === 0) effect()
    else this.afterCommitEffects.push(effect)
  }

  nextId(prefix: string): string {
    this.assertWritable()
    const row = this.db.prepare(
      `INSERT INTO id_seq(prefix, n) VALUES(?, 1)
       ON CONFLICT(prefix) DO UPDATE SET n = n + 1
       RETURNING n`,
    ).get(prefix) as { n: number }
    return `${prefix}_${row.n}`
  }

  putDoc(kind: string, id: string, value: unknown): void {
    this.assertWritable()
    this.db.prepare(
      `INSERT INTO documents(kind, id, payload) VALUES(?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET payload = excluded.payload`,
    ).run(kind, id, JSON.stringify(value))
  }

  getDoc<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare(
      'SELECT payload FROM documents WHERE kind = ? AND id = ?',
    ).get(kind, id) as { payload: string } | undefined
    return row ? JSON.parse(row.payload) as T : undefined
  }

  /** Read only allowlisted Ticket fields used by the execution receipt. */
  getReceiptTicket(id: string): ReceiptTicket | undefined {
    const row = this.db.prepare(
      'SELECT json_valid(payload) AS is_valid FROM documents WHERE kind = ? AND id = ?',
    ).get('ticket', id) as { is_valid: number } | undefined
    if (!row) return undefined
    if (row.is_valid !== 1) throw new SyntaxError('ticket payload is malformed JSON')

    const projected = this.db.prepare(`
      SELECT json_object(
        'id', json_extract(payload, '$.id'),
        'createdAt', json_extract(payload, '$.createdAt'),
        'ended', CASE WHEN json_type(payload, '$.ended') = 'object' THEN
          json_object('at', json_extract(payload, '$.ended.at'),
                      'outcome', json_extract(payload, '$.ended.outcome'),
                      'by', json_extract(payload, '$.ended.by'))
          ELSE NULL END,
        'channels', json(COALESCE((
          SELECT json_group_array(json_object('source', json_extract(channel.value, '$.source')))
          FROM json_each(payload, '$.channels') AS channel
        ), '[]')),
        'inputs', json(COALESCE((
          SELECT json_group_array(json_object(
            'id', json_extract(input.value, '$.id'),
            'kind', json_extract(input.value, '$.kind'),
            'at', json_extract(input.value, '$.at')))
          FROM json_each(payload, '$.inputs') AS input
        ), '[]')),
        'assignments', json(COALESCE((
          SELECT json_group_array(json_object(
            'id', json_extract(assignment.value, '$.id'),
            'state', json_extract(assignment.value, '$.state'),
            'startedAt', json_extract(assignment.value, '$.startedAt'),
            'endedAt', json_extract(assignment.value, '$.endedAt'),
            'report', CASE WHEN json_type(assignment.value, '$.report') = 'object' THEN
              json_object('kind', json_extract(assignment.value, '$.report.kind'),
                          'at', json_extract(assignment.value, '$.report.at'))
              ELSE NULL END))
          FROM json_each(payload, '$.assignments') AS assignment
        ), '[]'))
      ) AS payload
      FROM documents WHERE kind = ? AND id = ?
    `).get('ticket', id) as { payload: string }
    return JSON.parse(projected.payload) as ReceiptTicket
  }

  /** Read external-operation receipt metadata without loading private details. */
  listReceiptExternalOperations(ticketId: string): ReceiptExternalOperation[] {
    const rows = this.db.prepare(`
      SELECT id,
             json_extract(payload, '$.kind') AS kind,
             json_extract(payload, '$.phase') AS phase,
             json_extract(payload, '$.assignmentId') AS assignment_id,
             json_extract(payload, '$.updatedAt') AS updated_at
      FROM documents
      WHERE kind = ? AND CASE WHEN json_valid(payload)
        THEN json_extract(payload, '$.ticketId') END = ?
      ORDER BY rowid
    `).all('external_op', ticketId) as {
      id: string; kind: string; phase: string; assignment_id: string | null; updated_at: string | null
    }[]
    return rows.map(row => ({
      id: row.id,
      kind: row.kind,
      phase: row.phase,
      ...(row.assignment_id !== null ? { assignmentId: row.assignment_id } : {}),
      ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
    }))
  }

  /** Return at most two matching keys to resolve an exact or unique prefix. */
  listDocIdsByPrefix(kind: string, prefix: string): string[] {
    const rows = this.db.prepare(
      `SELECT id FROM documents
       WHERE kind = ? AND instr(id, ?) = 1
       ORDER BY id LIMIT 2`,
    ).all(kind, prefix) as { id: string }[]
    return rows.map(row => row.id)
  }

  listDocs<T>(kind: string): T[] {
    const rows = this.db.prepare(
      'SELECT payload FROM documents WHERE kind = ? ORDER BY rowid',
    ).all(kind) as { payload: string }[]
    return rows.map(row => JSON.parse(row.payload) as T)
  }

  /** Read only documents whose JSON payload belongs to one Ticket. */
  listDocsForTicket<T>(kind: string, ticketId: string): T[] {
    const rows = this.db.prepare(
      `SELECT payload FROM documents
       WHERE kind = ?
         AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.ticketId') END = ?
       ORDER BY rowid`,
    ).all(kind, ticketId) as { payload: string }[]
    return rows.map(row => JSON.parse(row.payload) as T)
  }

  deleteDoc(kind: string, id: string): void {
    this.assertWritable()
    this.db.prepare('DELETE FROM documents WHERE kind = ? AND id = ?').run(kind, id)
  }

  /** Persist the one-use admission and immutable approval binding before publisher entry. */
  admitPublishApprovalOnce(input: {
    ticketId: string
    approvalId: string
    binding: PublishApprovalBinding
  }): boolean {
    const { ticketId, approvalId, binding } = input
    return this.atomic(() => {
      const result = this.db.prepare(
        `INSERT INTO publish_approval_admissions(
           ticket_id, approval_id, admitted_at, binding_json, observation_state
         ) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(ticket_id, approval_id) DO NOTHING`,
      ).run(
        ticketId,
        approvalId,
        new Date().toISOString(),
        JSON.stringify(binding),
        'admitted',
      )
      return result.changes === 1
    })
  }

  /** Publisher entry is possible only after this marker commits. */
  markPublishAttemptStarted(ticketId: string, approvalId: string): void {
    const result = this.db.prepare(
      `UPDATE publish_approval_admissions
       SET observation_state = 'attempt_started', observed_at = ?
       WHERE ticket_id = ? AND approval_id = ? AND observation_state = 'admitted'`,
    ).run(new Date().toISOString(), ticketId, approvalId)
    if (result.changes !== 1) throw new Error('publish admission is not awaiting publisher entry')
  }

  /** Persist the publisher's public returned result; no provider output is retained. */
  recordPublishReturned(
    ticketId: string,
    approvalId: string,
    result: { number: number; branch: string; remote: string },
  ): void {
    const observedAt = new Date().toISOString()
    const updated = this.db.prepare(
      `UPDATE publish_approval_admissions
       SET observation_state = 'returned', result_json = ?, observed_at = ?
       WHERE ticket_id = ? AND approval_id = ? AND observation_state = 'attempt_started'`,
    ).run(JSON.stringify(result), observedAt, ticketId, approvalId)
    if (updated.changes !== 1) throw new Error('publish admission cannot record returned result')
  }

  /** A thrown publisher call is uncertain: errors do not prove no remote effect. */
  recordPublishUnconfirmed(ticketId: string, approvalId: string): void {
    this.db.prepare(
      `UPDATE publish_approval_admissions
       SET observation_state = 'unconfirmed', result_json = NULL, observed_at = ?
       WHERE ticket_id = ? AND approval_id = ? AND observation_state = 'attempt_started'`,
    ).run(new Date().toISOString(), ticketId, approvalId)
  }

  /** Read publisher facts for one Ticket; this query never changes admissions. */
  listPublishAdmissions(ticketId: string): PublishAdmissionRecord[] {
    const rows = this.db.prepare(
      `SELECT ticket_id, approval_id, admitted_at, binding_json, observation_state, result_json, observed_at
       FROM publish_approval_admissions WHERE ticket_id = ? ORDER BY admitted_at, approval_id`,
    ).all(ticketId) as {
      ticket_id: string
      approval_id: string
      admitted_at: string
      binding_json: string | null
      observation_state: string
      result_json: string | null
      observed_at: string | null
    }[]
    return rows.map(row => ({
      ticketId: row.ticket_id,
      approvalId: row.approval_id,
      admittedAt: row.admitted_at,
      ...(row.binding_json ? { binding: JSON.parse(row.binding_json) as PublishApprovalBinding } : {}),
      observationState: parsePublishObservationState(row.observation_state),
      ...(row.result_json ? {
        result: JSON.parse(row.result_json) as PublishAdmissionRecord['result'],
      } : {}),
      ...(row.observed_at ? { observedAt: row.observed_at } : {}),
    }))
  }

  addEvent(type: DomainEventName, payload: unknown): void {
    this.assertWritable()
    this.db.prepare(
      'INSERT INTO events(type, payload, created_at) VALUES(?, ?, ?)',
    ).run(type, JSON.stringify(payload), new Date().toISOString())
  }

  listEvents(): { type: DomainEventName; payload: unknown; createdAt: string }[] {
    const rows = this.db.prepare(
      'SELECT type, payload, created_at FROM events ORDER BY id',
    ).all() as { type: DomainEventName; payload: string; created_at: string }[]
    return rows.map(row => ({
      type: row.type,
      payload: JSON.parse(row.payload) as unknown,
      createdAt: row.created_at,
    }))
  }

  /**
   * Persist one lifecycle event. When `keep` is set, the log is bounded in the
   * same transaction: only the newest `keep` rows survive, so the table cannot
   * grow without limit. `at` is write-time metadata, not part of the event
   * read model returned by `recentLifecycleEvents`.
   */
  appendLifecycleEvent(event: LifecycleEvent, keep?: number): void {
    this.assertWritable()
    this.atomic(() => {
      this.db.prepare(
        'INSERT INTO lifecycle_events(at, kind, payload) VALUES(?, ?, ?)',
      ).run(new Date().toISOString(), event.kind, JSON.stringify(event.payload) ?? 'null')
      if (keep !== undefined) this.pruneLifecycleEvents(keep)
    })
  }

  /** The newest `limit` lifecycle events in publish order. */
  recentLifecycleEvents(limit: number): LifecycleEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1) return []
    const rows = this.db.prepare(
      'SELECT kind, payload FROM lifecycle_events ORDER BY id DESC LIMIT ?',
    ).all(limit) as { kind: string; payload: string }[]
    return rows.reverse().map(row => ({
      kind: row.kind,
      payload: JSON.parse(row.payload) as unknown,
    }))
  }

  /** Keep only the newest `keep` lifecycle rows; older rows are deleted. */
  pruneLifecycleEvents(keep: number): void {
    this.assertWritable()
    if (!Number.isSafeInteger(keep) || keep < 1) {
      throw new Error('lifecycle retention must be a positive integer')
    }
    this.db.prepare(
      `DELETE FROM lifecycle_events
       WHERE id NOT IN (SELECT id FROM lifecycle_events ORDER BY id DESC LIMIT ?)`,
    ).run(keep)
  }

  addReply(row: ReplyRow): void {
    this.assertWritable()
    this.db.prepare(
      `INSERT INTO replies(id, ticket_id, channel, purpose, text, status, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.ticketId, row.channel, row.purpose, row.text, row.status, row.createdAt)
  }

  markReplySent(id: string): void {
    this.assertWritable()
    this.db.prepare(`UPDATE replies SET status = 'sent' WHERE id = ?`).run(id)
  }

  listReplies(): ReplyRow[] {
    const rows = this.db.prepare(
      'SELECT id, ticket_id, channel, purpose, text, status, created_at FROM replies ORDER BY rowid',
    ).all() as Record<string, string>[]
    return rows.map(row => ({
      id: row.id,
      ticketId: row.ticket_id,
      channel: row.channel,
      purpose: row.purpose,
      text: row.text,
      status: row.status as ReplyRow['status'],
      createdAt: row.created_at,
    }))
  }

  /** Receipt metadata for one Ticket, deliberately excluding reply bodies. */
  listReceiptReplies(ticketId: string): Pick<ReplyRow, 'id' | 'channel' | 'status' | 'createdAt'>[] {
    const rows = this.db.prepare(
      `SELECT id, channel, status, created_at FROM replies WHERE ticket_id = ? ORDER BY rowid`,
    ).all(ticketId) as { id: string; channel: string; status: string; created_at: string }[]
    return rows.map(row => ({
      id: row.id,
      channel: row.channel,
      status: row.status as ReplyRow['status'],
      createdAt: row.created_at,
    }))
  }

  enqueueOutbox(row: OutboxRow): void {
    this.assertWritable()
    this.db.prepare(
      `INSERT INTO outbox(
         id, reply_id, ticket_id, channel, thread, target, text, status,
         idempotency_key, attempts, next_attempt_at, external_id, error, created_at, sent_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)`,
    ).run(
      row.id,
      row.replyId,
      row.ticketId,
      row.channel,
      row.thread,
      JSON.stringify(row.target),
      row.text,
      row.status,
      row.idempotencyKey ?? row.replyId,
      row.attempts ?? 0,
      row.createdAt,
    )
  }

  listOutbox(status?: OutboxRow['status']): OutboxRow[] {
    const rows = (status
      ? this.db.prepare(
        `SELECT * FROM outbox WHERE status = ? ORDER BY rowid`,
      ).all(status)
      : this.db.prepare('SELECT * FROM outbox ORDER BY rowid').all()) as Record<string, string | null>[]
    return rows.map(outboxFromRow)
  }

  /** Receipt metadata for one Ticket, excluding body, target, and error fields. */
  listReceiptOutbox(
    ticketId: string,
  ): Pick<OutboxRow, 'id' | 'channel' | 'status' | 'createdAt' | 'sentAt'>[] {
    const rows = this.db.prepare(
      `SELECT id, channel, status, created_at, sent_at FROM outbox WHERE ticket_id = ? ORDER BY rowid`,
    ).all(ticketId) as {
      id: string
      channel: string
      status: string
      created_at: string
      sent_at: string | null
    }[]
    return rows.map(row => ({
      id: row.id,
      channel: row.channel,
      status: row.status as OutboxRow['status'],
      createdAt: row.created_at,
      ...(row.sent_at ? { sentAt: row.sent_at } : {}),
    }))
  }

  /** Pending rows whose backoff has elapsed. */
  listDueOutbox(now = new Date().toISOString()): OutboxRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM outbox
       WHERE status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY rowid`,
    ).all(now) as Record<string, string | null>[]
    return rows.map(outboxFromRow)
  }

  /** Atomically claim a row so two flushers cannot send it twice. */
  claimOutbox(id: string): boolean {
    this.assertWritable()
    const result = this.db.prepare(
      `UPDATE outbox SET status = 'sending' WHERE id = ? AND status = 'pending'`,
    ).run(id)
    return Number(result.changes ?? 0) > 0
  }

  markOutboxSent(id: string, externalId?: string): void {
    this.assertWritable()
    this.db.prepare(
      `UPDATE outbox SET status = 'sent', external_id = ?, sent_at = ?, next_attempt_at = NULL WHERE id = ?`,
    ).run(externalId ?? null, new Date().toISOString(), id)
  }

  /** Persist adapter progress without releasing the row while its send is active. */
  updateSendingOutboxProgress(id: string, target: Record<string, string>, externalId?: string): void {
    this.assertWritable()
    const result = this.db.prepare(
      `UPDATE outbox SET target = ?, external_id = COALESCE(?, external_id) WHERE id = ? AND status = 'sending'`,
    ).run(JSON.stringify(target), externalId ?? null, id)
    if (Number(result.changes ?? 0) !== 1) throw new Error(`outbox row ${id} is not sending`)
  }

  markOutboxRetry(id: string, error: string, nextAttemptAt: string, attempts: number): void {
    this.assertWritable()
    this.db.prepare(
      `UPDATE outbox SET status = 'pending', error = ?, next_attempt_at = ?, attempts = ? WHERE id = ?`,
    ).run(error, nextAttemptAt, attempts, id)
  }

  markOutboxFailed(id: string, error: string): void {
    this.assertWritable()
    this.db.prepare(
      `UPDATE outbox SET status = 'failed', error = ?, next_attempt_at = NULL WHERE id = ?`,
    ).run(error, id)
  }

  /** Mid-send rows after a crash: unknown outcome until the owner releases retry. */
  markSendingOutboxUnknownOutcome(): number {
    this.assertWritable()
    const result = this.db.prepare(
      `UPDATE outbox SET status = 'unknown_outcome', error = COALESCE(error, 'interrupted while sending') WHERE status = 'sending'`,
    ).run()
    return Number(result.changes ?? 0)
  }

  /** After UNKNOWN-OUTCOME approval: return rows to pending for idempotent drain. */
  requeueUnknownOutcomeOutbox(ticketId: string): number {
    this.assertWritable()
    const result = this.db.prepare(
      `UPDATE outbox SET status = 'pending', next_attempt_at = NULL WHERE status = 'unknown_outcome' AND ticket_id = ?`,
    ).run(ticketId)
    return Number(result.changes ?? 0)
  }

  /** Release only the named uncertain rows after an effect-scoped decision. */
  requeueUnknownOutcomeOutboxIds(ticketId: string, ids: readonly string[]): number {
    this.assertWritable()
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    const result = this.db.prepare(
      `UPDATE outbox
       SET status = 'pending', next_attempt_at = NULL
       WHERE status = 'unknown_outcome' AND ticket_id = ? AND id IN (${placeholders})`,
    ).run(ticketId, ...ids)
    return Number(result.changes ?? 0)
  }

  /** Record an operator's decision that an uncertain delivery already happened. */
  acknowledgeUnknownOutcomeOutboxIds(ticketId: string, ids: readonly string[]): number {
    this.assertWritable()
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    const result = this.db.prepare(
      `UPDATE outbox
       SET status = 'failed', error = 'operator acknowledged unknown outcome', next_attempt_at = NULL
       WHERE status = 'unknown_outcome' AND ticket_id = ? AND id IN (${placeholders})`,
    ).run(ticketId, ...ids)
    return Number(result.changes ?? 0)
  }

  /**
   * @deprecated Uncertain sends use `unknown_outcome`; operator must approve before requeue.
   */
  requeueSending(): number {
    this.assertWritable()
    return this.markSendingOutboxUnknownOutcome()
  }

  addSubscription(threadKey: string, ticketId: string, at: string): void {
    this.assertWritable()
    this.db.prepare(
      `INSERT INTO subscriptions(thread_key, ticket_id, created_at) VALUES(?, ?, ?)
       ON CONFLICT(thread_key, ticket_id) DO NOTHING`,
    ).run(threadKey, ticketId, at)
  }

  listSubscriptions(): { threadKey: string; ticketId: string }[] {
    const rows = this.db.prepare(
      'SELECT thread_key, ticket_id FROM subscriptions ORDER BY rowid',
    ).all() as { thread_key: string; ticket_id: string }[]
    return rows.map(row => ({ threadKey: row.thread_key, ticketId: row.ticket_id }))
  }

  putSpill(body: string, refs: readonly ObjectRef[] = []): string {
    this.assertWritable()
    const id = this.nextId('spill')
    this.db.prepare('INSERT INTO spills(id, body, refs, created_at) VALUES(?, ?, ?, ?)')
      .run(id, body, JSON.stringify(refs), new Date().toISOString())
    return id
  }

  getSpill(id: string): string | undefined {
    const row = this.db.prepare('SELECT body FROM spills WHERE id = ?').get(id) as { body: string } | undefined
    return row?.body
  }

  /** Next-hop refs for a spilled object. An unknown ref column reads as `[]`. */
  getSpillRefs(id: string): ObjectRef[] {
    const row = this.db.prepare('SELECT refs FROM spills WHERE id = ?').get(id) as { refs?: string } | undefined
    if (!row?.refs) return []
    try {
      const parsed: unknown = JSON.parse(row.refs)
      return Array.isArray(parsed) ? parsed as ObjectRef[] : []
    } catch {
      return []
    }
  }

  /** Upsert a spill by id. Used by long-term memory so a ticket keeps one stable body. */
  replaceSpill(id: string, body: string, refs?: readonly ObjectRef[]): void {
    this.assertWritable()
    if (refs === undefined) {
      this.db.prepare(
        `INSERT INTO spills(id, body, refs, created_at) VALUES(?, ?, '[]', ?)
         ON CONFLICT(id) DO UPDATE SET body = excluded.body`,
      ).run(id, body, new Date().toISOString())
      return
    }
    this.db.prepare(
      `INSERT INTO spills(id, body, refs, created_at) VALUES(?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET body = excluded.body, refs = excluded.refs`,
    ).run(id, body, JSON.stringify(refs), new Date().toISOString())
  }

  /** Delete a spill body and every grant that pointed at it, in one transaction. */
  deleteSpill(id: string): void {
    this.assertWritable()
    this.atomic(() => {
      this.db.prepare('DELETE FROM spill_grants WHERE spill_id = ?').run(id)
      this.db.prepare('DELETE FROM spills WHERE id = ?').run(id)
    })
  }

  grantSpill(spillId: string, grantee: string): void {
    this.assertWritable()
    this.db.prepare(
      'INSERT INTO spill_grants(spill_id, grantee) VALUES(?, ?) ON CONFLICT(spill_id, grantee) DO NOTHING',
    ).run(spillId, grantee)
  }

  spillGrants(spillId: string): string[] {
    const rows = this.db.prepare(
      'SELECT grantee FROM spill_grants WHERE spill_id = ? ORDER BY grantee',
    ).all(spillId) as { grantee: string }[]
    return rows.map(row => row.grantee)
  }

  createJob(input: { sessionId: string; ticketId: string; name: string }): JobRow {
    this.assertWritable()
    const row: JobRow = {
      id: this.nextId('job'),
      sessionId: input.sessionId,
      ticketId: input.ticketId,
      name: input.name,
      status: 'running',
      createdAt: new Date().toISOString(),
    }
    this.db.prepare(
      `INSERT INTO jobs(id, session_id, ticket_id, name, status, created_at, finished_at)
       VALUES(?, ?, ?, ?, ?, ?, NULL)`,
    ).run(row.id, row.sessionId, row.ticketId, row.name, row.status, row.createdAt)
    return row
  }

  completeJob(id: string, status: JobRow['status'] = 'succeeded'): void {
    this.assertWritable()
    this.db.prepare(
      "UPDATE jobs SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'",
    ).run(status, new Date().toISOString(), id)
  }

  getJob(id: string): JobRow | undefined {
    const row = this.db.prepare(
      'SELECT id, session_id, ticket_id, name, status, created_at, finished_at FROM jobs WHERE id = ?',
    ).get(id) as Record<string, string | null> | undefined
    if (!row) return undefined
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      ticketId: String(row.ticket_id),
      name: String(row.name),
      status: row.status as JobRow['status'],
      createdAt: String(row.created_at),
      finishedAt: row.finished_at ? String(row.finished_at) : undefined,
    }
  }

  listJobs(): JobRow[] {
    const rows = this.db.prepare(
      'SELECT id, session_id, ticket_id, name, status, created_at, finished_at FROM jobs ORDER BY rowid',
    ).all() as Record<string, string | null>[]
    return rows.map(row => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      ticketId: String(row.ticket_id),
      name: String(row.name),
      status: row.status as JobRow['status'],
      createdAt: String(row.created_at),
      finishedAt: row.finished_at ? String(row.finished_at) : undefined,
    }))
  }

  upsertSession(row: SessionRow): void {
    this.assertWritable()
    this.db.prepare(
      `INSERT INTO sessions(id, role, ticket_id, status, heartbeat, created_at)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         role = excluded.role,
         ticket_id = excluded.ticket_id,
         status = excluded.status,
         heartbeat = excluded.heartbeat`,
    ).run(row.id, row.role, row.ticketId ?? null, row.status, row.heartbeat, row.createdAt)
  }

  listSessions(): SessionRow[] {
    const rows = this.db.prepare(
      'SELECT id, role, ticket_id, status, heartbeat, created_at FROM sessions ORDER BY rowid',
    ).all() as Record<string, string | null>[]
    return rows.map(row => ({
      id: String(row.id),
      role: row.role as SessionRow['role'],
      ticketId: row.ticket_id ? String(row.ticket_id) : undefined,
      status: row.status as SessionRow['status'],
      heartbeat: String(row.heartbeat),
      createdAt: String(row.created_at),
    }))
  }

  getSessionIdentity(id: string): Pick<SessionRow, 'role' | 'ticketId'> | undefined {
    const row = this.db.prepare('SELECT role, ticket_id FROM sessions WHERE id = ?').get(id)
    return row && { role: row.role as SessionRow['role'], ticketId: row.ticket_id ? String(row.ticket_id) : undefined }
  }

  listIdleMemorySessions(after: number, idleBefore: string, limit: number): (SessionRow & { cursor: number })[] {
    const rows = this.db.prepare(`
      SELECT rowid AS cursor, id, role, ticket_id AS ticketId, status, heartbeat, created_at AS createdAt
      FROM sessions
      WHERE rowid > ? AND status = 'idle' AND heartbeat <= ?
        AND (role = 'worker' OR (role = 'router' AND id GLOB 'router:thread:*'))
      ORDER BY rowid LIMIT ?
    `).all(after, idleBefore, limit)
    return rows.map(row => ({
      cursor: Number(row.cursor),
      id: String(row.id),
      role: row.role as SessionRow['role'],
      ticketId: row.ticketId ? String(row.ticketId) : undefined,
      status: 'idle',
      heartbeat: String(row.heartbeat),
      createdAt: String(row.createdAt),
    }))
  }

  getSessionHeartbeat(sessionId: string): { status: string; heartbeat: string } | undefined {
    return this.db.prepare('SELECT status, heartbeat FROM sessions WHERE id = ?')
      .get(sessionId) as { status: string; heartbeat: string } | undefined
  }

  appendMessage(sessionId: string, role: string, body: string): void {
    this.assertWritable()
    this.db.prepare(
      'INSERT INTO messages(session_id, role, body, created_at) VALUES(?, ?, ?, ?)',
    ).run(sessionId, role, body, new Date().toISOString())
  }

  listMessages(sessionId?: string): { sessionId: string; role: string; body: string }[] {
    const rows = (sessionId
      ? this.db.prepare(
        'SELECT session_id, role, body FROM messages WHERE session_id = ? ORDER BY id',
      ).all(sessionId)
      : this.db.prepare(
        'SELECT session_id, role, body FROM messages ORDER BY id',
      ).all()) as { session_id: string; role: string; body: string }[]
    return rows.map(row => ({ sessionId: row.session_id, role: row.role, body: row.body }))
  }

  /** Recent evidence candidates. A row id remains stable across appends and reopen. */
  listTranscriptPage(
    sessionId: string,
    before: number,
    limit: number,
  ): { id: number; role: string; body: string | null; createdAt: string }[] {
    return this.db.prepare(`
      SELECT id, role, created_at AS createdAt,
        CASE WHEN length(CAST(body AS BLOB)) <= 65536 THEN body END AS body
      FROM messages
      WHERE session_id = ? AND id < ? AND role IN ('user', 'assistant')
      ORDER BY id DESC LIMIT ?
    `).all(sessionId, before, limit) as { id: number; role: string; body: string | null; createdAt: string }[]
  }

  getTranscriptEvidence(sessionId: string, id: number): { id: number; role: string; body: string | null; createdAt: string } | undefined {
    return this.db.prepare(`
      SELECT id, role, created_at AS createdAt,
        CASE WHEN length(CAST(body AS BLOB)) <= 65536 THEN body END AS body
      FROM messages WHERE session_id = ? AND id = ? AND role IN ('user', 'assistant')
    `).get(sessionId, id) as { id: number; role: string; body: string | null; createdAt: string } | undefined
  }

  /** Recheck both participants against the same snapshot of current ticket membership. */
  listSharedTranscriptPage(
    caller: string,
    threadKeys: string[],
    before: number,
    limit: number,
    ref?: { sessionId?: string; id: number },
  ): { sessionId: string; id: number; role: string; body: string | null; createdAt: string }[] {
    const keys = JSON.stringify(threadKeys)
    const filter = ref ? 'AND message.id = ?' : 'AND message.id < ?'
    const source = ref?.sessionId === undefined ? '' : 'AND message.session_id = ?'
    const bounds = ref?.sessionId === undefined ? [ref?.id ?? before] : [ref.id, ref.sessionId]
    return this.db.prepare(`
      WITH eligible AS (
        SELECT session.id
        FROM sessions AS session
        JOIN documents AS ticket ON ticket.kind = 'ticket' AND ticket.id = session.ticket_id
        WHERE session.role = 'worker' AND session.id = 'worker_' || session.ticket_id
          AND COALESCE(json_extract(ticket.payload, '$.speculative'), 0) = 0
          AND COALESCE(json_extract(ticket.payload, '$.ended.silent'), 0) = 0
          AND json_type(ticket.payload, '$.threadKeys') = 'array'
          AND json_type(ticket.payload, '$.memoryThreadKeys') = 'array'
          AND (SELECT COUNT(DISTINCT value) FROM json_each(ticket.payload, '$.threadKeys')) = json_array_length(?)
          AND (SELECT COUNT(DISTINCT value) FROM json_each(ticket.payload, '$.memoryThreadKeys')) = json_array_length(?)
          AND NOT EXISTS (SELECT value FROM json_each(ticket.payload, '$.threadKeys') EXCEPT SELECT value FROM json_each(?))
          AND NOT EXISTS (SELECT value FROM json_each(ticket.payload, '$.memoryThreadKeys') EXCEPT SELECT value FROM json_each(?))
      )
      SELECT message.session_id AS sessionId, message.id, message.role, message.created_at AS createdAt,
        CASE WHEN length(CAST(message.body AS BLOB)) <= 65536 THEN message.body END AS body
      FROM messages AS message
      JOIN eligible AS author ON author.id = message.session_id
      WHERE message.role = 'user' AND EXISTS (SELECT 1 FROM eligible WHERE id = ?) ${filter} ${source}
      ORDER BY message.id DESC LIMIT ?
    `).all(keys, keys, keys, keys, caller, ...bounds, limit) as {
      sessionId: string; id: number; role: string; body: string | null; createdAt: string;
    }[]
  }

  /** Oldest unprocessed sibling row in an exact shared Worker scope. */
  earliestMemorySibling(
    sessionId: string, threadKeys: string[], idleBefore: string, after: number, before: number,
  ): number | undefined {
    const keys = JSON.stringify(threadKeys)
    const row = this.db.prepare(`
      SELECT message.id
      FROM messages AS message
      JOIN sessions AS session ON session.id = message.session_id
      JOIN documents AS ticket ON ticket.kind = 'ticket' AND ticket.id = session.ticket_id
      LEFT JOIN documents AS progress ON progress.kind = 'memory_dream_progress' AND progress.id = session.id
      WHERE message.id > ? AND message.id <= ? AND message.session_id != ? AND message.role = 'user'
        AND session.role = 'worker' AND session.status = 'idle' AND session.heartbeat <= ?
        AND session.id = 'worker_' || session.ticket_id
        AND COALESCE(json_extract(ticket.payload, '$.speculative'), 0) = 0
        AND COALESCE(json_extract(ticket.payload, '$.ended.silent'), 0) = 0
        AND message.id > COALESCE(json_extract(progress.payload, '$.through'), 0)
        AND (SELECT COUNT(DISTINCT value) FROM json_each(ticket.payload, '$.threadKeys')) = json_array_length(?)
        AND (SELECT COUNT(DISTINCT value) FROM json_each(ticket.payload, '$.memoryThreadKeys')) = json_array_length(?)
        AND NOT EXISTS (SELECT value FROM json_each(ticket.payload, '$.threadKeys') EXCEPT SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT value FROM json_each(ticket.payload, '$.memoryThreadKeys') EXCEPT SELECT value FROM json_each(?))
      ORDER BY message.id LIMIT 1
    `).get(after, before, sessionId, idleBefore, keys, keys, keys, keys)
    return row ? Number(row.id) : undefined
  }

  /** Forward cursor for bounded background consolidation. */
  listTranscriptAfter(
    sessionId: string, after: number, limit: number,
  ): { id: number; body: string | null }[] {
    return this.db.prepare(`
      SELECT id, CASE WHEN length(CAST(body AS BLOB)) <= 65536 THEN body END AS body
      FROM messages
      WHERE session_id = ? AND id > ? AND role = 'user'
      ORDER BY id LIMIT ?
    `).all(sessionId, after, limit) as { id: number; body: string | null }[]
  }

  addArtifact(ticketId: string, filePath: string): string {
    this.assertWritable()
    const id = this.nextId('art')
    this.db.prepare(
      'INSERT INTO artifacts(id, ticket_id, path, created_at) VALUES(?, ?, ?, ?)',
    ).run(id, ticketId, filePath, new Date().toISOString())
    return id
  }
}

function outboxFromRow(row: Record<string, string | null>): OutboxRow {
  return {
    id: String(row.id),
    replyId: String(row.reply_id),
    ticketId: String(row.ticket_id),
    channel: String(row.channel),
    thread: String(row.thread),
    target: JSON.parse(String(row.target)) as Record<string, string>,
    text: String(row.text),
    status: row.status as OutboxRow['status'],
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
    attempts: row.attempts == null ? 0 : Number(row.attempts),
    nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : undefined,
    externalId: row.external_id ? String(row.external_id) : undefined,
    error: row.error ? String(row.error) : undefined,
    createdAt: String(row.created_at),
    sentAt: row.sent_at ? String(row.sent_at) : undefined,
  }
}
