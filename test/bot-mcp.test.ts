import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test } from 'vitest'
import { Store } from '../src/store/sqlite.ts'

test('dsh-super-bot exposes read-only tools over stdio', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-super-bot-'))
  const client = new Client({ name: 'test-host', version: '1' })
  try {
    new Store(home).close()
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/cli/main.ts', 'mcp'],
      env: { DS_AGENT_HOME: home },
      stderr: 'pipe',
    }))
    expect(client.getServerVersion()?.name).toBe('dsh-super-bot')
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['list_tasks', 'list_teams'])
    expect(await client.callTool({ name: 'list_tasks' })).toMatchObject({
      content: [{ type: 'text', text: '[]' }],
    })
    expect(await client.callTool({ name: 'list_teams', arguments: { ticketId: 42 } })).toMatchObject({
      isError: true,
    })
  } finally {
    await client.close()
    rmSync(home, { recursive: true, force: true })
  }
})
