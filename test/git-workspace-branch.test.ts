import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  defaultCredentialHidePaths,
  excludeWorkspaceRuntimePaths,
  isGitRepositorySource,
  normalizePeanutBranch,
  seedWorkspaceCheckout,
} from '../src/env/git-workspace.ts'
import { UserError } from '../src/shared/errors.ts'

describe('normalizePeanutBranch', () => {
  it('uses explicit slug under peanut/', () => {
    expect(normalizePeanutBranch('my-feature', 'peanut/other')).toBe('peanut/my-feature')
  })

  it('uses HEAD when branch omitted', () => {
    expect(normalizePeanutBranch(undefined, 'peanut/from-head')).toBe('peanut/from-head')
  })

  it('refuses explicit main even when HEAD is peanut/ok', () => {
    expect(() => normalizePeanutBranch('main', 'peanut/ok')).toThrow(UserError)
    expect(() => normalizePeanutBranch('peanut/main', 'peanut/ok')).toThrow(UserError)
    expect(() => normalizePeanutBranch('master', 'peanut/ok')).toThrow(UserError)
  })

  it('refuses invalid slugs', () => {
    expect(() => normalizePeanutBranch('foo:main', 'peanut/x')).toThrow(UserError)
    expect(() => normalizePeanutBranch('--force', 'peanut/x')).toThrow(UserError)
    expect(() => normalizePeanutBranch('has space', 'peanut/x')).toThrow(UserError)
  })

  it('requires peanut/ HEAD when branch omitted', () => {
    expect(() => normalizePeanutBranch(undefined, 'main')).toThrow(UserError)
    expect(() => normalizePeanutBranch(undefined, 'peanut/main')).toThrow(UserError)
  })
})

describe('defaultCredentialHidePaths', () => {
  it('retains host credential candidates that do not exist yet', () => {
    const home = path.join(os.tmpdir(), `ds-agent-cred-candidates-${process.pid}-${Date.now()}`)
    fs.mkdirSync(home, { recursive: true })
    try {
      const paths = defaultCredentialHidePaths(home)
      const ghConfig = path.join(home, '.config', 'gh')
      const sshDir = path.join(home, '.ssh')
      expect(paths).toContain(ghConfig)
      expect(paths).toContain(sshDir)
      expect(fs.existsSync(ghConfig)).toBe(false)
      expect(fs.existsSync(sshDir)).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('excludeWorkspaceRuntimePaths', () => {
  it('installs checkout-local exclusions for runtime credential directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-exclude-'))
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: workspace })
      excludeWorkspaceRuntimePaths(workspace)
      const exclude = path.join(workspace, '.git', 'info', 'exclude')
      const rules = fs.readFileSync(exclude, 'utf8')
      for (const rule of ['/.config/', '/tmp/', '/.ssh/']) {
        expect(rules).toContain(rule)
      }
      // A runtime file in an excluded directory must not be stageable with `git add -A`.
      fs.mkdirSync(path.join(workspace, '.config', 'gh'), { recursive: true })
      fs.writeFileSync(path.join(workspace, '.config', 'gh', 'hosts.yml'), 'secret\n')
      fs.mkdirSync(path.join(workspace, 'tmp'), { recursive: true })
      fs.writeFileSync(path.join(workspace, 'tmp', 'state.json'), 'secret\n')
      execFileSync('git', ['add', '-A'], { cwd: workspace })
      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: workspace, encoding: 'utf8' })
      expect(staged).not.toMatch(/\.config|tmp\//)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('is a no-op outside a git checkout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-exclude-nogit-'))
    try {
      expect(() => excludeWorkspaceRuntimePaths(root)).not.toThrow()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('isGitRepositorySource', () => {
  it('recognizes a valid git checkout and a bare repository', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-src-ok-'))
    const work = path.join(root, 'work')
    const bare = path.join(root, 'bare.git')
    fs.mkdirSync(work, { recursive: true })
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: work })
      expect(isGitRepositorySource(work)).toBe(true)
      execFileSync('git', ['init', '--bare', '-b', 'main', bare])
      expect(isGitRepositorySource(bare)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a non-repository directory or a missing path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-src-bad-'))
    try {
      expect(isGitRepositorySource(root)).toBe(false)
      expect(isGitRepositorySource(path.join(root, 'missing'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('seedWorkspaceCheckout', () => {
  it('surfaces concise git stderr and rolls back when the clone fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-seed-fail-'))
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace, { recursive: true })
    try {
      let message = ''
      try {
        seedWorkspaceCheckout(workspace, path.join(root, 'missing-source.git'))
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toMatch(/git clone failed/)
      expect(message).toMatch(/does not appear to be a git repository|does not exist|No such file|not a git repository/i)
      expect(fs.existsSync(workspace)).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('bounds a synchronous clone with a timeout and kill signal', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/env/git-workspace.ts'), 'utf8')
    const seedBody = source.slice(source.indexOf('export function seedWorkspaceCheckout'))
    const cloneCall = seedBody.slice(0, seedBody.indexOf('const rollbackSeed'))
    expect(cloneCall).toMatch(/timeout\s*:/)
    expect(cloneCall).toMatch(/killSignal\s*:/)
  })
})
