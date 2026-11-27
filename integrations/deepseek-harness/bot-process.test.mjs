import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBotProcess } from './bot-process.mjs';

test('Bot CLI timeout kills a TERM-resistant process group holding output open', {
  skip: process.platform === 'win32', timeout: 5000,
}, async () => {
  const code = `
    const {spawn} = require('node:child_process');
    process.on('SIGTERM', () => {});
    spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      {stdio: ['ignore', 'inherit', 'inherit']});
    setInterval(() => {}, 1000);
  `;
  await assert.rejects(runBotProcess(process.execPath, ['-e', code], {
    cwd: process.cwd(), env: process.env, timeout: 750, killDelay: 100,
  }), /Bot CLI timed out/);
});

test('Bot CLI captures stdout and respects cancellation before spawn', async () => {
  const opts = { cwd: process.cwd(), env: process.env, timeout: 5000 };
  await assert.deepEqual(await runBotProcess(process.execPath, ['-e', 'console.log("ok")'], opts),
    { code: 0, stdout: 'ok\n' });
  await assert.rejects(runBotProcess(process.execPath, [], {
    ...opts, signal: AbortSignal.abort(new Error('Cancelled test')),
  }), /Cancelled test/);
});
