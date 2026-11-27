import { describe, expect, it } from 'vitest'
import { LocalEnv } from '../src/env/local-env.ts'
import { tempHome } from './fixtures.ts'

describe('LocalEnv timeout', () => {
  it('releases the turn when a grandchild keeps stdout open', async () => {
    const env = new LocalEnv(tempHome(), { timeoutMs: 150, sandbox: { enabled: false } })
    const started = Date.now()
    const result = await env.bash('worker', 'bash -c "sleep 3; echo late"')
    expect(Date.now() - started).toBeLessThan(1500)
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain('late')
  })
  it('stops detached Bash groups when an isolated runtime requests cancellation', async () => {
    const env = new LocalEnv(tempHome(), { timeoutMs: 5000, sandbox: { enabled: false } })
    const command = env.bash('cancelled', 'bash -c "sleep 3; echo late"')
    env.killShells()
    const result = await command
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain('late')
  })

})
