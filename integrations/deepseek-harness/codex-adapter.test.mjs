import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createCodexAdapter } from './codex-adapter.mjs';

test('Codex adapter waits for the cancelled child to exit', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-cancel-'));
  const executable = join(root, 'fixture.cjs');
  const bot = { id: randomUUID(), name: 'QA', purpose: 'Cancellation test' };
  const pidFile = join(root, bot.id, 'pid');
  const controller = new AbortController();
  try {
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));
fs.writeFileSync('pid', String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    const run = createCodexAdapter({ executable, workspaceRoot: root });
    const finished = assert.rejects(run(bot, 'Test', [], controller.signal), { name: 'AbortError' });
    let pid;
    for (let i = 0; !pid && i < 450; i++) {
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
      if (!pid) await delay(20);
    }
    controller.abort();
    await finished;
    assert.ok(pid);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});
