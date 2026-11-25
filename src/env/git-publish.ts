import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GithubRepoRef } from '../channels/github-source.ts'
import type { GhRun } from '../channels/github-source.ts'
import { runGh } from '../channels/github-source.ts'
import type { PublishApprovalBinding } from '../shared/types.ts'
import { UserError } from '../shared/errors.ts'
import { assertGitCommonDirInsideWorkspace, normalizePeanutBranch } from './git-workspace.ts'

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

export interface GitRun {
  (args: string[], opts: { cwd: string }): Promise<GitRunResult>
}

const GIT_CONFIG_ARGS = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'uploadpack.packObjectsHook=',
  '-c', 'credential.helper=',
  '-c', 'credential.helper=!gh auth git-credential',
  '-c', 'protocol.file.allow=always',
]

function publisherEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? os.homedir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  }
  for (const key of ['XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

/** Runtime namespaces and credential-shaped files that must never be published. */
const CREDENTIAL_PATH_RULES: readonly RegExp[] = [
  /(^|\/)\.config\//i,
  /(^|\/)\.ssh\//i,
  /(^|\/)tmp\//i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /hosts\.yml$/i,
  /id_(?:ed25519|rsa|ecdsa)(?:\.|$)/i,
]

/**
 * Return bounded, normalized paths from a NUL-separated `git ls-tree` listing
 * that look like host credentials or runtime state. Bounds keep error text
 * small and deterministic; the caller only needs to know publication is unsafe.
 */
export function credentialRiskPaths(lsTreeOutput: string): string[] {
  const paths = lsTreeOutput.split('\0').map(p => p.trim()).filter(Boolean)
  return paths.filter(p => CREDENTIAL_PATH_RULES.some(re => re.test(p))).slice(0, 20)
}

/** Git invocations run with an allowlisted environment and a disabled hooks path. */
export const runGit: GitRun = (args, opts) => new Promise((resolve, reject) => {
  const child = spawn('git', [...GIT_CONFIG_ARGS, ...args], {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: publisherEnv(),
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
  child.on('error', error => reject(new Error(`cannot run git: ${error.message}`)))
  child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
})

export interface PublishFeaturePrInput {
  workerId: string
  title: string
  body?: string
  branch?: string
}

export interface PublishFeaturePrResult {
  url: string
  number: number
  branch: string
  remote: string
}

export interface FeaturePrPublisherOptions {
  repo: GithubRepoRef
  workspace: (workerId: string) => string
  /** Test override: `git push` destination instead of the configured GitHub URL. */
  pushRemote?: string
  git?: GitRun
  gh?: GhRun
  /**
   * Host-side precondition for publication. Runtime supplies a check that
   * fails closed when worker credential hides cannot be enforced. Tests may
   * omit it; a publisher used in production must have it wired.
   */
  assertCredentialsHidden?: () => void
}

/**
 * Publish only an explicitly approved commit. Git object transfer reads from the
 * Worker checkout, while push runs from a new host-owned bare repository with
 * isolated config and no repository-local hooks.
 */
export class FeaturePrPublisher {
  private readonly repo: GithubRepoRef
  private readonly workspace: (workerId: string) => string
  private readonly pushRemote: string
  private readonly git: GitRun
  private readonly gh: GhRun
  private readonly assertCredentialsHidden?: () => void

  constructor(options: FeaturePrPublisherOptions) {
    this.repo = options.repo
    this.workspace = options.workspace
    this.pushRemote = options.pushRemote ?? `https://github.com/${options.repo.full}.git`
    this.git = options.git ?? runGit
    this.gh = options.gh ?? runGh
    this.assertCredentialsHidden = options.assertCredentialsHidden
  }

  async prepare(input: PublishFeaturePrInput): Promise<PublishApprovalBinding> {
    const title = input.title?.trim()
    if (!title) throw new UserError('publish_feature_pr needs title')
    if (title.length > 120) throw new UserError('publish_feature_pr title is too long for an owner approval')
    const body = input.body?.replace(/\s+/g, ' ').trim()
    if (body && body.length > 400) throw new UserError('publish_feature_pr body is too long for an owner approval')
    const ws = this.workspace(input.workerId)
    assertGitCommonDirInsideWorkspace(ws)
    const headResult = await this.git(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: ws })
    const head = headResult.stdout.trim()
    if (headResult.code !== 0 || !/^[0-9a-f]{40,64}$/.test(head)) {
      throw new UserError('publish refused: workspace has no valid commit to publish')
    }
    const branchResult = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: ws })
    const headBranch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined
    const branch = normalizePeanutBranch(input.branch, headBranch)
    if (branch.length > 120) throw new UserError('publish_feature_pr branch is too long')
    return {
      repo: this.repo.full,
      head,
      branch,
      base: 'main',
      title,
      ...(body ? { body } : {}),
    }
  }

  /**
   * Bounded, secret-free description of the exact commit being proposed. The
   * approval action shows only a diff stat and path names — never file bodies
   * or untrusted commit messages — so the owner can see what they approve.
   */
  async describeCommit(workerId: string, binding: PublishApprovalBinding): Promise<string> {
    const ws = this.workspace(workerId)
    const result = await this.git(
      ['show', '--stat', '--format=', '--no-renames', '-z', binding.head],
      { cwd: ws },
    )
    const raw = result.code === 0 ? result.stdout : '(commit summary unavailable)'
    const lines = raw.split('\0').map(part => part.trim()).filter(Boolean).slice(0, 12)
    const body = lines.length > 0 ? lines.join(' | ') : '(no changed paths)'
    return `commit ${binding.head.slice(0, 12)}: ${body}`.slice(0, 300)
  }

  async publish(
    input: PublishFeaturePrInput,
    approved: PublishApprovalBinding,
    assertCanPublish?: () => void,
  ): Promise<PublishFeaturePrResult> {
    const binding = await this.prepare(input)
    if (JSON.stringify(binding) !== JSON.stringify(approved)) {
      throw new UserError('publish refused: approval does not match repository, commit, branch, or PR metadata')
    }
    this.assertCredentialsHidden?.()
    const ws = this.workspace(input.workerId)
    const hostRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-publish-'))
    try {
      const init = await this.git(['init', '--bare', '--quiet', hostRepo], { cwd: os.tmpdir() })
      if (init.code !== 0) throw new UserError(`publish staging failed: ${init.stderr.trim().slice(0, 300)}`)
      const fetch = await this.git([
        'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
        '--', ws, binding.head,
      ], { cwd: hostRepo })
      if (fetch.code !== 0) {
        throw new UserError(`publish object transfer failed (exit ${fetch.code}): ${fetch.stderr.trim().slice(0, 400)}`)
      }
      const stagedCommit = await this.git(['cat-file', '-e', `${binding.head}^{commit}`], { cwd: hostRepo })
      if (stagedCommit.code !== 0) {
        throw new UserError('publish object transfer failed: staging repository cannot resolve the approved commit')
      }
      // Defense in depth: checkout-local excludes are worker-writable and
      // `git add -f` can bypass them. Inspect the approved commit's tree in the
      // host-owned staging repo and refuse to publish any runtime/credential
      // path before the push. Scanning the committed tree (not the index)
      // covers force-staged files regardless of later index manipulation.
      const tree = await this.git(['ls-tree', '-r', '--name-only', '-z', binding.head], { cwd: hostRepo })
      if (tree.code !== 0) {
        throw new UserError(`publish refused: cannot inspect the approved commit tree (exit ${tree.code})`)
      }
      const unsafe = credentialRiskPaths(tree.stdout)
      if (unsafe.length > 0) {
        throw new UserError(
          `publish refused: the approved commit contains credential/runtime paths (${unsafe.slice(0, 3).join(', ')}); remove them before publishing`,
        )
      }
      assertCanPublish?.()
      const push = await this.git([
        'push', '--no-verify', '--no-follow-tags', '--',
        this.pushRemote, `${binding.head}:refs/heads/${binding.branch}`,
      ], { cwd: hostRepo })
      if (push.code !== 0) {
        throw new UserError(`git push failed (exit ${push.code}): ${push.stderr.trim().slice(0, 400)}`)
      }
    } finally {
      fs.rmSync(hostRepo, { recursive: true, force: true })
    }
    assertCanPublish?.()
    const { number, url } = await this.upsertPullRequest(
      binding.branch,
      binding.title,
      binding.body,
      assertCanPublish,
    )
    return { url, number, branch: binding.branch, remote: `${this.repo.owner}/${this.repo.repo}` }
  }

  private async upsertPullRequest(
    headBranch: string,
    title: string,
    body?: string,
    assertCanPublish?: () => void,
  ): Promise<{ number: number; url: string }> {
    let listOut: string
    try {
      listOut = await this.gh([
        'pr', 'list',
        '--repo', this.repo.full,
        '--head', headBranch,
        '--base', 'main',
        '--state', 'open',
        '--json', 'number,url',
        '--limit', '1',
      ])
    } catch (error) {
      throw new UserError(`gh pr list failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const items = listOut.trim() ? (JSON.parse(listOut) as { number: number; url: string }[]) : []
    assertCanPublish?.()
    if (items[0]) {
      const number = items[0].number
      const url = items[0].url
      const editArgs = ['pr', 'edit', String(number), '--repo', this.repo.full, '--title', title]
      if (body) editArgs.push('--body', body)
      await this.gh(editArgs)
      return { number, url }
    }
    const createArgs = [
      'pr', 'create',
      '--repo', this.repo.full,
      '--base', 'main',
      '--head', headBranch,
      '--title', title,
    ]
    if (body) createArgs.push('--body', body)
    let createOut: string
    try {
      createOut = await this.gh(createArgs)
    } catch (error) {
      throw new UserError(`gh pr create failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const url = createOut.trim().split(/\s+/).pop() ?? ''
    if (!url) throw new UserError('gh pr create returned no URL')
    const viewOut = await this.gh(['pr', 'view', url, '--repo', this.repo.full, '--json', 'number,url'])
    const parsed = JSON.parse(viewOut) as { number: number; url: string }
    return { number: parsed.number, url: parsed.url || url }
  }
}
