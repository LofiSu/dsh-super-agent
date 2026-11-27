import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { botEnvironment } from './bot-env.mjs';
import { buildBotPrompt } from './bot-context.mjs';

const execute = promisify(execFile);

export function createCodexAdapter({ executable, workspaceRoot }) {
  if (!isAbsolute(executable) || !isAbsolute(workspaceRoot)) {
    throw new TypeError('Codex executable and workspace root must be absolute paths.');
  }
  return async (bot, prompt, history, signal) => {
    if (!/^[a-f0-9-]{36}$/.test(bot.id)) throw new Error('Invalid Bot ID.');
    const cwd = join(workspaceRoot, bot.id);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const scratch = await mkdtemp(join(cwd, 'codex-turn-'));
    try {
      const output = join(scratch, 'reply.txt');
      const child = execute(executable, [
        '-a', 'never', 'exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'read-only',
        '--skip-git-repo-check', '--output-last-message', output, '--',
        buildBotPrompt(bot, prompt, history),
      ], { cwd, env: botEnvironment(), signal, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
      const closed = new Promise(resolve => child.child.once('close', resolve));
      child.child.stdin.end();
      await child.finally(() => closed);
      return (await readFile(output, 'utf8')).trim();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}
