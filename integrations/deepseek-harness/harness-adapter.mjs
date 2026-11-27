import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { botEnvironment } from './bot-env.mjs';
import { buildBotPrompt } from './bot-context.mjs';

const execute = promisify(execFile);

export function createHarnessAdapter({ executable, workspaceRoot, useLocalMagpie = false }) {
  if (!isAbsolute(executable) || !isAbsolute(workspaceRoot)) {
    throw new TypeError('Harness executable and workspace root must be absolute paths.');
  }
  return async (bot, prompt, history, signal) => {
    if (!/^[a-f0-9-]{36}$/.test(bot.id)) throw new Error('Invalid Bot ID.');
    const cwd = join(workspaceRoot, bot.id);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const env = { ...botEnvironment(), DSH_HOME: join(cwd, 'harness-home') };
    if (useLocalMagpie && !env.DSH_BOT_MAGPIE_KEY) env.DSH_BOT_MAGPIE_KEY = 'magpie';
    const modelFlags = env.DSH_BOT_MAGPIE_KEY
      ? ['--patch', fileURLToPath(new URL('./harness-magpie.yml', import.meta.url))]
      : [];
    const child = execute(executable, [
      'headless', ...modelFlags, '--permission-mode', 'read-only', '--approval-policy', 'never', '--',
      buildBotPrompt(bot, prompt, history),
    ], { cwd, env, signal, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    const closed = new Promise(resolve => child.child.once('close', resolve));
    child.child.stdin.end();
    const { stdout } = await child.finally(() => closed);
    return stdout.trim();
  };
}
