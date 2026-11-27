import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { buildBotPrompt } from './bot-context.mjs';

const execute = promisify(execFile);

export function createClaudeAdapter({ executable, workspaceRoot }) {
  if (!isAbsolute(executable) || !isAbsolute(workspaceRoot)) {
    throw new TypeError('Claude executable and workspace root must be absolute paths.');
  }
  return async (bot, prompt, history, signal) => {
    if (!/^[a-f0-9-]{36}$/.test(bot.id)) throw new Error('Invalid Bot ID.');
    const cwd = join(workspaceRoot, bot.id);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const child = execute(executable, [
      '--print', '--no-session-persistence', '--tools', '',
      '--strict-mcp-config', '--setting-sources', '',
      '--output-format', 'json', '--', buildBotPrompt(bot, prompt, history),
    ], { cwd, signal, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    const closed = new Promise(resolve => child.child.once('close', resolve));
    child.child.stdin.end();
    const { stdout } = await child.finally(() => closed);
    const response = JSON.parse(stdout);
    if (response.is_error || typeof response.result !== 'string' || !response.result.trim()) {
      throw new Error('Claude did not return a successful final reply.');
    }
    return response.result.trim();
  };
}
