import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSshBotTransport, sshHostArguments } from './bot-ssh.mjs';

test('SSH Bot transport uses a fixed remote command and conversation-only execution', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ssh-transport-'));
  try {
    const ssh = join(home, 'ssh');
    const cli = join(home, 'ds-agent');
    const worker = fileURLToPath(new URL('./bot-ssh-worker.mjs', import.meta.url));
    await writeFile(cli, `#!${process.execPath}
const [operation, prompt] = process.argv.slice(2);
if (operation === 'tool-scope-capabilities') {
  console.log('ds-agent-tool-scope:conversation');
} else if (operation === 'chat' && process.env.DS_AGENT_TOOL_SCOPE === 'conversation' &&
    process.env.DS_AGENT_HOME && prompt.includes('QA prompt with')) {
  console.log('[runtime] model=HttpOpenAI');
  console.log('[reply] purpose=result text=Remote reply');
} else {
  process.exitCode = 1;
}
`, { mode: 0o700 });
    await writeFile(ssh, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.slice(-4,-1).join(' ') !== '-- qa-host dsh-bot-runtime-v1' ||
    !args.includes('StrictHostKeyChecking=yes') || !args.includes('ForwardAgent=no')) process.exit(1);
const child = spawnSync(process.execPath, [${JSON.stringify(worker)}, args.at(-1)], {
  stdio: 'inherit', env: { ...process.env, DSH_BOT_REMOTE_BIN: ${JSON.stringify(cli)} },
});
process.exitCode = child.status ?? 1;
`, { mode: 0o700 });
    assert.throws(() => sshHostArguments('-oProxyCommand'), RangeError);
    const resolve = createSshBotTransport({ executable: ssh });
    const configured = { id: 'remote', label: 'QA', alias: 'qa-host' };
    const device = await resolve(configured);
    assert.equal(device.connected, true);
    assert.equal(await device.adapters['ds-agent'](
      { name: 'QA', purpose: 'Answer' }, 'QA prompt with ";"', [],
    ), 'Remote reply');
    assert.deepEqual(await resolve({ ...configured, alias: 'unavailable' }), { ...configured, alias: 'unavailable' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
