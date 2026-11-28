# DeepSeek Super Agent desktop

The desktop client uses Rune for native GPU drawing, text shaping, layout, animations, and headless rendering. It launches the existing Node Agent over a private standard-input/output pipe when you send your first message. Responses appear as the Agent produces complete reply messages. Task status and approval notices appear within the turn.

## Run from source

Install Node 22+, pnpm, and Rust 1.99.1 or later. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
cargo run --locked --manifest-path desktop/Cargo.toml
```

Use the same local home and model configuration as `ds-agent chat`. The bridge reads the built CLI relative to this checkout. Set `DS_AGENT_DESKTOP_CLI` to an executable path to use an alternate CLI. The conversation is scoped to the current desktop process. Sound is off by default. The Sound button enables the synthesized completion and attention cues.

On macOS, run `desktop/scripts/bundle-macos.sh` and double-click the resulting app under `desktop/target`. The development bundle uses the checkout's built CLI and local Node installation. Configure the model through the CLI's persisted configuration for Finder launches.

## Headless preview

The example scene runs offline and renders the same view as the desktop window.

```sh
cargo run --locked --manifest-path desktop/Cargo.toml -- --scene example --snap /tmp/ds-agent.png --tree /tmp/ds-agent-tree.json
cargo run --locked --manifest-path desktop/Cargo.toml -- --scene example --script desktop/scripts/chat-smoke.json --at 0.5 --tree /tmp/ds-agent-chat.json
```

The script presses Send in the example scene. The element tree should contain the fixture reply `2 tasks completed, 1 pending`.

See [third-party notices](THIRD_PARTY_NOTICES.md) for the upstream sound code.
