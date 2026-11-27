import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ticketStage } from '../core/stage.ts'
import type { TeamRecord } from '../harness/team.ts'
import type { Ticket } from '../shared/types.ts'
import { visibleTickets } from '../speculate/index.ts'
import { Store } from '../store/sqlite.ts'

const tools = [
  {
    name: 'list_tasks',
    description: 'List visible ds-agent tasks and their current stages.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'list_teams',
    description: 'List existing ds-agent teams and member status. Optionally filter by exact ticket ID.',
    inputSchema: {
      type: 'object' as const,
      properties: { ticketId: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    },
  },
].map(tool => ({ ...tool, annotations: { readOnlyHint: true, openWorldHint: false } }))

export async function runBotMcp(home: string): Promise<void> {
  const server = new Server(
    { name: 'dsh-super-bot', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
    const args = params.arguments ?? {}
    const ticketId = args.ticketId
    const valid = params.name === 'list_tasks'
      ? Object.keys(args).length === 0
      : params.name === 'list_teams'
        && Object.keys(args).every(key => key === 'ticketId')
        && (ticketId === undefined || (typeof ticketId === 'string' && ticketId.trim().length > 0))
    if (!valid) {
      return { isError: true, content: [{ type: 'text', text: 'Unknown tool or invalid arguments.' }] }
    }

    try {
      const store = Store.openReadOnly(home)
      try {
        const rows = params.name === 'list_tasks'
          ? visibleTickets(store.listDocs<Ticket>('ticket')).map(ticket => ({
            id: ticket.id, title: ticket.title, stage: ticketStage(ticket),
          }))
          : store.listDocs<TeamRecord>('team')
            .filter(team => ticketId === undefined || team.ticketId === ticketId)
            .map(team => ({
              id: team.id,
              ticketId: team.ticketId,
              completedAt: team.completedAt,
              members: team.members.map(({ name, role, status }) => ({ name, role, status })),
            }))
        return { content: [{ type: 'text', text: JSON.stringify(rows) }] }
      } finally {
        store.close()
      }
    } catch {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Cannot read ds-agent state. Verify DS_AGENT_HOME and run ds-agent init.' }],
      }
    }
  })
  await server.connect(new StdioServerTransport())
}
