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

To test a newer ds-agent checkout with Bots, set
`DSH_BOT_DS_AGENT_CHECKOUT` to its absolute path when starting the sidecar.
The checkout needs its pnpm dependencies installed.

See [runtime configuration and acceptance status](PARITY.md).
The sidecar stores profiles, turns, teams and proposals in its local
`bots.db`. Keep this database when updating or rolling back the plugin.

## Revert the plugin

The installers keep the first unmodified files as `client.js.before-bots`
and `desktop-server.js.before-bot-api`. Later upgrades save numbered backups.
With the desktop closed and the sidecar stopped, restore both files from
the corresponding backups, then reopen Harness.
