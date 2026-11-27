import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { UserError } from '../shared/errors.ts'
import { loadLocalAgents, MAX_LOCAL_AGENTS, normalizeLocalAgents, type LocalAgentSpec } from './local-agents.ts'
import { ENV_ALLOWLIST, redactCredentialPatterns } from './sanitize.ts'

const CONNECTIONS_FILE = 'agent-connections.json'
const PROVIDERS = ['codex', 'claude', 'bridge'] as const
type Provider = typeof PROVIDERS[number]
type Access = 'read-only' | 'workspace-write' | 'bridge-defined'

export interface AgentConnection {
  id: string
  provider: Provider
  executable: string
  access: Access
  profile?: string
  args?: string[]
}

export interface AgentDiscovery {
  provider: 'codex' | 'claude'
  executable?: string
}

function executablePath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!path.isAbsolute(command) && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(command)) return undefined
  const candidates = path.isAbsolute(command)
    ? [command]
    : (env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, command))
  return candidates.find(candidate => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

export function discoverAgentConnections(env: NodeJS.ProcessEnv = process.env): AgentDiscovery[] {
  return (['codex', 'claude'] as const).map(provider => {
    const executable = executablePath(provider, env)
    return { provider, ...(executable ? { executable } : {}) }
  })
}

function validateBridgeArgs(args: unknown): string[] {
  if (!Array.isArray(args) || args.length > 16 || args.some(arg =>
    typeof arg !== 'string' || arg.length > 256 || /[\x00-\x1f]/.test(arg)
    || /(?:\b(?:api[-_]?key|access[-_]?token|token|secret|password|authorization|credential)\b|\w+:\/\/)/i.test(arg)
    || redactCredentialPatterns(arg) !== arg
    || (arg.includes('{task}') && arg !== '{task}'),
  )) throw new UserError('bridge argv must be fixed non-secret strings, with {task} in its own argument')
  if (args.filter(arg => arg === '{task}').length > 1) throw new UserError('bridge argv may contain one {task} argument')
  return [...args] as string[]
}

function validatedConnection(value: unknown): AgentConnection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserError('invalid agent connection')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['id', 'provider', 'executable', 'access', 'profile', 'args'].includes(key))) {
    throw new UserError('agent connection contains an unsupported field')
  }
  const { id, provider, executable, access, profile } = raw
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(id)) throw new UserError('invalid agent connection id')
  if (provider !== 'codex' && provider !== 'claude' && provider !== 'bridge') throw new UserError('unknown agent connection provider')
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || /[\x00-\x1f{}]/.test(executable)) {
    throw new UserError('agent connection requires an absolute executable path')
  }
  if (provider === 'bridge') {
    if (profile !== undefined || access !== 'bridge-defined') throw new UserError('bridge access and credentials belong to its executable')
    return { id, provider, executable, access, args: validateBridgeArgs(raw.args ?? []) }
  }
  if (raw.args !== undefined || (access !== 'read-only' && access !== 'workspace-write')) {
    throw new UserError('provider preset requires built-in argv and a valid workspace permission')
  }
  if (profile !== undefined && (typeof profile !== 'string' || !path.isAbsolute(profile) || /[\x00-\x1f{}]/.test(profile))) {
    throw new UserError('agent profile must be an absolute directory')
  }
  return { id, provider, executable, access, ...(profile ? { profile } : {}) }
}

export function loadAgentConnections(home: string): AgentConnection[] {
  let raw: unknown
  try {
    const fd = fs.openSync(path.join(home, CONNECTIONS_FILE), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      const metadata = fs.fstatSync(fd)
      if (!metadata.isFile() || metadata.size > 128_000 || (metadata.mode & 0o077) !== 0) {
        throw new UserError('agent connections must be a private regular file of at most 128 KB')
      }
      raw = JSON.parse(fs.readFileSync(fd, 'utf8'))
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    if (error instanceof UserError) throw error
    throw new UserError('could not read the local agent connection metadata')
  }
  if (!Array.isArray(raw) || raw.length > MAX_LOCAL_AGENTS) throw new UserError('invalid agent connections list')
  const connections = raw.map(validatedConnection)
  if (new Set(connections.map(connection => connection.id)).size !== connections.length) {
    throw new UserError('duplicate agent connection id')
  }
  return connections
}

function changeConnections(home: string, update: (current: AgentConnection[]) => AgentConnection[]): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const file = path.join(home, CONNECTIONS_FILE)
  // SQLite's process-owned lock is released even if the setup process dies.
  const lockFile = file + '.sqlite-lock'
  const fd = fs.openSync(lockFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600)
  try {
    const info = fs.fstatSync(fd)
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new UserError('agent connection lock must be a private regular file')
  } finally {
    fs.closeSync(fd)
  }
  const lock = new DatabaseSync(lockFile)
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    lock.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE')
    const next = update(loadAgentConnections(home))
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally {
    lock.close()
    fs.rmSync(temporary, { force: true })
  }
}

export function bindAgentConnection(home: string, id: string, provider: string, options: {
  profile?: string
  write?: boolean
  command?: string
  args?: unknown
}, env: NodeJS.ProcessEnv = process.env): AgentConnection {
  if (!PROVIDERS.some(candidate => candidate === provider)) throw new UserError('unknown agent provider; use codex, claude, or bridge')
  const bridge = provider === 'bridge'
  if (bridge && (!options.command || !path.isAbsolute(options.command) || options.write || options.profile)) {
    throw new UserError('bridge requires its own absolute --command and defines its own access')
  }
  if (!bridge && (options.command !== undefined || options.args !== undefined)) {
    throw new UserError('only a bridge accepts --command or --args-json')
  }
  if (options.profile !== undefined && (!path.isAbsolute(options.profile) || /[\x00-\x1f{}]/.test(options.profile))) {
    throw new UserError('agent profile must be an absolute directory')
  }
  const executable = executablePath(options.command ?? provider, env)
  if (!executable) throw new UserError('provider executable is unavailable')
  const profile = options.profile && fs.realpathSync(options.profile)
  if (profile && !fs.statSync(profile).isDirectory()) throw new UserError('agent profile must be a directory')
  const connection = validatedConnection({
    id,
    provider,
    executable,
    access: bridge ? 'bridge-defined' : options.write ? 'workspace-write' : 'read-only',
    ...(profile ? { profile } : {}),
    ...(bridge ? { args: options.args ?? [] } : {}),
  })
  changeConnections(home, current => {
    const existing = loadLocalAgents(home, env)
    if (current.some(entry => entry.id === id) || existing.some(entry => entry.id === id)) {
      throw new UserError('agent connection id is already configured')
    }
    if (current.length + existing.length >= MAX_LOCAL_AGENTS) throw new UserError('too many agent connections')
    return [...current, connection]
  })
  return connection
}

export function unbindAgentConnection(home: string, id: string): void {
  changeConnections(home, current => {
    if (!current.some(connection => connection.id === id)) throw new UserError('unknown agent connection id')
    return current.filter(connection => connection.id !== id)
  })
}

function profileEnvironment(connection: AgentConnection): { CODEX_HOME?: string; CLAUDE_CONFIG_DIR?: string } {
  if (!connection.profile) return {}
  return connection.provider === 'codex'
    ? { CODEX_HOME: connection.profile }
    : { CLAUDE_CONFIG_DIR: connection.profile }
}

export function loadBoundAgentSpecs(home: string): LocalAgentSpec[] {
  const connections = loadAgentConnections(home)
  const specs = normalizeLocalAgents(connections.map(connection => {
    const { id, executable: command, provider, access } = connection
    const args = provider === 'bridge'
      ? connection.args
      : provider === 'codex'
        ? ['--ask-for-approval', 'never', 'exec', '--json', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', access, '--', '{task}']
        : ['-p', '--output-format', 'json', '--restricted', '--safe-mode', '--strict-mcp-config', '--permission-mode', access === 'read-only' ? 'plan' : 'acceptEdits',
          '--tools', access === 'read-only' ? 'Read,Grep,Glob' : 'Read,Grep,Glob,Edit,Write', '--', '{task}']
    return { id, command, args, description: `Bound ${provider} connection (${access})` }
  }))
  return specs.map((spec, index) => {
    const connection = connections[index]!
    return connection.profile ? { ...spec, profileEnvironment: profileEnvironment(connection) } : spec
  })
}

export function checkAgentConnection(connection: AgentConnection, env: NodeJS.ProcessEnv = process.env): {
  id: string
  status: 'missing-executable' | 'missing-profile' | 'executable-only' | 'ready' | 'needs-login' | 'unavailable'
} {
  const { id, executable, provider, profile } = connection
  if (!executablePath(executable, env)) return { id, status: 'missing-executable' }
  if (profile && !fs.statSync(profile, { throwIfNoEntry: false })?.isDirectory()) return { id, status: 'missing-profile' }
  if (provider === 'bridge') return { id, status: 'executable-only' }
  const childEnv: NodeJS.ProcessEnv = { ...profileEnvironment(connection) }
  for (const key of ENV_ALLOWLIST) {
    if (env[key] !== undefined) childEnv[key] = env[key]
  }
  const result = spawnSync(executable, provider === 'codex' ? ['login', 'status'] : ['auth', 'status'], {
    env: childEnv,
    cwd: env.HOME,
    timeout: 5_000,
    maxBuffer: 16_000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.signal) return { id, status: 'unavailable' }
  if (provider === 'codex') return { id, status: result.status === 0 ? 'ready' : 'needs-login' }
  try {
    const status = JSON.parse(result.stdout) as { authMethod?: unknown; loggedIn?: unknown }
    if (typeof status.authMethod === 'string' || typeof status.loggedIn === 'boolean') {
      if (result.status === 0) return { id, status: 'ready' }
      if (result.status === 1) return { id, status: 'needs-login' }
    }
  } catch {
    // Provider output can include account metadata. Keep it out of CLI results.
  }
  return { id, status: 'unavailable' }
}
