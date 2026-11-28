import type { Store } from '../store/sqlite.ts'
import type { JobRunner } from './job-runner.ts'
import {
  DISPATCH_GAP_KIND,
  getDispatchJob,
  getQueueState,
  listDispatchJobs,
  putDispatchJob,
  putQueueState,
  type DispatchGapDoc,
  type DispatchJobDoc,
} from './store.ts'

export interface RunDispatchJobContext {
  issueTitle?: string
  issueBody?: string
}

export interface DispatchQueueOptions {
  store: Store
  runner: JobRunner
  log?: (line: string) => void
  hasOpenPeanutPr?: (branchPrefix: string) => Promise<boolean>
}

function sortQueued(jobs: DispatchJobDoc[]): DispatchJobDoc[] {
  return jobs
    .filter(j => j.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function writeJobIfRunning(
  store: Store,
  jobId: string,
  update: (job: DispatchJobDoc) => DispatchJobDoc,
): boolean {
  return store.atomic(() => {
    const job = getDispatchJob(store, jobId)
    if (job?.status !== 'running') return false
    putDispatchJob(store, update(job))
    return true
  })
}

export async function drainDispatchQueue(
  options: DispatchQueueOptions,
  ctxByJobId: ReadonlyMap<string, RunDispatchJobContext> = new Map(),
): Promise<void> {
  const log = options.log ?? (() => undefined)
  if (getQueueState(options.store).runningJobId) return

  const next = sortQueued(listDispatchJobs(options.store))[0]
  if (!next) return

  const started = options.store.atomic(() => {
    const queue = getQueueState(options.store)
    const current = getDispatchJob(options.store, next.id)
    if (queue.runningJobId || current?.status !== 'queued') return false
    putQueueState(options.store, { ...queue, runningJobId: next.id })
    putDispatchJob(options.store, { ...current, status: 'running', startedAt: new Date().toISOString() })
    return true
  })
  if (!started) return

  try {
    if (next.type === 'github_fix') {
      const ctx = ctxByJobId.get(next.id)
      const out = await options.runner.runGithubFix({
        job: next,
        assertCanPublish: () => {
          if (getDispatchJob(options.store, next.id)?.status !== 'running') {
            throw new Error(`dispatch job ${next.id} is no longer running`)
          }
        },
        issueTitle: ctx?.issueTitle ?? next.issueTitle ?? `Issue #${next.issueNumber ?? ''}`,
        issueBody: ctx?.issueBody ?? next.issueBody ?? '',
      })
      writeJobIfRunning(options.store, next.id, job => ({
        ...job,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        prUrl: out.prUrl,
        prNumber: out.prNumber,
      }))
      log(`[dispatch] github_fix ${next.id} completed pr=${out.prUrl ?? 'n/a'}`)
    } else if (next.type === 'rsi_implement') {
      const gap = options.store.getDoc<DispatchGapDoc>(DISPATCH_GAP_KIND, next.gapId ?? '')
      if (!gap) throw new Error(`missing gap for job ${next.id}`)
      if (options.hasOpenPeanutPr) {
        const open = await options.hasOpenPeanutPr(`peanut/rsi-${gap.id}`)
        if (open) {
          writeJobIfRunning(options.store, next.id, job => ({
            ...job,
            status: 'failed',
            finishedAt: new Date().toISOString(),
            error: 'idle: equivalent open peanut/* PR exists',
          }))
          log(`[dispatch] rsi_implement ${next.id} idle duplicate PR`)
          return
        }
      }
      const out = await options.runner.runRsiImplement({
        job: next,
        gap,
        assertCanPublish: () => {
          if (getDispatchJob(options.store, next.id)?.status !== 'running') {
            throw new Error(`dispatch job ${next.id} is no longer running`)
          }
        },
      })
      writeJobIfRunning(options.store, next.id, job => ({
        ...job,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        prUrl: out.prUrl,
        prNumber: out.prNumber,
      }))
      log(`[dispatch] rsi_implement ${next.id} completed`)
    } else if (next.type === 'rsi_proposal') {
      writeJobIfRunning(options.store, next.id, job => ({
        ...job,
        status: 'completed',
        finishedAt: new Date().toISOString(),
      }))
      log(`[dispatch] rsi_proposal ${next.id} recorded`)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    writeJobIfRunning(options.store, next.id, job => ({
      ...job,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: msg,
    }))
    log(`[dispatch] job ${next.id} failed: ${msg}`)
  } finally {
    options.store.atomic(() => {
      const queue = getQueueState(options.store)
      if (queue.runningJobId === next.id) {
        putQueueState(options.store, { ...queue, runningJobId: undefined })
      }
    })
  }

  await drainDispatchQueue(options, ctxByJobId)
}

export function cancelDispatchJob(store: Store, jobId: string): boolean {
  const job = getDispatchJob(store, jobId)
  if (!job) return false
  if (job.status !== 'queued' && job.status !== 'running') return false
  return store.atomic(() => {
    const current = getDispatchJob(store, jobId)
    if (!current || (current.status !== 'queued' && current.status !== 'running')) return false
    putDispatchJob(store, {
      ...current,
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
    })
    return true
  })
}
