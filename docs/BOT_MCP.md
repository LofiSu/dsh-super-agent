# dsh-super-bot

A local stdio MCP server for ds-agent task and team status. Its tools read
the same SQLite state as the local CLI. They require no model credentials
and start no message consumer. The host can see task titles and team member
names, roles, and statuses, so connect only trusted MCP clients.

Build with `pnpm build`. Initialize the target state with
`DS_AGENT_HOME=/absolute/state node dist/cli/main.js init`, or use an existing
state directory. In a host that supports stdio MCP servers, add:

```json
{
  "mcpServers": {
    "dsh-super-bot": {
      "command": "node",
      "args": ["/absolute/checkout/dist/cli/main.js", "mcp"],
      "env": { "DS_AGENT_HOME": "/absolute/state" }
    }
  }
}
```

Use the equivalent server fields for hosts with different config formats.
For GUI hosts that do not inherit shell PATH, use the absolute path to Node 22+.
Ask the host to list ds-agent tasks or list team members for a ticket.

This version exposes inspection. Team creation, delegation, and approvals
continue to use the existing ds-agent entry points.

## Register with Codex or Claude Code

From the built checkout, choose the command for your host. Set
`DS_AGENT_HOME` to the same absolute state path used by ds-agent.

```sh
codex mcp add dsh-super-bot --env "DS_AGENT_HOME=$DS_AGENT_HOME" -- "$(command -v node)" "$PWD/dist/cli/main.js" mcp
claude mcp add --scope user --env "DS_AGENT_HOME=$DS_AGENT_HOME" dsh-super-bot -- "$(command -v node)" "$PWD/dist/cli/main.js" mcp
```

For DeepSeek Harness or any other host, use the stdio configuration above
if that host supports MCP. Keep the checkout at the registered location.
