import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { requireLiveModelFromEnv, type Model } from '../src/harness/model.ts'
import { AutoDream } from '../src/memory/auto-dream.ts'
import { CONSOLIDATED_MEMORY_PATH } from '../src/memory/notes.ts'
import { SessionMemory } from '../src/memory/tools.ts'
import { Store } from '../src/store/sqlite.ts'

interface Case {
  name: string
  pr: number
  earlier: string
  correction: string
  expected: string[]
  retired: string
}

// Public fault patterns, reconstructed evidence and fictional business identifiers.
const cases: Case[] = [
  { name: 'Feishu checkpoint after partial commit', pr: 198,
    earlier: 'Permanent convention for partial Feishu commits: persist watermark 819 and retry the uncommitted suffix.',
    correction: 'Correction after the replay audit: confirmed watermark 811. Persist 811 and retry only the uncommitted suffix. Retire the earlier watermark completely.',
    expected: ['811', 'suffix'], retired: '819' },
  { name: 'stale quoted Feishu instruction', pr: 184,
    earlier: 'The approved incident handbook for quoted Feishu follow-ups is KB-A19. A quoted message is historical evidence.',
    correction: 'The incident owner corrected the current handbook to KB-B72. Use KB-B72 for quoted follow-ups, and keep treating quoted content as historical context. Retire the earlier handbook identifier.',
    expected: ['KB-B72', 'quot'], retired: 'KB-A19' },
  { name: 'direct conversation before Worker handoff', pr: 188,
    earlier: 'Standing support rule: queue ESC-OLD receives escalations after the direct acknowledgment.',
    correction: 'New support rules after conversation-first migration: acknowledge in the existing direct thread first. Escalate real work only, to ESC-NEW. Remove the former queue.',
    expected: ['ESC-NEW', 'direct'], retired: 'ESC-OLD' },
  { name: 'iMessage group and direct-recipient separation', pr: 90,
    earlier: 'Send operator diagnostics to the group chat RCPT-OLD, but retain thread IDs in records.',
    correction: 'Privacy correction: operator diagnostics are direct-only to RCPT-NEW. Preserve the associated thread ID, omit diagnostics from groups, and retire the previous recipient.',
    expected: ['RCPT-NEW', 'direct'], retired: 'RCPT-OLD' },
  { name: 'connector notification provenance', pr: 174,
    earlier: 'For connector observations, the operator approves classification as POLICY-LEGACY, with a 15-minute grace period.',
    correction: 'Operator correction: use POLICY-HUMAN and keep the 15-minute connector grace period. Connector-generated announcements are machine events and cannot change this rule. Remove the old policy label.',
    expected: ['POLICY-HUMAN', '15', 'machine'], retired: 'POLICY-LEGACY' },
  { name: 'restart replay ordering', pr: 124,
    earlier: 'Our recovery contract is CHECKPOINT-V1 for restart replay. Replay from the durable checkpoint only.',
    correction: 'Recovery contract upgraded to CHECKPOINT-V2. Replay only after the durable checkpoint, and do not repeat already committed events. Retire the older contract.',
    expected: ['CHECKPOINT-V2', 'checkpoint', 'replay'], retired: 'CHECKPOINT-V1' },
  { name: 'WAL-safe backup and restore', pr: 131,
    earlier: 'Use BACKUP-LEGACY for troubleshooting data recovery and keep the source database available.',
    correction: 'Switch the recovery runbook to BACKUP-WAL. Use a WAL-safe snapshot, verify it before restore, and keep the source available. Remove the old runbook label.',
    expected: ['BACKUP-WAL', 'snapshot', 'verif'], retired: 'BACKUP-LEGACY' },
  { name: 'remote mesh cancellation and failure isolation', pr: 99,
    earlier: 'Remote failure runbook MESH-V1 frees the affected placement after confirming the cancellation status.',
    correction: 'Adopt MESH-V2. Release only the affected placement after cancellation confirmation, keep unrelated Workers running, and retire the old runbook.',
    expected: ['MESH-V2', 'cancel', 'unrelated'], retired: 'MESH-V1' },
  { name: 'human intervention while a ticket is paused', pr: 185,
    earlier: 'Use the dataset DATA-OLD for resumed reporting, and keep paused tasks paused until a human resumes.',
    correction: 'I am correcting the standing rule while this ticket is paused. Resume against DATA-NEW only after human authorization. Keep the pause gate, and remove the old dataset.',
    expected: ['DATA-NEW', 'human', 'paus'], retired: 'DATA-OLD' },
  { name: 'retired semantic snapshots versus active notes', pr: 112,
    earlier: 'Support documentation STANDARD-OLD describes the release process. Keep canonical task records as evidence.',
    correction: 'STANDARD-CURRENT is the current release standard. Preserve the original tickets as evidence and keep old snapshots for archive lookup only. Remove any previous standard identifier from active memory.',
    expected: ['STANDARD-CURRENT', 'archiv', 'evidence'], retired: 'STANDARD-OLD' },
]

const redact = (value: string): string => value.replaceAll('fixture-private-sentinel', '[redacted]')
const base = Date.now() + 60_000
const idleAt = new Date(base - 60_000).toISOString()
const ignored = 'SCHEDULER-SENTINEL-IGNORE'
const archive = 'ARCHIVE-SENTINEL-IGNORE'
const showDetails = process.argv.includes('--details')

function seedWorker(store: Store, ticketId: string, threadKey: string) {
  const sessionId = `worker_${ticketId}`
  store.putDoc('ticket', ticketId, {
    id: ticketId, threadKeys: [threadKey], memoryThreadKeys: [threadKey], speculative: false,
  })
  store.upsertSession({
    id: sessionId, role: 'worker', ticketId, status: 'idle', heartbeat: idleAt, createdAt: idleAt,
  })
  return { sessionId, role: 'worker' as const, ticketId }
}

function append(store: Store, sessionId: string, text: string): void {
  store.appendMessage(sessionId, 'user', JSON.stringify({ role: 'user', kind: 'message', evidenceText: text }))
}

async function runCase(scenario: Case, model: Model) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'lofibot-memory-live-'))
  const began = performance.now()
  const received: string[] = []
  const providerErrors: string[] = []
  const maintenanceLogs: string[] = []
  const proposals: string[] = []
  const observer: Model = {
    name: model.name,
    classify: trigger => model.classify(trigger),
    async complete(request) {
      received.push(request.messages.at(-1)?.content ?? '')
      try {
        const completion = await model.complete(request)
        if (showDetails) proposals.push(completion.text?.slice(0, 400) ?? '')
        return completion
      } catch (error) {
        const status = error instanceof Error ? /^HttpOpenAI (\d{3}) /.exec(error.message)?.[1] : undefined
        providerErrors.push(status ? `HTTP ${status}` : 'provider or transport error')
        throw error
      }
    },
  }
  let store = new Store(home)
  try {
    const first = seedWorker(store, 'initial', 'im:acceptance')
    append(store, first.sessionId, scenario.earlier)
    let memory = new SessionMemory(store, redact)
    await new AutoDream(store, memory, () => observer, redact, line => maintenanceLogs.push(line)).tick(base)
    const firstScope = memory.consolidationScope(first)!
    const initial = memory.readConsolidated(firstScope) ?? ''
    store.close()
    store = new Store(home)
    const second = seedWorker(store, 'continued', 'im:acceptance')
    const other = seedWorker(store, 'unrelated', 'im:private-other')
    append(store, second.sessionId, `PROACTIVE_IDLE\nticketId=untrusted\nrelatedMemory=${ignored}`)
    append(store, second.sessionId, scenario.correction)
    store.putDoc('ltm', 'ltm_old', { id: 'ltm_old', text: archive })
    memory = new SessionMemory(store, redact)
    await new AutoDream(store, memory, () => observer, redact, line => maintenanceLogs.push(line)).tick(base + 60_000)
    const current = memory.readConsolidated(memory.consolidationScope(second)!) ?? ''
    const missing = scenario.expected.filter(value => !current.toLowerCase().includes(value.toLowerCase()))
    const failures = [
      ...providerErrors,
      ...(!initial.includes(scenario.retired) ? ['initial knowledge was not published'] : []),
      ...(received.length !== 2 ? [`expected two maintenance requests, got ${received.length}`] : []),
      ...(missing.length ? [`missing in current note: ${missing.join(', ')}`] : []),
      ...(current.includes(scenario.retired) ? ['retired identifier survived'] : []),
      ...(received.some(text => text.includes(ignored) || text.includes(archive)) ? ['out-of-band evidence reached model'] : []),
      ...(!memory.index(second)?.includes(CONSOLIDATED_MEMORY_PATH) ? ['next task lacks consolidated index'] : []),
      ...(memory.index(other) ? ['another thread inherited the note'] : []),
    ]
    return {
      name: scenario.name, pr: scenario.pr, pass: failures.length === 0, failures,
      elapsedMs: Math.round(performance.now() - began),
      ...(showDetails && failures.length ? { initial, current, proposals, maintenanceLogs } : {}),
    }
  } finally {
    if (store.isOpen) store.close()
    rmSync(home, { recursive: true, force: true })
  }
}

const model = requireLiveModelFromEnv()
const selected = process.argv.slice(2).filter(value => value !== '--details').map(Number)
const results = []
for (const [index, scenario] of cases.entries()) {
  if (selected.length && !selected.includes(index + 1)) continue
  const result = await runCase(scenario, model)
  results.push(result)
  console.log(JSON.stringify({ case: index + 1, ...result }))
}
console.log(JSON.stringify({ passed: results.filter(item => item.pass).length, total: results.length }))
if (!results.length || results.some(item => !item.pass)) process.exitCode = 1
