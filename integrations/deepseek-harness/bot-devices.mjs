import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sshHostArguments } from './bot-ssh.mjs';

/** Read owner-managed device names. Connectivity is supplied by a transport. */
export async function readConfiguredDevices(home) {
  let source;
  try {
    source = await readFile(join(home, 'bot-devices.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const devices = JSON.parse(source);
  if (!Array.isArray(devices) || devices.length > 32) throw new RangeError('Invalid device list.');
  const ids = new Set(['local']);
  return devices.map(device => {
    if (typeof device?.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(device.id) ||
        ids.has(device.id) || typeof device.label !== 'string' ||
        !device.label.trim() || device.label.length > 80) {
      throw new RangeError('Invalid or duplicate device.');
    }
    ids.add(device.id);
    return { id: device.id, label: device.label.trim(), connected: false };
  });
}

export async function readDeviceInventory(home) {
  try {
    return { devices: await readConfiguredDevices(home) };
  } catch {
    return { devices: [], warning: '无法读取远程设备清单，请检查宿主配置。' };
  }
}

export async function probeSshHost(alias) {
  const args = sshHostArguments(alias);
  const { execFile } = await import('node:child_process');
  return new Promise(resolve => {
    execFile('/usr/bin/ssh', [...args, 'true'],
      { timeout: 8000, maxBuffer: 65536 }, error => resolve(!error)).stdin.end();
  });
}
