import { readFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ErrorCode, ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ticketStage } from '../core/stage.ts'
import type { TeamRecord } from '../harness/team.ts'
import type { Ticket } from '../shared/types.ts'
import { visibleTickets } from '../speculate/index.ts'
import { Store } from '../store/sqlite.ts'

import { dashboardUri, renderBotDashboard } from './bot-dashboard.ts'

const dashboardResource = {
  uri: dashboardUri,
  name: 'dsh-super-bot dashboard',
  mimeType: 'text/html;profile=mcp-app',
}

const tools = [
  {
    name: 'open_dashboard',
    description: 'Open the dsh-super-bot task and team dashboard.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    _meta: {
      ui: { resourceUri: dashboardUri },
      'openai/ui': { entrypoints: [{ type: 'global' }] },
    },
  },
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
    { capabilities: { tools: {}, resources: {} } },
  )
  let proposalToken = process.env.DSH_BOT_PROPOSAL_TOKEN?.trim()
  const tokenFile = process.env.DSH_BOT_PROPOSAL_TOKEN_FILE
  if (!proposalToken && tokenFile) {
    try {
      proposalToken = readFileSync(tokenFile, 'utf8').trim()
    } catch {
      // Proposal access is optional; keep read-only tools available.
    }
  }
  const proposalPort = Number(process.env.DSH_BOT_PROPOSAL_PORT ?? 4328)
  const proposalEnabled = Boolean(proposalToken && proposalToken.length >= 32 &&
    Number.isInteger(proposalPort) && proposalPort > 0 && proposalPort <= 65535)
  const proposalTool = {
    name: 'propose_bot',
    description: 'Submit a Bot draft for owner review in DeepSeek Harness.',
    inputSchema: {
      type: 'object' as const,
      properties: { name: { type: 'string' }, purpose: { type: 'string' } },
      required: ['name', 'purpose'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  }
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: proposalEnabled ? [...tools, proposalTool] : tools,
  }))
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [dashboardResource] }))
  server.setRequestHandler(ReadResourceRequestSchema, ({ params }) => {
    if (params.uri !== dashboardUri) throw new McpError(ErrorCode.InvalidParams, 'Unknown resource')
    return { contents: [{ ...dashboardResource, text: renderBotDashboard(home) }] }
  })
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments ?? {}
    if (params.name === 'propose_bot' && proposalEnabled) {
      const { name, purpose } = args
      if (typeof name !== 'string' || !name.trim() || name.length > 80 ||
          typeof purpose !== 'string' || !purpose.trim() || purpose.length > 1000 ||
          Object.keys(args).some(key => key !== 'name' && key !== 'purpose')) {
        return { isError: true, content: [{ type: 'text', text: 'Supply a valid Bot name and purpose.' }] }
      }
      try {
        const response = await fetch(`http://127.0.0.1:${proposalPort}/api/bots/offers`, {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: 'Bearer ' + proposalToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, purpose, device: 'local', engine: 'ds-agent' }),
          signal: AbortSignal.timeout(5000),
        })
        if (response.status !== 201) throw new Error('Proposal not accepted')
        const result = await response.json()
        return { content: [{ type: 'text', text: 'Awaiting owner approval. Proposal ID: ' + result.id }] }
      } catch {
        return { isError: true, content: [{ type: 'text', text: 'Harness could not confirm receipt of the proposal.' }] }
      }
    }
    if (params.name === 'open_dashboard' && Object.keys(args).length === 0) {
      return { content: [{ type: 'text', text: 'Dashboard available in compatible hosts. Use list_tasks and list_teams for text results.' }] }
    }
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
