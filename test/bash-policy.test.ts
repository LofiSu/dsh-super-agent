import { describe, expect, it } from 'vitest'
import { UserError } from '../src/shared/errors.ts'
import {
  assertDevShellCommandAllowed,
  devShellCommandRejection,
  gitPushStatementTargetsProtected,
  protectedRefName,
  refspecTargetsProtectedBranch,
  splitShellStatements,
} from '../src/env/bash-policy.ts'

describe('bash policy — git push refspecs', () => {
  it('parses protected ref names', () => {
    expect(protectedRefName('main')).toBe(true)
    expect(protectedRefName('refs/heads/main')).toBe(true)
    expect(protectedRefName('origin/main')).toBe(true)
    expect(protectedRefName('feature/foo')).toBe(false)
    expect(protectedRefName('HEAD')).toBe(false)
  })

  it('detects refspec targets', () => {
    expect(refspecTargetsProtectedBranch('main')).toBe(true)
    expect(refspecTargetsProtectedBranch('HEAD:main')).toBe(true)
    expect(refspecTargetsProtectedBranch('feature/x:main')).toBe(true)
    expect(refspecTargetsProtectedBranch(':master')).toBe(true)
    expect(refspecTargetsProtectedBranch('feature/x')).toBe(false)
    expect(refspecTargetsProtectedBranch('HEAD:feature/x')).toBe(false)
  })

  it('allows feature-branch pushes', () => {
    expect(gitPushStatementTargetsProtected('git push origin feature/peanut')).toBe(false)
    expect(gitPushStatementTargetsProtected('git push origin HEAD:refs/heads/feature/x')).toBe(false)
  })

  it('rejects pushes to main/master', () => {
    expect(gitPushStatementTargetsProtected('git push origin main')).toBe(true)
    expect(gitPushStatementTargetsProtected('git push origin master')).toBe(true)
    expect(gitPushStatementTargetsProtected('git push origin HEAD:main')).toBe(true)
    expect(gitPushStatementTargetsProtected('git push origin refs/heads/main')).toBe(true)
  })

  it('rejects push modes that can include protected branches', () => {
    expect(gitPushStatementTargetsProtected('git push --all origin')).toBe(true)
    expect(gitPushStatementTargetsProtected('git push --mirror origin')).toBe(true)
  })

  it('parses the repository argument by position, including local paths and URLs', () => {
    expect(gitPushStatementTargetsProtected('git push ./mirror.git main')).toBe(true)
    expect(gitPushStatementTargetsProtected('git push /tmp/mirror.git master')).toBe(true)
    expect(gitPushStatementTargetsProtected('git push https://github.com/o/r.git main')).toBe(true)
    expect(gitPushStatementTargetsProtected('git push ./mirror.git peanut/x')).toBe(false)
  })

  it('skips git global options before the push subcommand', () => {
    expect(gitPushStatementTargetsProtected('git -C . push origin main')).toBe(true)
    expect(gitPushStatementTargetsProtected('git -c k=v push origin main')).toBe(true)
    expect(gitPushStatementTargetsProtected('git --no-pager push origin main')).toBe(true)
    expect(gitPushStatementTargetsProtected('git --git-dir /x push origin main')).toBe(true)
    expect(gitPushStatementTargetsProtected('git -C . push origin peanut/x')).toBe(false)
  })
})

describe('bash policy — compound commands', () => {
  it('splits on ; and &&', () => {
    expect(splitShellStatements('a; b && c')).toEqual(['a', 'b', 'c'])
  })

  it('rejects gh pr merge', () => {
    expect(devShellCommandRejection('gh pr merge 42')).toMatch(/gh pr merge/)
    expect(devShellCommandRejection('echo ok && gh pr merge')).toMatch(/gh pr merge/)
  })

  it('rejects checkout main then merge', () => {
    expect(devShellCommandRejection('git checkout main; git merge feature/x')).toMatch(/main\/master/)
  })

  it('tracks branch switches across statements when applying branch checks', () => {
    // Switching to a feature branch before a default push means HEAD is no longer main.
    expect(devShellCommandRejection('git switch -c peanut/task; git push origin', { headBranch: 'main' })).toBeNull()
    // Switching to main before a default push must reject even when the command started on a feature branch.
    expect(devShellCommandRejection('git switch main && git push origin', { headBranch: 'peanut/task' })).toMatch(/push/)
    expect(devShellCommandRejection('git checkout main; git push origin', { headBranch: 'peanut/task' })).toMatch(/push/)
    // A merge after switching away from main is allowed; a merge after switching to main is not.
    expect(devShellCommandRejection('git switch peanut/task; git merge origin/main', { headBranch: 'main' })).toBeNull()
    expect(devShellCommandRejection('git switch main; git merge origin/feature', { headBranch: 'peanut/task' })).toMatch(/main\/master/)
  })

  it('rejects bare git push when HEAD is main', () => {
    expect(devShellCommandRejection('git push', { headBranch: 'main' })).toMatch(/push/)
    expect(devShellCommandRejection('git push origin', { headBranch: 'main' })).toMatch(/push/)
    expect(devShellCommandRejection('git push origin', { headBranch: 'refs/heads/main' })).toMatch(/push/)
  })

  it('treats bare HEAD and @ refspecs as a default push on protected heads', () => {
    expect(devShellCommandRejection('git push origin HEAD', { headBranch: 'main' })).toMatch(/push/)
    expect(devShellCommandRejection('git push origin @', { headBranch: 'main' })).toMatch(/push/)
    expect(devShellCommandRejection('git push origin +HEAD', { headBranch: 'main' })).toMatch(/push/)
    expect(devShellCommandRejection('git push origin HEAD', { headBranch: 'peanut/x' })).toBeNull()
    expect(gitPushStatementTargetsProtected('git push origin HEAD')).toBe(false)
  })

  it('allows bare git push on feature branch', () => {
    expect(devShellCommandRejection('git push origin', { headBranch: 'feature/x' })).toBeNull()
  })

  it('rejects git merge and rebase when HEAD is main without checkout chain', () => {
    expect(devShellCommandRejection('git merge origin/feature', { headBranch: 'main' })).toMatch(/merge or rebase on/)
    expect(devShellCommandRejection('git rebase origin/main', { headBranch: 'master' })).toMatch(/merge or rebase on/)
    expect(devShellCommandRejection('git merge foo', { headBranch: 'feature/x' })).toBeNull()
  })

  it('rejects gh pr merge with global options', () => {
    expect(devShellCommandRejection('gh -R o/r pr merge 42')).toMatch(/gh pr merge/)
  })

  it('rejects git merge and rebase with global options', () => {
    expect(devShellCommandRejection('git -C . merge origin/feature', { headBranch: 'main' })).toMatch(/merge or rebase on/)
    expect(devShellCommandRejection('git -c k=v rebase origin/main', { headBranch: 'main' })).toMatch(/merge or rebase on/)
  })

  it('rejects nested shell wrappers around protected git operations', () => {
    expect(devShellCommandRejection("bash -c 'git push origin main'")).toMatch(/nested shells/)
    expect(devShellCommandRejection('sh -c \'git merge main\'', { headBranch: 'main' })).toMatch(/nested shells/)
    expect(devShellCommandRejection("bash -lc 'git push origin main'")).toMatch(/nested shells/)
    expect(devShellCommandRejection("bash -c 'echo ok'")).toBeNull()
  })

  it('rejects subshells wrapping protected git operations', () => {
    expect(devShellCommandRejection('(git push origin main)')).toMatch(/subshell/)
    expect(devShellCommandRejection('(git merge other)', { headBranch: 'main' })).toMatch(/subshell/)
  })

  it('rejects command substitution around protected refs', () => {
    expect(devShellCommandRejection('git push origin $(echo main)')).toMatch(/command substitution/)
    expect(devShellCommandRejection('git push origin `echo main`')).toMatch(/command substitution/)
    expect(devShellCommandRejection('git push origin ${BRANCH:-main}')).toMatch(/command substitution/)
  })

  it('rejects checkout of protected path then default push', () => {
    expect(devShellCommandRejection('git checkout main -- file && git push', { headBranch: 'peanut/x' })).toMatch(/protected ref/)
  })

  it('rejects --repo push mode that can select a local bare remote', () => {
    expect(gitPushStatementTargetsProtected('git push --repo=/tmp/mirror.git main')).toBe(true)
    expect(devShellCommandRejection('git push --repo=/tmp/mirror.git main')).toMatch(/push/)
  })

  it('allows merge origin/main into feature branch', () => {
    expect(devShellCommandRejection('git merge origin/main')).toBeNull()
  })

  it('throws UserError on reject', () => {
    expect(() => assertDevShellCommandAllowed('git push origin main')).toThrow(UserError)
    expect(() => assertDevShellCommandAllowed('pnpm test')).not.toThrow()
  })
})
