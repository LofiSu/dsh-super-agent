import { afterEach, describe, expect, it, vi } from 'vitest'
import { imTrigger } from '../src/channels/im.ts'
import type { Runtime } from '../src/runtime.ts'
import type { Ticket, Trigger } from '../src/shared/types.ts'
import { freshRuntime, shutdown } from './fixtures.ts'
import { field, lastPrompt, ScriptedModel, silentModel } from './scripted-model.ts'

const runtimes: Runtime[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await shutdown(runtime)
})

function start(model?: ScriptedModel): Runtime {
  const runtime = freshRuntime({
    model: model ?? silentModel(),
    env: { ...process.env, DS_AGENT_ALLOW_MOCK_FIXTURE: '1' },
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

  it('re-dispatch with a new scope updates the mandate and reaches the worker via FOLLOWUP', async () => {
    const prompts: string[] = []
    let releaseWorker: (() => void) | undefined
    const workerTurnDone = new Promise<void>(resolve => { releaseWorker = resolve })
    const model = new ScriptedModel(async request => {
      const prompt = lastPrompt(request)
      if (request.role === 'worker') {
        const head = prompt.split('\n')[0] ?? ''
        const seen = prompts.some(p => (p.split('\n')[0] ?? '') === head)
        if (!seen) prompts.push(prompt)
        if (prompt.startsWith('TASK')) await workerTurnDone
      }
      if (request.role === 'router') return { text: 'ok' }
      if (!request.messages.some(m => m.role === 'tool' && m.name === 'report_to_router')) {
        return {
          toolCalls: [{
            id: 'r1',
            name: 'report_to_router',
            args: {
              ticketId: field(prompt, 'ticketId'),
              text: 'working',
              deliver: false,
              kind: 'progress',
            },
          }],
        }
      }
      return { text: 'done' }
    })
    const runtime = start(model)

    const decision = issue192Fixture(runtime, 'trg_redispatch')
    const ticketId = decision.ticketId!
    const ticket = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    void runtime.harness.launch(ticket)
    await vi.waitFor(() => {
      expect(prompts.some(p => p.startsWith('TASK'))).toBe(true)
      expect(runtime.harness.workerActive(ticketId)).toBe(true)
    })
    const firstTask = prompts.find(p => p.startsWith('TASK'))!
    expect(firstTask).toContain(`scope=${scopeA}`)

    runtime.engine.decide('trg_redispatch', {
      kind: 'accept',
      title: '重测只读读取 GitHub 工单 #192',
      scope: scopeB,
      strength: 'explicit',
      reason: 'router-dispatch',
    })
    const updated = runtime.store.getDoc<Ticket>('ticket', ticketId)!
    expect(updated.mandate.scope).toBe(scopeB)

    const engage = (workId: string) => {
      const row = runtime.store.getDoc<Ticket>('ticket', workId)
      if (!row || row.ended) return
      const asg = row.assignments.at(-1)
      const engaged = asg?.state === 'running' || runtime.harness.workerActive(workId)
      if (engaged) {
        const trig = runtime.store.getDoc<Trigger>('trigger', row.originTriggerId)
        if (trig) void runtime.harness.deliver(workId, trig)
        return
      }
      if (runtime.harness.launchInFlight(workId)) return
      void runtime.harness.launch(row)
    }
    engage(ticketId)
    releaseWorker?.()
    await runtime.jobsSettled()

    const followup = prompts.find(p => p.startsWith('FOLLOWUP'))
    expect(followup).toBeDefined()
    expect(followup).toContain(`scope=${scopeB}`)
    expect(runtime.log.text()).toContain('Evals.decide remandate')
    const workerStarts = runtime.log.text().match(/ExecutorSession start session=worker_/g) ?? []
    expect(workerStarts.length).toBe(1)
  })

  it('same-trigger accept with unchanged scope stays idempotent', () => {
    const runtime = start()
    const decision = issue192Fixture(runtime, 'trg_idem_scope')
    const again = runtime.engine.decide('trg_idem_scope', {
      kind: 'accept',
      title: '重测只读读取 GitHub 工单 #192',
      scope: scopeA,
      strength: 'explicit',
      reason: 'router-dispatch',
    })
    expect(again.id).toBe(decision.id)
    expect(runtime.store.listDocs('decision')).toHaveLength(1)
    expect(runtime.log.text()).toContain('Evals.decide skipped triggerId=trg_idem_scope kind=accept')
    expect(runtime.log.text()).not.toContain('Evals.decide remandate')
  })
})
