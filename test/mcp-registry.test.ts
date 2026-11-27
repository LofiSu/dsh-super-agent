import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bindRolePorts } from '../src/core/role-ports.ts'
import { LocalEnv } from '../src/env/local-env.ts'
import type { McpToolSourceLike } from '../src/harness/mcp.ts'
import { ToolRegistry } from '../src/harness/tools.ts'
import type { Runtime } from '../src/runtime.ts'
import { freshRuntime, shutdown } from './fixtures.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  if (runtime) await shutdown(runtime)
  runtime = undefined
})

function registry(mcp: McpToolSourceLike, allowedToolNames?: ReadonlySet<string>): ToolRegistry {
  if (!runtime) throw new Error('runtime not created')
  return new ToolRegistry({
    store: runtime.store,
    ports: bindRolePorts(runtime.engine),
    env: new LocalEnv(path.join(runtime.home, 'workspaces')),
    metrics: runtime.metrics,
    redact: text => text,
    log: () => {},
    scheduleJob: () => {},
    routerTurn: async () => {},
    mcp,
    allowedToolNames,
  })
}

describe('ToolRegistry with an MCP source', () => {
  it('exposes namespaced MCP tools to workers only and routes their calls', async () => {
    runtime = freshRuntime()
    let closed = false
    const stub: McpToolSourceLike = {
      specs: async () => [{
        name: 'mcp__fake__echo',
        description: 'echo',
        parameters: { type: 'object' as const },
      }],
      invoke: async (name: string, args: Record<string, unknown>) => ({ name, args }),
      close: async () => { closed = true },
    }
    const tools = registry(stub)

    expect((await tools.specsFor('worker')).some(tool => tool.name === 'mcp__fake__echo')).toBe(true)
    expect((await tools.specsFor('router')).some(tool => tool.name.startsWith('mcp__'))).toBe(false)

    await expect(tools.invoke(
      { id: '1', name: 'mcp__fake__echo', args: { text: 'hi' } },
      { sessionId: 's', role: 'worker' },
    )).resolves.toEqual({ name: 'mcp__fake__echo', args: { text: 'hi' } })

    await tools.close()
    expect(closed).toBe(true)
  })

  it('enforces restricted runtime tools on both discovery and invocation', async () => {
    runtime = freshRuntime()
    const tools = registry({
      specs: async () => { throw new Error('MCP discovery must stay off') },
      invoke: async () => { throw new Error('MCP invocation must stay off') },
      close: async () => {},
    }, new Set(['list_tasks', 'report_to_router', 'read_object']))
    const worker = { sessionId: 's', role: 'worker' } as const

    expect((await tools.specsFor('worker')).map(spec => spec.name).sort()).toEqual([
      'read_object', 'report_to_router',
    ])
    await expect(tools.invoke({ id: 'restricted', name: 'bash', args: {} }, worker))
      .rejects.toThrow(/not available in this runtime/)
    await expect(tools.invoke({ id: 'external', name: 'mcp__fake__echo', args: {} }, worker))
      .rejects.toThrow(/not available in this runtime/)
    await expect(tools.invoke({ id: 'allowed', name: 'list_tasks', args: {} }, { sessionId: 'router', role: 'router' })).resolves.toBeDefined()
  })

  it('refuses MCP tool calls from the router role', async () => {
    runtime = freshRuntime()
    const tools = registry({
      specs: async () => [],
      invoke: async () => 'should not run',
      close: async () => {},
    })

    await expect(tools.invoke(
      { id: '2', name: 'mcp__fake__echo', args: {} },
      { sessionId: 'router', role: 'router' },
    )).rejects.toThrow(/not available to router/)
  })
})
