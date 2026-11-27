import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildBotPrompt } from './bot-context.mjs';

const execute = promisify(execFile);
const protocol = 'dsh-bot-runtime-v1';

export function sshHostArguments(alias) {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(alias)) throw new RangeError('Invalid SSH alias.');
  return [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardAgent=no', '-o', 'PermitLocalCommand=no', '--', alias,
  ];
}

export function createSshBotTransport({ executable = '/usr/bin/ssh' } = {}) {
  async function request(alias, operation, input, signal) {
    const child = execute(executable, [...sshHostArguments(alias), protocol, operation], {
      signal, timeout: operation === 'capabilities' ? 7000 : 120_000, maxBuffer: 1024 * 1024,
    });
    const closed = new Promise(resolve => child.child.once('close', resolve));
    child.child.stdin.on('error', () => {});
    child.child.stdin.end(input === undefined ? '' : JSON.stringify(input));
    const { stdout } = await child.finally(() => closed);
    return JSON.parse(stdout);
  }

  const probes = new Map();
  return async function resolveSshDevice(device) {
    if (!device.alias) return device;
    let probe = probes.get(device.alias);
    if (!probe || probe.expires <= Date.now()) {
      const ready = request(device.alias, 'capabilities').then(
        result => result?.protocol === protocol && result.engine === 'ds-agent', () => false,
      );
      probe = { ready, expires: Date.now() + 30_000 };
      probes.set(device.alias, probe);
    }
    if (!await probe.ready) return device;
    return {
      ...device,
      connected: true,
      adapters: {
        'ds-agent': async (bot, prompt, history, signal) => {
          const response = await request(device.alias, 'turn', {
            prompt: buildBotPrompt(bot, prompt, history),
          }, signal);
          if (typeof response?.reply !== 'string' || !response.reply.trim()) {
            throw new Error('Remote ds-agent did not return a reply.');
          }
          return response.reply.trim();
        },
      },
    };
  };
}
