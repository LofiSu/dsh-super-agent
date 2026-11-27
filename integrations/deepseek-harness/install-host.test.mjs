import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('generated desktop host reports its bound port and serves Bot inventory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-port-'));
  const file = join(root, 'host.mjs');
  const launcher = join(root, 'launcher');
  let host;
  try {
    writeFileSync(launcher, "#!/bin/sh\ntest -f .bot-checkout-fixture || exit 1\nprintf '%s\\n' ds-agent-tool-scope:conversation\n", { mode: 0o700 });
    writeFileSync(file, `
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const HOME = ${JSON.stringify(join(root, 'state'))};
const DESKTOP_SECRET = 'fixture';
const log = () => {};
const NODE = ${JSON.stringify(launcher)};
const REPO = ${JSON.stringify(root)};
const spawnEnv = () => process.env;
const isAllowedHost = host => /^127\\.0\\.0\\.1:\\d+$/.test(host);
const send = (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
export function startDesktopServer({ port }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      send(res, 404, {});
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(\`listening on 127.0.0.1:\${port}\`);
      resolve({
        port,
        url: \`http://127.0.0.1:\${port}\`,
        close: () => new Promise((done, fail) => server.close(error => error ? fail(error) : done())),
      });
    });
  });
}
`);
    execFileSync(process.execPath, [fileURLToPath(new URL('./install-host.mjs', import.meta.url)), file]);
    const state = join(root, 'state');
    mkdirSync(state);
    const botCheckout = join(root, 'bot-checkout');
    mkdirSync(botCheckout);
    writeFileSync(join(botCheckout, '.bot-checkout-fixture'), 'fixture');
    const notExecutable = join(root, 'not-executable');
    writeFileSync(notExecutable, 'fixture', { mode: 0o600 });
    writeFileSync(join(state, 'bot-runtimes.json'), JSON.stringify({ codex: root, claude: notExecutable, dsAgentCheckout: botCheckout }));
    const { startDesktopServer } = await import(pathToFileURL(file));
    host = await startDesktopServer({ port: 0 });
    assert.ok(host.port > 0);
    assert.equal(Number(new URL(host.url).port), host.port);
    const response = await fetch(host.url + '/api/bots', {
      headers: { Origin: 'dsh-app://app', 'X-Ds-Desktop': 'fixture' },
    });
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.deepEqual(snapshot.bots, []);
    assert.deepEqual(snapshot.devices[0].engines, ['ds-agent']);
    assert.deepEqual(snapshot.devices[0].toolScopes, ['conversation']);
    const unknown = await fetch(host.url + '/api/bots/not-a-route', {
      headers: { Origin: 'dsh-app://app', 'X-Ds-Desktop': 'fixture' },
    });
    assert.equal(unknown.status, 404);
    const gatedTrigger = await fetch(host.url + '/api/bots/00000000-0000-0000-0000-000000000000/trigger', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(gatedTrigger.status, 403);
    const edited = readFileSync(file, 'utf8') + '\n// owner modification\n';
    writeFileSync(file, edited);
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('./install-host.mjs', import.meta.url)), file], {
      stdio: 'pipe',
    }), /cannot verify the current file/);
    assert.equal(readFileSync(file, 'utf8'), edited);
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
