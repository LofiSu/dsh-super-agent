#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { readBotRouterReply } from './bot-context.mjs';

const execute = promisify(execFile);
const verb = process.argv[2];
const executable = process.env.DSH_BOT_REMOTE_BIN;

try {
  if (!executable || !isAbsolute(executable)) throw new Error();
  const capabilities = await execute(executable, ['tool-scope-capabilities'], { timeout: 5000, maxBuffer: 65536 });
  if (!capabilities.stdout.split('\n').includes('ds-agent-tool-scope:conversation')) throw new Error();
  if (verb === 'capabilities') {
    console.log(JSON.stringify({ protocol: 'dsh-bot-runtime-v1', engine: 'ds-agent' }));
  } else if (verb === 'turn') {
    let size = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 32 * 1024) throw new Error();
      chunks.push(chunk);
    }
    const { prompt } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.startsWith('--')) throw new Error();
    const home = await mkdtemp(join(tmpdir(), 'dsh-bot-remote-'));
    try {
      const { stdout } = await execute(executable, ['chat', prompt], {
        env: { ...process.env, DS_AGENT_HOME: home, DS_AGENT_TOOL_SCOPE: 'conversation' },
        timeout: 110_000, maxBuffer: 1024 * 1024,
      });
      if (!stdout.includes('model=HttpOpenAI')) throw new Error();
      const delivered = [...stdout.matchAll(/^\[reply\] purpose=result[^\n]*?\btext=([^\n]*(?:\n(?!\[[a-z][\w:-]*\](?:\s|$))[^\n]*)*)/gim)];
      const reply = delivered.at(-1)?.[1].trim() || readBotRouterReply(home);
      if (!reply) throw new Error();
      console.log(JSON.stringify({ reply }));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  } else {
    throw new Error();
  }
} catch {
  console.error('Remote Bot runtime unavailable or turn failed.');
  process.exitCode = 1;
}
