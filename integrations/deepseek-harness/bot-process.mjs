import { spawn } from 'node:child_process';

/** Run one Bot CLI in its own process group and bound shutdown before returning. */
export function runBotProcess(executable, args, { cwd, env, signal, timeout, killDelay = 400 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const grouped = process.platform !== 'win32';
    const child = spawn(executable, args, { cwd, env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    let failure;
    let escalation;
    const kill = sig => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (error) {
        if (error.code !== 'ESRCH') failure ??= error;
      }
    };
    const stop = reason => {
      if (failure) return;
      failure = reason;
      kill('SIGTERM');
      escalation = setTimeout(() => {
        kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }, killDelay);
    };
    const abort = () => stop(signal.reason ?? new Error('Bot turn aborted'));
    const timer = setTimeout(() => stop(new Error('Bot CLI timed out')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= 1024 * 1024) chunks.push(chunk);
      else stop(new Error('Bot CLI output limit exceeded'));
    });
    child.stderr.resume();
    child.once('error', error => { failure ??= error; });
    child.once('close', code => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}
