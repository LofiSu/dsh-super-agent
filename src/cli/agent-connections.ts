import {
  bindAgentConnection, checkAgentConnection, discoverAgentConnections, loadAgentConnections, unbindAgentConnection,
} from '../env/agent-connections.ts'
import { UserError } from '../shared/errors.ts'

export const agentConnectionsUsage = `ds-agent agents discover [--json]
ds-agent agents bind <id> <codex|claude> [--profile <absolute-dir>] [--workspace-write]
ds-agent agents bind <id> bridge --command <absolute-executable> [--args-json <array>]
ds-agent agents list [--json]
ds-agent agents check <id> [--json]
ds-agent agents unbind <id>`

function parseArgs(args: string[], valueOptions: string[], booleanOptions: string[]): {
  positionals: string[]
  options: Map<string, string>
} {
  const positionals: string[] = []
  const options = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (!arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }
    if (options.has(arg)) throw new UserError(`duplicate option ${arg}`)
    if (booleanOptions.includes(arg)) {
      options.set(arg, 'true')
    } else if (valueOptions.includes(arg)) {
      const value = args[++index]
      if (value === undefined || value.startsWith('--')) throw new UserError(`missing value for ${arg}`)
      options.set(arg, value)
    } else {
      throw new UserError('unknown agent connection option')
    }
  }
  return { positionals, options }
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

export function runAgentConnectionsCommand(home: string, command: string, argv: string[]): void {
  const bind = command === 'bind'
  const { positionals, options } = parseArgs(
    argv,
    bind ? ['--profile', '--command', '--args-json'] : [],
    bind ? ['--workspace-write'] : command === 'unbind' ? [] : ['--json'],
  )
  const count = command === 'bind' ? 2 : command === 'check' || command === 'unbind' ? 1 : 0
  if (positionals.length !== count) throw new UserError(agentConnectionsUsage)
  const json = options.has('--json')
  if (command === 'discover') {
    const found = discoverAgentConnections()
    if (json) printJson(found)
    else for (const entry of found) console.log(`${entry.provider}\t${entry.executable ?? 'not installed'}`)
    return
  }
  if (command === 'list') {
    const connections = loadAgentConnections(home).map(({ id, provider, access, profile }) => ({
      id, provider, access, profile: profile ? 'custom' : 'default',
    }))
    if (json) printJson(connections)
    else if (connections.length === 0) console.log('No agent accounts bound. Run ds-agent agents discover to find supported clients.')
    else for (const entry of connections) console.log(`${entry.id}\t${entry.provider}\t${entry.access}\t${entry.profile} profile`)
    return
  }
  const id = positionals[0]!
  if (bind) {
    let args: unknown
    if (options.has('--args-json')) {
      try {
        args = JSON.parse(options.get('--args-json')!)
      } catch {
        throw new UserError('--args-json must be a JSON array')
      }
    }
    const connection = bindAgentConnection(home, id, positionals[1]!, {
      profile: options.get('--profile'),
      command: options.get('--command'),
      write: options.has('--workspace-write'),
      args,
    })
    console.log(`Bound ${connection.id} to ${connection.provider} (${connection.access}).`)
    console.log(`Run ds-agent agents check ${connection.id} to inspect the connection. A running daemon must restart to reload bindings.`)
    return
  }
  if (command === 'unbind') {
    unbindAgentConnection(home, id)
    console.log(`Removed binding ${id}. A running daemon must restart to reload bindings.`)
    return
  }
  if (command === 'check') {
    const connection = loadAgentConnections(home).find(entry => entry.id === id)
    if (!connection) throw new UserError('unknown agent connection id')
    const check = checkAgentConnection(connection)
    if (json) printJson(check)
    else {
      console.log(`${connection.id}\t${check.status}`)
      if (check.status === 'needs-login') {
        console.log(connection.provider === 'codex'
          ? 'Sign in with the official CLI using codex login and the selected CODEX_HOME.'
          : 'Sign in with the official CLI using claude auth login and the selected CLAUDE_CONFIG_DIR.')
      }
    }
    return
  }
  throw new UserError(agentConnectionsUsage)
}

export function printAgentSetup(home: string): void {
  let bound: ReturnType<typeof loadAgentConnections> = []
  try {
    bound = loadAgentConnections(home)
  } catch {
    console.log('Could not read saved AI agent connections. Run ds-agent agents list for details.')
  }
  const supported = discoverAgentConnections()
  console.log('AI agent connections:')
  for (const entry of supported) {
    const count = bound.filter(connection => connection.provider === entry.provider).length
    const state = entry.executable ? `installed, ${count} bound` : 'not installed'
    console.log(`  ${entry.provider}: ${state}`)
  }
  console.log('Connect an existing CLI account with ds-agent agents bind <id> <codex|claude>. Sign-in stays in the official client.')
  console.log('You can skip account binding and run setup again later.')
}
