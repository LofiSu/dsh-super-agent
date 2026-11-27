import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClaudeAdapter } from './claude-adapter.mjs';

test('Claude adapter can select the local Magpie provider for its child only', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-claude-provider-'));
  try {
    const executable = join(workspaceRoot, 'claude');
    await writeFile(executable, `#!${process.execPath}
if (process.env.ANTHROPIC_BASE_URL !== 'http://127.0.0.1:3425' ||
    process.env.ANTHROPIC_MODEL !== 'fixture/model' || !process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY) process.exit(1);
console.log(JSON.stringify({result: 'OK'}));
`, { mode: 0o700 });
    const model = process.env.ANTHROPIC_MODEL;
    const run = createClaudeAdapter({ executable, workspaceRoot, magpieModel: 'fixture/model' });
    const bot = { id: crypto.randomUUID(), name: 'QA', purpose: 'Answer' };
    assert.equal(await run(bot, 'Test', []), 'OK');
    assert.equal(process.env.ANTHROPIC_MODEL, model);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
