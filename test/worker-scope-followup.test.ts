import { afterEach, describe, expect, it, vi } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import { isConversationTicket } from '../src/core/conversation.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket, Trigger } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { field, lastPrompt, ScriptedModel, silentModel } from './scripted-model.ts'

const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
})

function start(model?: ScriptedModel, extraEnv: NodeJS.ProcessEnv = {}): Runtime {
  const runtime = freshRuntime({
    model: model ?? silentModel(),
    env: { ...process.env, LOFIBOT_ALLOW_MOCK_FIXTURE: '1', ...extraEnv },
    jobDelayMs: 5,
    watchdogIntervalMs: 60_000,
  })
  runtime.start({ assessPending: false })
  runtimes.push(runtime)
  return runtime
}

const scopeA = 'extract and list the three acceptance points from issue #192'
const scopeB = 'paste the three acceptance points verbatim from issue #192 body'

function issue192Fixture(runtime: Runtime, triggerId: string) {
  const trigger = imTrigger({
    id: triggerId,
    thread: 'github/issue-192',
    text: '重新测一下这个',
  })
  runtime.engine.receive(trigger)
  return runtime.engine.decide(triggerId, {
    kind: 'accept',
    title: '重测只读读取 GitHub 工单 #192',
    scope: scopeA,
    strength: 'explicit',
    reason: 'router-dispatch',
  })
}

function directTrigger(id: string): Trigger {
  const trigger = imTrigger({ id, thread: 'feishu:oc_p2p', text: '重新测一下这个' })
  trigger.addressed = 'direct'
  trigger.channel!.address = { provider: 'feishu', chat_type: 'p2p' }
  return trigger
}

function dispatchModel(
  prompts: string[],
  gateTask?: Promise<void>,
  scopeForDispatch: () => string = () => scopeA,
  redispatch?: { value: boolean },
  gateFollowup?: Promise<void>,
  reportFollowups = true,
  reportTasks = true,
  gateResume?: Promise<void>,
  reportResumes = true,
  taskReportKind: 'ready' | 'failed' | 'blocked' | 'waiting' | 'dropped' = 'ready',
): ScriptedModel {
  const reportedWorkerPrompts = new Set<string>()
  return new ScriptedModel(async request => {
    const prompt = lastPrompt(request)
    if (request.role === 'worker') {
      if (!prompts.includes(prompt)) prompts.push(prompt)
      if (prompt.startsWith('TASK') && gateTask) await gateTask
      if (prompt.startsWith('FOLLOWUP') && gateFollowup) await gateFollowup
      if (prompt.startsWith('RESUME') && gateResume) await gateResume
      if (prompt.startsWith('FOLLOWUP') && !reportFollowups) return { text: 'finished follow-up' }
      if (prompt.startsWith('TASK') && !reportTasks) return { text: 'task turn finished' }
      if (prompt.startsWith('RESUME') && !reportResumes) return { text: 'resume turn finished' }
      if (!reportedWorkerPrompts.has(prompt)) {
        reportedWorkerPrompts.add(prompt)
        return {
          toolCalls: [{
            id: 'report-ready',
            name: 'report_to_router',
            args: {
              ticketId: field(prompt, 'ticketId'),
              text: 'done under the active mandate',
              deliver: true,
              kind: prompt.startsWith('TASK') && prompts.filter(item => item.startsWith('TASK')).length === 1
                ? taskReportKind
                : 'ready',
            },
          }],
        }
      }
      return { text: 'finished' }
    }
    if (request.role !== 'router' || !prompt.startsWith('CONVERSATION_INBOUND')) return { text: 'ok' }
    if (redispatch?.value) {
      redispatch.value = false
      return {
        toolCalls: [{
          id: 'redispatch-work',
          name: 'dispatch_work',
          args: {
            triggerId: field(prompt, 'triggerId'),
            conversationTicketId: field(prompt, 'conversationTicketId'),
            title: '重测只读读取 GitHub 工单 #192',
            scope: scopeForDispatch(),
            thread: 'im:feishu:oc_p2p',
          },
        }],
      }
    }
    const replied = request.messages.some(m => m.role === 'tool' && m.name === 'reply_user')
    if (!replied) {
      return {
        toolCalls: [{
          id: 'reply-first',
          name: 'reply_user',
          args: {
            ticketId: field(prompt, 'conversationTicketId'),
            text: '我来处理这个问题。',
            purpose: 'progress',
          },
        }],
      }
    }
    const dispatched = request.messages.some(m => m.role === 'tool' && m.name === 'dispatch_work')
    if (!dispatched) {
      return {
        toolCalls: [{
          id: `dispatch-${prompts.length}-${request.messages.length}`,
          name: 'dispatch_work',
          args: {
            triggerId: field(prompt, 'triggerId'),
            conversationTicketId: field(prompt, 'conversationTicketId'),
            title: '重测只读读取 GitHub 工单 #192',
            scope: scopeForDispatch(),
            thread: 'im:feishu:oc_p2p',
          },
        }],
      }
    }
    return { text: 'done' }
  })
}

async function dispatchAgain(
  runtime: Runtime,
  triggerId: string,
  envelopeId: string,
  redispatch: { value: boolean },
): Promise<void> {
  redispatch.value = true
  const envelope = runtime.store.getDoc<Ticket>('ticket', envelopeId)!
  const trigger = runtime.store.getDoc<Trigger>('trigger', triggerId)!
  await runtime.harness.conversationTurn(envelope, trigger)
}

describe('worker mandate scope', () => {
  it('includes mandate.scope in TASK worker prompt', async () => {
    const prompts: string[] = []
    const runtime = start(new ScriptedModel(request => {
      const prompt = lastPrompt(request)
      if (request.role === 'worker') prompts.push(prompt)
      if (request.role === 'router') return { text: 'ok' }
      const reported = request.messages.some(m => m.role === 'tool' && m.name === 'report_to_router')
      if (!reported) {
        return {
          toolCalls: [{
            id: 'r1',
            name: 'report_to_router',
            args: {
              ticketId: field(prompt, 'ticketId'),
              text: 'progress',
              deliver: false,
              kind: 'progress',
            },
          }],
        }
      }
      return { text: 'done' }
    }))

    const decision = issue192Fixture(runtime, 'trg_scope_task')
    const ticket = runtime.store.getDoc<Ticket>('ticket', decision.ticketId!)!
    expect(ticket.brief).toBe('重新测一下这个')
    await runtime.harness.launch(ticket)
    await runtime.jobsSettled()

    const task = prompts.find(p => p.startsWith('TASK'))
    expect(task).toBeDefined()
    expect(task).toContain(`title=${ticket.title}`)
    expect(task).toContain(`brief=${ticket.brief}`)
    expect(task).toContain(`scope=${scopeA}`)
    expect(task!.split('\n').find(line => line.startsWith('brief='))?.slice('brief='.length)).toBe('重新测一下这个')
  })

  it('includes mandate.scope in RESUME worker prompt', async () => {
    const prompts: string[] = []
    const runtime = start(new ScriptedModel(request => {
      if (request.role === 'worker') prompts.push(lastPrompt(request))
      return { text: 'ok' }
    }))
    const decision = issue192Fixture(runtime, 'trg_resume_scope')
    const ticketId = decision.ticketId!
    const ticket = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    runtime.engine.assignmentStarted(ticketId, ticket.assignments[0]!.id, `worker_${ticketId}`)
    ticket.assignments[0]!.state = 'running'
    runtime.store.putDoc('ticket', ticketId, ticket)
    runtime.engine.pause(ticketId, { reason: 'test pause' })
    await runtime.resume(ticketId, { reason: 'human verified' })
    await runtime.jobsSettled()
    const resume = prompts.find(p => p.startsWith('RESUME'))
    expect(resume).toBeDefined()
    expect(resume).toContain(`scope=${scopeA}`)
  })

  it('activates a revised mandate before a paused running assignment resumes', async () => {
    const prompts: string[] = []
    const reported = new Set<string>()
    const runtime = start(new ScriptedModel(request => {
      const prompt = lastPrompt(request)
      if (request.role !== 'worker') return { text: 'ok' }
      prompts.push(prompt)
      if (reported.has(prompt)) return { text: 'finished' }
      reported.add(prompt)
      return {
        toolCalls: [{
          id: 'resume-ready',
          name: 'report_to_router',
          args: {
            ticketId: field(prompt, 'ticketId'),
            text: 'done under the resumed mandate',
            deliver: true,
            kind: 'ready',
          },
        }],
      }
    }))
    const triggerId = 'trg_resume_revised_scope'
    const decision = issue192Fixture(runtime, triggerId)
    const ticketId = decision.ticketId!
    const ticket = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    runtime.engine.assignmentStarted(ticketId, ticket.assignments[0]!.id, `worker_${ticketId}`)
    runtime.engine.pause(ticketId, { reason: 'test pause' })
    runtime.engine.decide(triggerId, {
      kind: 'accept',
      title: '重测只读读取 GitHub 工单 #192',
      scope: scopeB,
      strength: 'explicit',
      reason: 'router-dispatch',
    })

    await runtime.resume(ticketId, { reason: 'human verified' })
    await runtime.jobsSettled()

    const resume = prompts.find(prompt => prompt.startsWith('RESUME'))
    expect(resume).toBeDefined()
    expect(resume).toContain(`scope=${scopeB}`)
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended?.outcome).toBe('ready')
    expect(runtime.log.text()).not.toContain('kept ticket open for revised mandate')
  })

  it('builds a FOLLOWUP prompt from the ticket after mandate activation', async () => {
    const prompts: string[] = []
    const runtime = start(new ScriptedModel(request => {
      const prompt = lastPrompt(request)
      if (request.role !== 'worker') return { text: 'finished' }
      prompts.push(prompt)
      if (!prompt.startsWith('FOLLOWUP')) return { text: 'task turn finished' }
      return {
        toolCalls: [{
          id: 'followup-ready',
          name: 'report_to_router',
          args: {
            ticketId: field(prompt, 'ticketId'),
            text: 'done under the active mandate',
            deliver: true,
            kind: 'ready',
          },
        }],
      }
    }))
    const decision = issue192Fixture(runtime, 'trg_followup_revised_scope')
    const ticketId = decision.ticketId!
    const ticket = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    runtime.engine.assignmentStarted(ticketId, ticket.assignments[0]!.id, `worker_${ticketId}`)

    const activateMandate = runtime.engine.assignmentMandateActivated.bind(runtime.engine)
    runtime.engine.assignmentMandateActivated = id => {
      const live = runtime.store.getDoc<Ticket>('ticket', id)!
      live.mandate.scope = scopeB
      runtime.store.putDoc('ticket', id, live)
      activateMandate(id)
    }

    await runtime.harness.deliver(ticketId, imTrigger({
      id: 'trg_followup_direct',
      thread: 'github/issue-192',
      text: '重新测一下这个',
    }))
    await runtime.jobsSettled()

    const followup = prompts.find(prompt => prompt.startsWith('FOLLOWUP'))
    expect(followup).toBeDefined()
    expect(followup).toContain(`scope=${scopeB}`)
    const latest = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    expect(latest.assignments.at(-1)?.mandateScopeAtStart).toBe(scopeB)
    expect(latest.ended?.outcome).toBe('ready')
    expect(runtime.log.text()).not.toContain('kept ticket open for revised mandate')
  })

  it('delivers a revised scope during a local RESUME Worker turn', async () => {
    const prompts: string[] = []
    let releaseResume!: () => void
    const resumeGate = new Promise<void>(resolve => { releaseResume = resolve })
    let scope = scopeA
    const redispatch = { value: false }
    const runtime = start(dispatchModel(
      prompts, undefined, () => scope, redispatch, undefined, true, false, resumeGate, false,
    ))
    const triggerId = 'trg_resume_followup_active'
    runtime.ingest(directTrigger(triggerId))
    await vi.waitFor(() => expect(prompts.some(prompt => prompt.startsWith('TASK'))).toBe(true))
    await runtime.jobsSettled()
    const envelope = runtime.store.listDocs<Ticket>('ticket').find(isConversationTicket)!
    const ticketId = runtime.store.listDocs<Ticket>('ticket').find(ticket => !isConversationTicket(ticket))!.id
    runtime.engine.pause(ticketId, { reason: 'test pause' })

    const resuming = runtime.resume(ticketId, { reason: 'human verified' })
    await vi.waitFor(() => expect(prompts.some(prompt => prompt.startsWith('RESUME'))).toBe(true))
    expect(runtime.harness.workerActive(ticketId)).toBe(true)
    scope = scopeB
    await dispatchAgain(runtime, triggerId, envelope.id, redispatch)
    expect(runtime.harness.workerActive(ticketId)).toBe(true)
    releaseResume()
    await resuming
    await runtime.jobsSettled()

    const followup = prompts.find(prompt => prompt.startsWith('FOLLOWUP'))
    expect(followup).toContain(`scope=${scopeB}`)
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended?.outcome).toBe('ready')
  })

  it('re-dispatch with a new scope reaches the active worker through dispatch_work', async () => {
    const prompts: string[] = []
    let releaseWorker!: () => void
    const gate = new Promise<void>(resolve => { releaseWorker = resolve })
    let scope = scopeA
    const redispatch = { value: false }
    const runtime = start(dispatchModel(prompts, gate, () => scope, redispatch))
    runtime.ingest(directTrigger('trg_redispatch'))
    await vi.waitFor(() => expect(prompts.some(p => p.startsWith('TASK'))).toBe(true))
    const envelope = runtime.store.listDocs<Ticket>('ticket').find(isConversationTicket)!
    const task = prompts.find(p => p.startsWith('TASK'))!
    const ticketId = runtime.store.listDocs<Ticket>('ticket').find(t => !isConversationTicket(t))!.id
    expect(runtime.harness.workerActive(ticketId)).toBe(true)
    expect(task).toContain(`scope=${scopeA}`)

    scope = scopeB
    await dispatchAgain(runtime, 'trg_redispatch', envelope.id, redispatch)
    const work = runtime.store.listDocs<Ticket>('ticket').find(t => !isConversationTicket(t))!
    expect(work.mandate.scope).toBe(scopeB)
    releaseWorker()
    await runtime.jobsSettled()

    const followup = prompts.find(p => p.startsWith('FOLLOWUP'))
    expect(followup).toBeDefined()
    expect(followup).toContain(`scope=${scopeB}`)
    expect(runtime.log.text()).toContain('Evals.decide remandate')
    const workerStarts = runtime.log.text().match(/ExecutorSession start session=worker_/g) ?? []
    expect(workerStarts).toHaveLength(1)
  })

  it('keeps queued and running FOLLOWUP turns active after the original TASK settles', async () => {
    const prompts: string[] = []
    let releaseTask!: () => void
    const taskGate = new Promise<void>(resolve => { releaseTask = resolve })
    let releaseFollowup!: () => void
    const followupGate = new Promise<void>(resolve => { releaseFollowup = resolve })
    let scope = scopeA
    const redispatch = { value: false }
    const runtime = start(dispatchModel(prompts, taskGate, () => scope, redispatch, followupGate, false))
    runtime.ingest(directTrigger('trg_followup_active'))
    await vi.waitFor(() => expect(prompts.some(prompt => prompt.startsWith('TASK'))).toBe(true))
    const envelope = runtime.store.listDocs<Ticket>('ticket').find(isConversationTicket)!
    const ticketId = runtime.store.listDocs<Ticket>('ticket').find(ticket => !isConversationTicket(ticket))!.id

    scope = scopeB
    await dispatchAgain(runtime, 'trg_followup_active', envelope.id, redispatch)
    releaseTask()
    await vi.waitFor(() => expect(prompts.some(prompt => prompt.startsWith('FOLLOWUP'))).toBe(true))
    expect(runtime.harness.workerActive(ticketId)).toBe(true)

    scope = 'verify the revised acceptance points from issue #192'
    await dispatchAgain(runtime, 'trg_followup_active', envelope.id, redispatch)
    expect(runtime.harness.workerActive(ticketId)).toBe(true)
    releaseFollowup()
    await vi.waitFor(() => expect(prompts.filter(prompt => prompt.startsWith('FOLLOWUP'))).toHaveLength(2))
    await runtime.jobsSettled()

    const followups = prompts.filter(prompt => prompt.startsWith('FOLLOWUP'))
    expect(followups[0]).toContain(`scope=${scopeB}`)
    expect(followups[1]).toContain(`scope=${scope}`)
    expect(prompts.filter(prompt => prompt.startsWith('TASK'))).toHaveLength(1)
  })

  it('unchanged re-dispatch skips launch while a FOLLOWUP remains active after TASK settles', async () => {
    const prompts: string[] = []
    let releaseTask!: () => void
    const taskGate = new Promise<void>(resolve => { releaseTask = resolve })
    let releaseFollowup!: () => void
    const followupGate = new Promise<void>(resolve => { releaseFollowup = resolve })
    let scope = scopeA
    const redispatch = { value: false }
    const runtime = start(dispatchModel(
      prompts, taskGate, () => scope, redispatch, followupGate,
    ))
    const triggerId = 'trg_unchanged_during_followup'
    runtime.ingest(directTrigger(triggerId))
    await vi.waitFor(() => expect(prompts.some(prompt => prompt.startsWith('TASK'))).toBe(true))
    const envelope = runtime.store.listDocs<Ticket>('ticket').find(isConversationTicket)!
    const ticketId = runtime.store.listDocs<Ticket>('ticket').find(ticket => !isConversationTicket(ticket))!.id

    scope = scopeB
    await dispatchAgain(runtime, triggerId, envelope.id, redispatch)
    releaseTask()
    await vi.waitFor(() => expect(prompts.some(prompt => prompt.startsWith('FOLLOWUP'))).toBe(true))
    await vi.waitFor(() => expect(runtime.harness.launchInFlight(ticketId)).toBe(false))
    expect(runtime.harness.workerActive(ticketId)).toBe(true)
    expect(prompts.filter(prompt => prompt.startsWith('TASK'))).toHaveLength(1)
    expect(prompts.filter(prompt => prompt.startsWith('FOLLOWUP'))).toHaveLength(1)

    const launch = vi.spyOn(runtime.harness, 'launch')
    await dispatchAgain(runtime, triggerId, envelope.id, redispatch)
    expect(launch).not.toHaveBeenCalled()
    expect(runtime.harness.workerActive(ticketId)).toBe(true)
    expect(prompts.filter(prompt => prompt.startsWith('TASK'))).toHaveLength(1)
    expect(prompts.filter(prompt => prompt.startsWith('FOLLOWUP'))).toHaveLength(1)
    expect(runtime.log.text().match(/ExecutorSession start session=worker_/g) ?? []).toHaveLength(1)

    releaseFollowup()
    await runtime.jobsSettled()
    expect(prompts.filter(prompt => prompt.startsWith('TASK'))).toHaveLength(1)
    expect(prompts.filter(prompt => prompt.startsWith('FOLLOWUP'))).toHaveLength(1)
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended?.outcome).toBe('ready')
  })

  it('re-dispatch after a local failed assignment starts a new assignment with the revised scope', async () => {
    const prompts: string[] = []
    let scope = scopeA
    const redispatch = { value: false }
    const runtime = start(dispatchModel(prompts, undefined, () => scope, redispatch, undefined, true, true, undefined, true, 'failed'))
    const triggerId = 'trg_redispatch_after_failed'
    runtime.ingest(directTrigger(triggerId))
    await vi.waitFor(() => expect(prompts.some(prompt => prompt.startsWith('TASK'))).toBe(true))
    await runtime.jobsSettled()

    const envelope = runtime.store.listDocs<Ticket>('ticket').find(isConversationTicket)!
    const ticketId = runtime.store.listDocs<Ticket>('ticket').find(ticket => !isConversationTicket(ticket))!.id
    const failedAssignment = runtime.store.getDoc<Ticket>('ticket', ticketId)!.assignments.at(-1)!
    expect(failedAssignment).toMatchObject({ state: 'ended', report: { kind: 'failed' } })
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended).toBeUndefined()

    scope = scopeB
    await dispatchAgain(runtime, triggerId, envelope.id, redispatch)
    await runtime.jobsSettled()

    const latest = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    const replacement = latest.assignments.at(-1)!
    expect(latest.assignments).toHaveLength(2)
    expect(replacement.id).not.toBe(failedAssignment.id)
    expect(failedAssignment).toMatchObject({ state: 'ended', report: { kind: 'failed' } })
    expect(prompts.some(prompt => prompt.startsWith('TASK') && prompt.includes(`scope=${scopeB}`))).toBe(true)
    expect(latest.ended?.outcome).toBe('ready')
  })

  it('direct launch leaves a locally failed assignment ended', async () => {
    const prompts: string[] = []
    const runtime = start(dispatchModel(
      prompts, undefined, () => scopeA, undefined, undefined, true, true, undefined, true, 'failed',
    ))
    runtime.ingest(directTrigger('trg_direct_launch_after_failed'))
    await vi.waitFor(() => expect(prompts.some(prompt => prompt.startsWith('TASK'))).toBe(true))
    await runtime.jobsSettled()

    const ticket = runtime.store.listDocs<Ticket>('ticket').find(item => !isConversationTicket(item))!
    const assignmentId = ticket.assignments.at(-1)!.id
    const startedBefore = runtime.store.listEvents().filter(event =>
      event.type === 'assignment.started' && (event.payload as { assignmentId?: string }).assignmentId === assignmentId,
    ).length
    expect(ticket.assignments.at(-1)).toMatchObject({ state: 'ended', report: { kind: 'failed' } })
    expect(ticket.ended).toBeUndefined()

    await runtime.harness.launch(ticket)
    await runtime.jobsSettled()

    const latest = runtime.store.getDoc<Ticket>('ticket', ticket.id)!
    expect(latest.assignments).toHaveLength(1)
    expect(latest.assignments[0]).toMatchObject({ id: assignmentId, state: 'ended', report: { kind: 'failed' } })
    expect(runtime.store.listEvents().filter(event =>
      event.type === 'assignment.started' && (event.payload as { assignmentId?: string }).assignmentId === assignmentId,
    )).toHaveLength(startedBefore)
    expect(prompts.filter(prompt => prompt.startsWith('TASK'))).toHaveLength(1)
  })

  it('assignmentStarted does not resurrect an ended assignment', () => {
    const runtime = start()
    const decision = issue192Fixture(runtime, 'trg_assignment_started_after_ended')
    const ticketId = decision.ticketId!
    const assignmentId = runtime.store.getDoc<Ticket>('ticket', ticketId)!.assignments[0]!.id
    runtime.engine.assignmentStarted(ticketId, assignmentId, `worker_${ticketId}`)
    runtime.engine.report(ticketId, { kind: 'failed', text: 'preserve this report', deliver: false })
    const ended = runtime.store.getDoc<Ticket>('ticket', ticketId)!.assignments[0]!
    const startedEvents = runtime.store.listEvents().filter(event =>
      event.type === 'assignment.started' && (event.payload as { assignmentId?: string }).assignmentId === assignmentId,
    ).length

    runtime.engine.assignmentStarted(ticketId, assignmentId, `worker_${ticketId}_again`)

    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)!.assignments[0]).toMatchObject({
      id: assignmentId,
      state: 'ended',
      report: { kind: 'failed', text: 'preserve this report' },
      workerSessionId: ended.workerSessionId,
      startedAt: ended.startedAt,
    })
    expect(runtime.store.listEvents().filter(event =>
      event.type === 'assignment.started' && (event.payload as { assignmentId?: string }).assignmentId === assignmentId,
    )).toHaveLength(startedEvents)
  })

  it('re-dispatch after a local waiting assignment starts a new assignment with the revised scope', async () => {
    const prompts: string[] = []
    let scope = scopeA
    const redispatch = { value: false }
    const runtime = start(dispatchModel(prompts, undefined, () => scope, redispatch, undefined, true, true, undefined, true, 'waiting'))
    const triggerId = 'trg_redispatch_after_waiting'
    runtime.ingest(directTrigger(triggerId))
    await vi.waitFor(() => expect(prompts.some(prompt => prompt.startsWith('TASK'))).toBe(true))
    await runtime.jobsSettled()

    const envelope = runtime.store.listDocs<Ticket>('ticket').find(isConversationTicket)!
    const ticketId = runtime.store.listDocs<Ticket>('ticket').find(ticket => !isConversationTicket(ticket))!.id
    const waitingAssignment = runtime.store.getDoc<Ticket>('ticket', ticketId)!.assignments.at(-1)!
    expect(waitingAssignment).toMatchObject({ state: 'ended', report: { kind: 'waiting' } })
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended).toBeUndefined()

    scope = scopeB
    await dispatchAgain(runtime, triggerId, envelope.id, redispatch)
    await runtime.jobsSettled()

    const latest = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    const replacement = latest.assignments.at(-1)!
    expect(latest.assignments).toHaveLength(2)
    expect(replacement.id).not.toBe(waitingAssignment.id)
    expect(waitingAssignment).toMatchObject({ state: 'ended', report: { kind: 'waiting' } })
    expect(prompts.some(prompt => prompt.startsWith('TASK') && prompt.includes(`scope=${scopeB}`))).toBe(true)
    expect(latest.ended?.outcome).toBe('ready')
  })

  it('re-dispatch after a local blocked assignment starts a new assignment with the revised scope', async () => {
    const prompts: string[] = []
    let scope = scopeA
    const redispatch = { value: false }
    const runtime = start(dispatchModel(prompts, undefined, () => scope, redispatch, undefined, true, true, undefined, true, 'blocked'))
    const triggerId = 'trg_redispatch_after_blocked'
    runtime.ingest(directTrigger(triggerId))
    await vi.waitFor(() => expect(prompts.some(prompt => prompt.startsWith('TASK'))).toBe(true))
    await runtime.jobsSettled()

    const envelope = runtime.store.listDocs<Ticket>('ticket').find(isConversationTicket)!
    const ticketId = runtime.store.listDocs<Ticket>('ticket').find(ticket => !isConversationTicket(ticket))!.id
    const blockedAssignment = runtime.store.getDoc<Ticket>('ticket', ticketId)!.assignments.at(-1)!
    expect(blockedAssignment).toMatchObject({ state: 'ended', report: { kind: 'blocked' } })
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended).toBeUndefined()

    scope = scopeB
    await dispatchAgain(runtime, triggerId, envelope.id, redispatch)
    await runtime.jobsSettled()

    const latest = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    const replacement = latest.assignments.at(-1)!
    expect(latest.assignments).toHaveLength(2)
    expect(replacement.id).not.toBe(blockedAssignment.id)
    expect(blockedAssignment).toMatchObject({ state: 'ended', report: { kind: 'blocked' } })
    expect(prompts.some(prompt => prompt.startsWith('TASK') && prompt.includes(`scope=${scopeB}`))).toBe(true)
    expect(latest.ended?.outcome).toBe('ready')
  })

  it('unchanged explicit re-dispatch after a local failed assignment starts a new assignment', async () => {
    const prompts: string[] = []
    const redispatch = { value: false }
    const runtime = start(dispatchModel(prompts, undefined, () => scopeA, redispatch, undefined, true, true, undefined, true, 'failed'))
    const triggerId = 'trg_unchanged_after_failed'
    runtime.ingest(directTrigger(triggerId))
    await vi.waitFor(() => expect(prompts.some(prompt => prompt.startsWith('TASK'))).toBe(true))
    await runtime.jobsSettled()

    const envelope = runtime.store.listDocs<Ticket>('ticket').find(isConversationTicket)!
    const ticketId = runtime.store.listDocs<Ticket>('ticket').find(ticket => !isConversationTicket(ticket))!.id
    const failedAssignment = runtime.store.getDoc<Ticket>('ticket', ticketId)!.assignments.at(-1)!
    expect(failedAssignment).toMatchObject({ state: 'ended', report: { kind: 'failed' } })
    expect(runtime.store.getDoc<Ticket>('ticket', ticketId)?.ended).toBeUndefined()

    await dispatchAgain(runtime, triggerId, envelope.id, redispatch)
    await runtime.jobsSettled()

    const latest = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    const replacement = latest.assignments.at(-1)!
    expect(latest.assignments).toHaveLength(2)
    expect(replacement.id).not.toBe(failedAssignment.id)
    expect(prompts.some(prompt => prompt.startsWith('TASK') && prompt.includes(`scope=${scopeA}`))).toBe(true)
    expect(runtime.log.text()).toContain(`Assignments.start ticketId=${ticketId} assignmentId=${replacement.id}`)
    expect(runtime.log.text().match(new RegExp(`ExecutorSession turn session=worker_${ticketId}`, 'g'))).toHaveLength(2)
  })

  it('unchanged scope re-dispatch does not enqueue an extra worker turn', async () => {
    const prompts: string[] = []
    let releaseWorker!: () => void
    const gate = new Promise<void>(resolve => { releaseWorker = resolve })
    const redispatch = { value: false }
    const runtime = start(dispatchModel(prompts, gate, () => scopeA, redispatch))
    runtime.ingest(directTrigger('trg_idem_scope'))
    await vi.waitFor(() => expect(prompts.some(p => p.startsWith('TASK'))).toBe(true))
    const envelope = runtime.store.listDocs<Ticket>('ticket').find(isConversationTicket)!
    await dispatchAgain(runtime, 'trg_idem_scope', envelope.id, redispatch)
    releaseWorker()
    await runtime.jobsSettled()

    expect(prompts.filter(p => p.startsWith('FOLLOWUP'))).toHaveLength(0)
    expect(runtime.log.text()).not.toContain('Evals.decide remandate')
    const workerStarts = runtime.log.text().match(/ExecutorSession start session=worker_/g) ?? []
    expect(workerStarts).toHaveLength(1)
  })

  it('ready from the superseded turn leaves the revised ticket open for FOLLOWUP', async () => {
    const prompts: string[] = []
    let releaseWorker!: () => void
    const gate = new Promise<void>(resolve => { releaseWorker = resolve })
    let scope = scopeA
    const redispatch = { value: false }
    const runtime = start(dispatchModel(prompts, gate, () => scope, redispatch))
    runtime.ingest(directTrigger('trg_ready_race'))
    await vi.waitFor(() => expect(prompts.some(p => p.startsWith('TASK'))).toBe(true))
    const envelope = runtime.store.listDocs<Ticket>('ticket').find(isConversationTicket)!
    const workId = runtime.store.listDocs<Ticket>('ticket').find(t => !isConversationTicket(t))!.id
    scope = scopeB
    await dispatchAgain(runtime, 'trg_ready_race', envelope.id, redispatch)
    releaseWorker()
    await vi.waitFor(() => expect(runtime.store.getDoc<Ticket>('ticket', workId)?.ended).toBeDefined())
    await runtime.jobsSettled()

    const workerTurns = prompts.filter(p => p.startsWith('TASK') || p.startsWith('FOLLOWUP'))
    expect(workerTurns.some(p => p.startsWith('FOLLOWUP') && p.includes(`scope=${scopeB}`))).toBe(true)
    expect(runtime.store.getDoc<Ticket>('ticket', workId)?.ended?.outcome).toBe('ready')
    expect(runtime.log.text()).toContain('kept ticket open for revised mandate')
  })

  it('dropped from the superseded turn leaves the revised ticket open for FOLLOWUP', async () => {
    const prompts: string[] = []
    let releaseWorker!: () => void
    const taskGate = new Promise<void>(resolve => { releaseWorker = resolve })
    let releaseFollowup!: () => void
    const followupGate = new Promise<void>(resolve => { releaseFollowup = resolve })
    let scope = scopeA
    const redispatch = { value: false }
    const runtime = start(dispatchModel(
      prompts, taskGate, () => scope, redispatch, followupGate,
      true, true, undefined, true, 'dropped',
    ))
    runtime.ingest(directTrigger('trg_dropped_race'))
    await vi.waitFor(() => expect(prompts.some(p => p.startsWith('TASK'))).toBe(true))
    const envelope = runtime.store.listDocs<Ticket>('ticket').find(isConversationTicket)!
    const workId = runtime.store.listDocs<Ticket>('ticket').find(t => !isConversationTicket(t))!.id

    scope = scopeB
    await dispatchAgain(runtime, 'trg_dropped_race', envelope.id, redispatch)
    releaseWorker()
    await vi.waitFor(() => expect(prompts.some(p => p.startsWith('FOLLOWUP'))).toBe(true))
    expect(runtime.store.getDoc<Ticket>('ticket', workId)?.ended).toBeUndefined()
    expect(prompts.some(p => p.startsWith('FOLLOWUP') && p.includes(`scope=${scopeB}`))).toBe(true)

    releaseFollowup()
    await runtime.jobsSettled()
    expect(runtime.store.getDoc<Ticket>('ticket', workId)?.ended?.outcome).toBe('ready')
    expect(runtime.log.text()).toContain('kept ticket open for revised mandate')
  })

  it('does not relaunch locally after a remote assignment turn has settled', async () => {
    const prompts: string[] = []
    let releaseWorker!: () => void
    const gate = new Promise<void>(resolve => { releaseWorker = resolve })
    let scope = scopeA
    const redispatch = { value: false }
    const runtime = start(dispatchModel(prompts, gate, () => scope, redispatch, undefined, true, false), {
      LOFIBOT_REMOTE_MESH: JSON.stringify([{
        id: 'remote-test-node',
        url: 'http://127.0.0.1:9',
        peerId: 'peer-test',
        secret: 'x'.repeat(32),
      }]),
    })
    runtime.ingest(directTrigger('trg_remote_settled_scope'))
    await vi.waitFor(() => expect(prompts.some(p => p.startsWith('TASK'))).toBe(true))
    const envelope = runtime.store.listDocs<Ticket>('ticket').find(isConversationTicket)!
    const work = runtime.store.listDocs<Ticket>('ticket').find(t => !isConversationTicket(t))!
    const assignment = work.assignments.at(-1)!
    assignment.node = 'remote-test-node'
    assignment.state = 'running'
    runtime.store.putDoc('ticket', work.id, work)

    releaseWorker()
    await runtime.jobsSettled()
    await vi.waitFor(() => expect(runtime.harness.workerActive(work.id)).toBe(false))
    expect(runtime.harness.launchInFlight(work.id)).toBe(false)
    expect(runtime.store.getDoc<Ticket>('ticket', work.id)?.ended).toBeUndefined()

    scope = scopeB
    await dispatchAgain(runtime, 'trg_remote_settled_scope', envelope.id, redispatch)
    await runtime.jobsSettled()

    expect(prompts.filter(p => p.startsWith('FOLLOWUP'))).toHaveLength(0)
    expect(prompts.filter(p => p.startsWith('TASK'))).toHaveLength(1)
    expect(runtime.log.text().match(/ExecutorSession start session=worker_/g) ?? []).toHaveLength(1)
    expect(runtime.store.getDoc<Ticket>('ticket', work.id)?.ended).toBeUndefined()
    const latestAssignment = runtime.store.getDoc<Ticket>('ticket', work.id)?.assignments.at(-1)
    expect(latestAssignment).toMatchObject({ node: 'remote-test-node', state: 'running' })
    expect(latestAssignment?.id).toBe(assignment.id)
  })

  it('does not relaunch a settled remote-running assignment through direct harness.launch', async () => {
    const prompts: string[] = []
    let releaseWorker!: () => void
    const gate = new Promise<void>(resolve => { releaseWorker = resolve })
    const runtime = start(dispatchModel(prompts, gate, () => scopeA, undefined, undefined, true, false), {
      LOFIBOT_REMOTE_MESH: JSON.stringify([{
        id: 'remote-test-node',
        url: 'http://127.0.0.1:9',
        peerId: 'peer-test',
        secret: 'x'.repeat(32),
      }]),
    })
    runtime.ingest(directTrigger('trg_direct_remote_launch'))
    await vi.waitFor(() => expect(prompts.some(prompt => prompt.startsWith('TASK'))).toBe(true))
    const work = runtime.store.listDocs<Ticket>('ticket').find(ticket => !isConversationTicket(ticket))!
    const assignment = work.assignments.at(-1)!
    assignment.node = 'remote-test-node'
    assignment.state = 'running'
    runtime.store.putDoc('ticket', work.id, work)

    releaseWorker()
    await runtime.jobsSettled()
    await vi.waitFor(() => expect(runtime.harness.workerActive(work.id)).toBe(false))
    expect(runtime.harness.launchInFlight(work.id)).toBe(false)
    expect(runtime.store.getDoc<Ticket>('ticket', work.id)?.ended).toBeUndefined()

    await runtime.harness.launch(runtime.store.getDoc<Ticket>('ticket', work.id)!)
    await runtime.jobsSettled()

    const latest = runtime.store.getDoc<Ticket>('ticket', work.id)!
    expect(latest.ended).toBeUndefined()
    expect(latest.assignments.at(-1)).toMatchObject({ id: assignment.id, node: 'remote-test-node', state: 'running' })
    expect(prompts.filter(prompt => prompt.startsWith('TASK'))).toHaveLength(1)
    expect(prompts.filter(prompt => prompt.startsWith('FOLLOWUP'))).toHaveLength(0)
    expect(runtime.log.text().match(/ExecutorSession start session=worker_/g) ?? []).toHaveLength(1)
    expect(runtime.log.text().match(new RegExp(`Assignments\\.start ticketId=${work.id}`, 'g')) ?? []).toHaveLength(1)
    expect(runtime.log.text().match(new RegExp(`Assignments\\.placed ticketId=${work.id}`, 'g')) ?? []).toHaveLength(1)
    expect(runtime.log.text().match(new RegExp(`\\[mesh\\] remote dispatch ticketId=${work.id}`, 'g')) ?? []).toHaveLength(0)
  })

  it('a revised remote-owned assignment does not start a local FOLLOWUP', async () => {
    const prompts: string[] = []
    let releaseWorker!: () => void
    const gate = new Promise<void>(resolve => { releaseWorker = resolve })
    let scope = scopeA
    const redispatch = { value: false }
    const runtime = start(dispatchModel(prompts, gate, () => scope, redispatch), {
      LOFIBOT_REMOTE_MESH: JSON.stringify([{
        id: 'remote-test-node',
        url: 'http://127.0.0.1:9',
        peerId: 'peer-test',
        secret: 'x'.repeat(32),
      }]),
    })
    runtime.ingest(directTrigger('trg_remote_scope'))
    await vi.waitFor(() => expect(prompts.some(p => p.startsWith('TASK'))).toBe(true))
    const envelope = runtime.store.listDocs<Ticket>('ticket').find(isConversationTicket)!
    const work = runtime.store.listDocs<Ticket>('ticket').find(t => !isConversationTicket(t))!
    const assignment = work.assignments.at(-1)!
    assignment.node = 'remote-test-node'
    assignment.state = 'running'
    runtime.store.putDoc('ticket', work.id, work)
    scope = scopeB
    await dispatchAgain(runtime, 'trg_remote_scope', envelope.id, redispatch)
    releaseWorker()
    await runtime.jobsSettled()

    expect(prompts.filter(p => p.startsWith('FOLLOWUP'))).toHaveLength(0)
    const workerStarts = runtime.log.text().match(/ExecutorSession start session=worker_/g) ?? []
    expect(workerStarts).toHaveLength(1)
  })
})
