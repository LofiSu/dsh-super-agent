# dsh-super-bot for DeepSeek Harness Desktop

This integration extends the local ds-super-agent-tab plugin. The installer
expects its client and sidecar layout. Install the existing tab into the
Harness desktop profile before using these scripts.

## Install and verify

From the ds-agent checkout, use Node.js 22 or later:

```sh
pnpm test:harness
node integrations/deepseek-harness/install-host.mjs /path/to/ds-super-agent-tab/desktop-server.js
node integrations/deepseek-harness/install.mjs /path/to/ds-super-agent-tab/client.js
```

Wait for active turns to finish, restart the local sidecar, and relaunch
Harness Desktop. Open Bots from the sidebar, the More menu, or the Bots
button in the ds-super-agent chat header. Create a Bot
using a ready device, open its conversation, and send a short test question.
Reopen the app and verify that the reply is still present. To test team
dispatch, create a second Bot, create a team with both Bots, and open the
saved dispatch in team history.

To use a separate ds-agent checkout with Bots, set `dsAgentCheckout` to its
absolute path in the sidecar state directory’s `bot-runtimes.json`. The checkout
needs its pnpm dependencies installed. The `DSH_BOT_DS_AGENT_CHECKOUT`
environment variable overrides this setting for a one-off launch.

See [runtime configuration and acceptance status](PARITY.md).
The sidecar stores profiles, turns, teams and proposals in its local
`bots.db`. Keep this database when updating or rolling back the plugin.

To use Claude Code with the local Magpie Messages endpoint, set
`claudeMagpieModel` in `bot-runtimes.json` to a Magpie model ID. The option
changes the provider for the Claude Code adapter. Other desktop runtimes
keep their own settings.

## Run a Bot on an SSH host

On the remote host, make `bot-ssh-worker.mjs` and `bot-context.mjs` available
in the same directory. Add an executable named `dsh-bot-runtime-v1` to the
SSH user's non-interactive PATH. For example, an owner-managed wrapper can
export `DSH_BOT_REMOTE_BIN` as the absolute path to an executable ds-agent CLI
launcher, load its provider configuration, and exec Node with the worker
script and its arguments. The remote CLI must support `tool-scope-capabilities`.

Register a working SSH alias in Bots → 运行设备. Its host key must already
be trusted, and SSH must work without interactive prompts. After the worker
handshake, the host becomes selectable for ds-agent. Remote turns use the
conversation-only scope.

## Trigger a Bot from a local workflow

Set a local ds-agent Bot to conversation-only. In its trigger settings, save
the fixed message and copy the one-time token. Use that token as the Authorization
bearer for a JSON POST to the displayed loopback URL. The body takes an event ID,
for example `{"id":"daily-summary-2026-11-27"}`. Use the same ID when retrying a
delivery. The response contains the turn ID and status. Read the reply in the Bot's
conversation. Saving the trigger again replaces its token, and leaving
conversation-only mode revokes it.

## Revert the plugin

The installers check generated files before upgrading. If an earlier install has
no integrity stamp or contains edits, keep a copy of the current file and
reapply the integration to a supported unmodified plugin file.

The installers keep the first unmodified files as `client.js.before-bots`
and `desktop-server.js.before-bot-api`. Later upgrades save numbered backups.
With the desktop closed and the sidecar stopped, restore both files from
the corresponding backups, then reopen Harness.
