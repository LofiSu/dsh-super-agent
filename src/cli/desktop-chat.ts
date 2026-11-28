import { Console } from 'node:console'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { cliTrigger } from '../channels/cli.ts'
import { createModelFromEnv } from '../harness/model.ts'
import { Runtime } from '../runtime.ts'
import { threadKey, type Ticket } from '../shared/types.ts'

type EventType = 'status' | 'delta' | 'reply' | 'error'

function emit(type: EventType, text: string): void {
  if (!process.stdout.destroyed) process.stdout.write(JSON.stringify({ type, text }) + '\n')
}

function requestText(line: string): string {
  let request: unknown
  try {
    request = JSON.parse(line)
  } catch {
    throw new Error('Expected a JSON message.')
  }
  if (request === null || typeof request !== 'object' || !('text' in request)
    || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 65_536) {
    throw new Error('Enter a message of 1 to 65,536 characters.')
  }
  return request.text.trim()
}

export async function chatTurn(
  runtime: Runtime,
  session: string,
  text: string,
  emit: (type: EventType, text: string) => void,
): Promise<void> {
  const trigger = cliTrigger({ id: 'trg_desktop_' + randomUUID(), text })
  const thread = { source: 'cli', id: session }
  const key = threadKey(thread)
  trigger.threads = [thread]
  trigger.channel = { source: 'cli', thread: session, address: { desktop: '1' } }

  const ids = new Set<string>()
  // Ingress can append to an existing ticket. Its prior replies belong to earlier turns.
  const seen = new Set(runtime.store.listReplies().filter(reply => reply.channel === 'cli').map(reply => reply.id))
  const replies: string[] = []
  const outcomes: string[] = []
  const collect = (): void => {
    if (!ids.size) return
    for (const reply of runtime.store.listReplies()) {
      if (!ids.has(reply.ticketId) || reply.channel !== 'cli' || reply.status !== 'sent' || seen.has(reply.id)) continue
      seen.add(reply.id)
      if (reply.purpose === 'acknowledgement') {
        emit('status', reply.text)
      } else {
        emit('delta', (replies.length ? '\n\n' : '') + reply.text)
        replies.push(reply.text)
      }
    }
    for (const outcome of outcomes.splice(0)) emit('status', 'Task ' + outcome)
  }
  const stopCreated = runtime.lifecycle.subscribe('ticket.created', ({ payload }) => {
    const event = payload as { ticketId: string; threads: string[] }
    if (!event.threads.includes(key)) return
    ids.add(event.ticketId)
  })
  const stopEnded = runtime.lifecycle.subscribe('ticket.ended', ({ payload }) => {
    const event = payload as { ticketId: string; outcome: string }
    if (ids.has(event.ticketId)) outcomes.push(event.outcome)
  })

  // Read replies only between runtime transactions, after they are committed.
  let collectError: unknown
  const timer = setInterval(() => {
    try {
      collect()
    } catch (error) {
      collectError = error
      clearInterval(timer)
    }
  }, 100)
  try {
    emit('status', 'Working…')
    const result = runtime.ingest(trigger)
    if (result !== 'stored') throw new Error('The Agent did not accept this message.')
    await runtime.assessmentsSettled()
    for (const ticket of runtime.store.listDocs<Ticket>('ticket')) {
      if (ticket.originTriggerId === trigger.id || ticket.inputs.some(input => input.triggerId === trigger.id)) {
        ids.add(ticket.id)
      }
    }
    await runtime.jobsSettled()
    if (collectError) throw collectError
    collect()
    const pendingApproval = [...ids].filter(id =>
      runtime.store.getDoc<Ticket>('ticket', id)?.collab?.approvals?.some(approval => approval.status === 'pending'))
    if (pendingApproval.length) {
      const message = 'Needs approval · ' + pendingApproval.join(', ')
      emit('status', message)
      replies.push(message)
    }
    if (!replies.length) throw new Error('The Agent finished without a reply.')
    emit('reply', replies.join('\n\n'))
  } finally {
    clearInterval(timer)
    stopCreated()
    stopEnded()
  }
}

/** Private NDJSON transport owned by the desktop child process. */
export async function runDesktopChat(home: string): Promise<void> {
  const originalConsole = globalThis.console
  globalThis.console = new Console(process.stderr)
  let runtime: Runtime | undefined
  let input: ReturnType<typeof createInterface> | undefined
  let finishing: Promise<void> | undefined
  const finish = (): Promise<void> => finishing ??= runtime?.finish() ?? Promise.resolve()
  let closing = false
  const close = (): void => {
    if (closing) return
    closing = true
    input?.close()
    void finish().catch(failure => originalConsole.error(failure))
  }
  const disconnect = (error: NodeJS.ErrnoException): void => {
    if (error.code !== 'EPIPE') originalConsole.error(error)
    close()
  }
  process.stdout.on('error', disconnect)
  // Covers a window process exiting before its shutdown message reaches stdin.
  const parent = Number(process.env.LOFIBOT_DESKTOP_PARENT_PID)
  const monitor = Number.isSafeInteger(parent) && parent > 1
    ? setInterval(() => {
      try {
        process.kill(parent, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') close()
      }
    }, 1_000).unref()
    : undefined
  try {
    runtime = Runtime.create({
      home,
      model: createModelFromEnv(),
      jobDelayMs: 20,
      watchdogIntervalMs: 60_000,
    })
    const conversation = process.env.LOFIBOT_DESKTOP_CONVERSATION ?? 'local'
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(conversation)) {
      throw new Error('Invalid desktop conversation ID.')
    }
    const session = 'desktop-' + conversation
    runtime.startForegroundChat(threadKey({ source: 'cli', id: session }))
    input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
    input.on('line', line => {
      if (line === '{"shutdown":true}') close()
    })
    emit('status', 'Ready')
    for await (const line of input) {
      if (closing) break
      try {
        await chatTurn(runtime, session, requestText(line), emit)
      } catch (error) {
        emit('error', error instanceof Error ? error.message : 'Chat failed.')
      }
    }
  } finally {
    clearInterval(monitor)
    input?.close()
    try {
      await finish()
    } finally {
      globalThis.console = originalConsole
    }
  }
}
