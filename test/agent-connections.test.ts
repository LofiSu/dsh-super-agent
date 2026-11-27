import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadBoundAgentSpecs } from '../src/env/agent-connections.ts'

const homes: string[] = []
function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-connections-'))
  homes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function cli(homeDir: string, ...args: string[]) {
  const bin = path.join(homeDir, 'bin')
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', DS_AGENT_HOME: homeDir, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  })
}

describe('local agent connections', () => {
  it('discovers installed clients and binds, checks, lists, and unbinds a named local profile', () => {
    const dir = home()
    const bin = path.join(dir, 'bin')
    const profile = path.join(dir, 'codex-work')
    fs.mkdirSync(bin)
    fs.mkdirSync(profile)
    const binary = path.join(bin, 'codex')
    fs.writeFileSync(binary, '#!/bin/sh\nif [ "$1 $2" = "login status" ] && [ -d "$CODEX_HOME" ]; then exit 0; fi\nexit 1\n', { mode: 0o700 })
    expect(cli(dir, 'agents', 'discover', '--json').stdout).toContain(binary)
    const bound = cli(dir, 'agents', 'bind', 'work-codex', 'codex', '--profile', profile)
    expect(bound.status, bound.stderr).toBe(0)
    const checked = cli(dir, 'agents', 'check', 'work-codex', '--json')
    expect(checked.status, checked.stderr).toBe(0)
    expect(JSON.parse(checked.stdout)).toMatchObject({ id: 'work-codex', status: 'ready' })
    expect(JSON.parse(cli(dir, 'agents', 'list', '--json').stdout)).toEqual([
      expect.objectContaining({ id: 'work-codex', provider: 'codex', access: 'read-only' }),
    ])
    expect(loadBoundAgentSpecs(dir)[0]?.args).toEqual(expect.arrayContaining(['--ignore-user-config', '--sandbox', 'read-only']))
    expect(fs.statSync(path.join(dir, 'agent-connections.json')).mode & 0o777).toBe(0o600)
    const unbound = cli(dir, 'agents', 'unbind', 'work-codex')
    expect(unbound.status, unbound.stderr).toBe(0)
    expect(JSON.parse(cli(dir, 'agents', 'list', '--json').stdout)).toEqual([])
    expect(fs.existsSync(profile)).toBe(true)
  })

  it('keeps user extensions outside the Claude preset', () => {
    const dir = home()
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const result = cli(dir, 'agents', 'bind', 'review-claude', 'claude')
    expect(result.status, result.stderr).toBe(0)
    expect(loadBoundAgentSpecs(dir)[0]?.args).toEqual(expect.arrayContaining([
      '--restricted', '--safe-mode', '--strict-mcp-config', '--tools', 'Read,Grep,Glob',
    ]))
  })

  it('allows a named fixed executable bridge and rejects option or credential-shaped argv', () => {
    const dir = home()
    const bin = path.join(dir, 'bridge')
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    expect(cli(dir, 'agents', 'bind', 'personal-bot', 'bridge', '--command', bin, '--args-json', '["run","{task}"]').status).toBe(0)
    const check = cli(dir, 'agents', 'check', 'personal-bot', '--json')
    expect(JSON.parse(check.stdout)).toMatchObject({ status: 'executable-only' })
    expect(cli(dir, 'agents', 'bind', 'bad', 'bridge', '--command', bin, '--args-json', '["--api-key","token","{task}"]').status).not.toBe(0)
    expect(cli(dir, 'agents', 'bind', '../bad', 'bridge', '--command', bin).status).not.toBe(0)
    expect(cli(dir, 'agents', 'bind', 'personal-bot', 'bridge', '--command', bin).status).not.toBe(0)
  })
})
