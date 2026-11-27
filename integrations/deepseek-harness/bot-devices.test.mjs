import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDeviceInventory } from './bot-devices.mjs';
import { createBotRoutes } from './bot-routes.mjs';

test('invalid remote inventory is reported without disabling local creation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bot-device-inventory-'));
  const origin = 'dsh-app://app';
  const url = 'http://localhost/api/bots';
  try {
    const file = join(home, 'bot-devices.json');
    await writeFile(file, '{invalid');
    const route = createBotRoutes({ home, allowedOrigin: origin, remoteDevices: () => readDeviceInventory(home) });
    const snapshot = await (await route(new Request(url, { headers: { Origin: origin } }))).json();
    assert.ok(snapshot.warning);
    assert.deepEqual(snapshot.devices.map(device => device.id), ['local']);
    const result = await route(new Request(url, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Local QA', purpose: 'Test', device: 'local', engine: 'ds-agent' }),
    }));
    assert.equal(result.status, 201);
    await writeFile(file, JSON.stringify([{ id: 'remote', label: 'Remote QA' }]));
    const repaired = await (await route(new Request(url, { headers: { Origin: origin } }))).json();
    assert.equal(repaired.warning, undefined);
    assert.equal(repaired.devices[1].status, 'offline');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('registered hosts remain offline in inventory and collisions are rejected', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bot-register-host-'));
  const allowedOrigin = 'dsh-app://app';
  const url = 'http://localhost/api/bots';
  const headers = { Origin: allowedOrigin, 'Content-Type': 'application/json' };
  const route = createBotRoutes({ home, allowedOrigin });
  const register = alias => route(new Request(url + '/devices', {
    method: 'POST', headers, body: JSON.stringify({ label: 'grokbot', alias }),
  }));
  try {
    assert.equal((await register('-option')).status, 400);
    const response = await register('grokbot');
    assert.equal(response.status, 201);
    const device = await response.json();
    assert.equal((await register('GROKBOT')).status, 409);
    assert.equal(device.status, 'offline');
    const restarted = createBotRoutes({ home, allowedOrigin });
    const snapshot = await (await restarted(new Request(url, { headers }))).json();
    assert.deepEqual(snapshot.devices[1], device);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('SSH probe resolves only allowed desktop origins for registered devices', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bot-probe-host-'));
  const origin = 'dsh-app://app';
  const url = 'http://localhost/api/bots/devices';
  const aliases = [];
  const route = createBotRoutes({
    home, allowedOrigin: origin,
    probeHost: async alias => { aliases.push(alias); return true; },
  });
  const post = (path, data, source = origin) => route(new Request(url + path, {
    method: 'POST',
    headers: { Origin: source, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }));
  try {
    const saved = await (await post('', { label: 'QA host', alias: 'qa-host' })).json();
    const path = '/' + saved.id + '/probe';
    assert.equal((await post(path, {}, 'https://untrusted.example')).status, 403);
    assert.equal((await post('/device-00000000-0000-0000-0000-000000000000/probe', {})).status, 404);
    assert.deepEqual(aliases, []);
    assert.deepEqual(await (await post(path, { alias: 'ignored' })).json(), { reachable: true });
    assert.deepEqual(aliases, ['qa-host']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
