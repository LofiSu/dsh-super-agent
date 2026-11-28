#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
    echo "The macOS bundle must be built on macOS." >&2
    exit 1
fi

desktop_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node_dir=$(dirname "$(command -v node)")
cd "$desktop_dir/.."
repo_dir=$(pwd)
pnpm build
export CARGO_TARGET_DIR="$desktop_dir/target"
cargo build --locked --manifest-path "$desktop_dir/Cargo.toml"

bundle="$CARGO_TARGET_DIR/DeepSeek Super Agent.app/Contents"
mkdir -p "$bundle/MacOS" "$bundle/Resources"
cp "$CARGO_TARGET_DIR/debug/ds-agent-desktop" "$bundle/MacOS/ds-agent-desktop"
printf '%s\n' "$node_dir" > "$bundle/Resources/node-dir"
printf '%s\n' "$repo_dir" > "$bundle/Resources/repo-dir"
cat > "$bundle/MacOS/launch" <<'LAUNCH'
#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH="$(cat "$here/../Resources/node-dir"):$PATH"
export PATH
cd "$(cat "$here/../Resources/repo-dir")"
exec "$here/ds-agent-desktop" "$@"
LAUNCH
chmod +x "$bundle/MacOS/launch"
cat > "$bundle/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIdentifier</key><string>com.lofisu.ds-agent.desktop</string>
  <key>CFBundleName</key><string>DeepSeek Super Agent</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
printf '%s\n' "$CARGO_TARGET_DIR/DeepSeek Super Agent.app"
