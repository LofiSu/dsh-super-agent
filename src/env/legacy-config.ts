import { UserError } from '../shared/errors.ts'

/** Refuse stale configuration before defaults can weaken an existing policy. */
export function rejectLegacyConfig(env: NodeJS.ProcessEnv): void {
  const legacyNames = Object.keys(env)
    .filter(name => name.startsWith('DS_AGENT_') && env[name])
    .sort()
  if (legacyNames.length === 0) return

  const replacements = legacyNames.map(name => `${name} → LOFIBOT_${name.slice('DS_AGENT_'.length)}`)
  throw new UserError(`Rename and unset old environment variables before starting LofiBot: ${replacements.join(', ')}`)
}
