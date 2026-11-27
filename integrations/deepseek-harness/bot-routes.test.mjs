import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBotRoutes } from './bot-routes.mjs';

test('bot endpoint restricts origins and persists an accepted profile across host restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bot-routes-'));
  const allowedOrigin = 'http://127.0.0.1:8100';
  const url = 'http://127.0.0.1:4328/api/bots';
  const input = { name: '花生', purpose: '整理任务', device: 'local', engine: 'ds-agent' };
  const create = origin => new Request(url, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  try {
    const route = createBotRoutes({ home, allowedOrigin });
    assert.equal((await route(create('https://untrusted.example'))).status, 403);
    const result = await route(create(allowedOrigin));
    assert.equal(result.status, 201);
    const bot = await result.json();
    assert.equal((await route(create(allowedOrigin))).status, 409);
    const restarted = createBotRoutes({ home, allowedOrigin });
    const list = await restarted(new Request(url, { headers: { Origin: allowedOrigin } }));
    const snapshot = await list.json();
    assert.deepEqual(snapshot.bots, [bot]);
    assert.deepEqual(snapshot.devices.map(device => [device.id, device.status, device.engines]), [
      ['local', 'ready', ['ds-agent']],
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('conversation invokes its adapter once and persists the reply', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bot-turn-api-'));
  const origin = 'dsh-app://app';
  const url = 'http://127.0.0.1:4328/api/bots';
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  let calls = 0;
  let prior;
  const route = createBotRoutes({
    home, allowedOrigin: origin,
    runTurn: async (bot, prompt, history) => {
      prior = history;
      calls++;
      return bot.name + ': ' + prompt;
    },
  });
  const post = (endpoint, data) => route(new Request(endpoint, {
    headers, method: 'POST', body: JSON.stringify(data),
  }));
  try {
    const bot = await (await post(url, { name: 'Peanut', purpose: 'Summarize', device: 'local', engine: 'ds-agent' })).json();
    const avatar = await post(url + '/' + bot.id + '/avatar', { avatar: 'moon' });
    assert.equal(avatar.status, 200);
    assert.equal((await avatar.json()).avatar, 'moon');
    const turns = url + '/' + bot.id + '/turns';
    const input = { id: 'request-1', prompt: 'Hello' };
    assert.equal((await post(turns, input)).status, 201);
    assert.equal((await post(turns, input)).status, 200);
    assert.equal(calls, 1);
    const profile = url + '/' + bot.id + '/profile';
    assert.equal((await post(profile, { name: ' ', purpose: 'Review' })).status, 400);
    assert.equal((await post(profile, { name: 'Peanut Review', purpose: 'Review' })).status, 200);
    const reopened = createBotRoutes({ home, allowedOrigin: origin });
    const inventory = await (await reopened(new Request(url, { headers }))).json();
    assert.equal(inventory.bots[0].id, bot.id);
    assert.equal(inventory.bots[0].name, 'Peanut Review');
    assert.equal(inventory.bots[0].purpose, 'Review');
    const data = await (await reopened(new Request(turns, { headers }))).json();
    assert.equal(data.turns[0].reply, 'Peanut: Hello');
    assert.equal(data.turns[0].status, 'completed');
    assert.equal((await post(turns, { id: 'request-2', prompt: 'Continue' })).status, 201);
    assert.deepEqual(prior.map(turn => turn.prompt), ['Hello']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('host advertises configured adapters and dispatches to the selected Agent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bot-adapters-'));
  const origin = 'dsh-app://app';
  const url = 'http://127.0.0.1:4328/api/bots';
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const route = createBotRoutes({
    home, allowedOrigin: origin,
    runTurn: async () => 'wrong adapter',
    adapters: { codex: async () => 'Codex result' },
  });
  const post = (path, data) => route(new Request(url + path, { method: 'POST', headers, body: JSON.stringify(data) }));
  const input = { name: 'QA agent', purpose: 'Summarize', device: 'local' };
  try {
    const index = await (await route(new Request(url, { headers }))).json();
    assert.deepEqual(index.devices[0].engines, ['ds-agent', 'codex']);
    assert.equal((await post('', { ...input, engine: 'claude' })).status, 400);
    const bot = await (await post('', { ...input, engine: 'codex' })).json();
    const turn = await (await post('/' + bot.id + '/turns', { id: 'request-1', prompt: 'Hello' })).json();
    assert.equal(turn.reply, 'Codex result');
    const profile = '/' + bot.id + '/profile';
    assert.equal((await post(profile, { ...input, engine: 'claude' })).status, 400);
    assert.equal((await post(profile, { ...input, engine: 'ds-agent' })).status, 200);
    const next = await (await post('/' + bot.id + '/turns', { id: 'request-2', prompt: 'Continue' })).json();
    assert.equal(next.reply, 'wrong adapter');
    const history = await (await route(new Request(url + '/' + bot.id + '/turns', { headers }))).json();
    assert.deepEqual(history.turns.map(item => item.reply), ['Codex result', 'wrong adapter']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('device routing uses the registered host and retains history when that host goes offline', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bot-device-'));
  const origin = 'dsh-app://app';
  const url = 'http://127.0.0.1:4328/api/bots';
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const device = { id: 'remote-qa', label: 'QA host', connected: true, adapters: { codex: async () => 'remote reply' } };
  const post = (route, path, data) => route(new Request(url + path, { headers, method: 'POST', body: JSON.stringify(data) }));
  try {
    let inventoryUnavailable = false;
    const route = createBotRoutes({ home, allowedOrigin: origin, remoteDevices: async () => {
      assert.equal(inventoryUnavailable, false, 'history must not need inventory');
      return [device];
    } });
    const bot = await (await post(route, '', { name: 'Remote QA', purpose: 'Review', device: device.id, engine: 'codex' })).json();
    const path = '/' + bot.id + '/turns';
    const turn = await (await post(route, path, { id: 'turn-1', prompt: 'Hello' })).json();
    assert.equal(turn.reply, 'remote reply');
    device.connected = false;
    const replay = await post(route, path, { id: 'turn-1', prompt: 'Hello' });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), turn);
    assert.equal((await post(route, path, { id: 'turn-1', prompt: 'Changed' })).status, 400);
    const offline = route;
    assert.equal((await (await route(new Request(url, { headers }))).json()).devices[1].status, 'offline');
    assert.equal((await post(offline, path, { id: 'turn-2', prompt: 'Continue' })).status, 503);
    inventoryUnavailable = true;
    const result = await offline(new Request(url + path, { headers }));
    assert.deepEqual((await result.json()).turns.map(item => item.id), ['turn-1']);
    inventoryUnavailable = false;
    device.connected = true;
    const resumed = await post(route, path, { id: 'turn-2', prompt: 'Continue' });
    assert.equal(resumed.status, 201);
    assert.equal((await resumed.json()).reply, 'remote reply');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('team endpoints preserve selected members and reject duplicate names', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-team-api-'));
  const allowedOrigin = 'dsh-app://app';
  const url = 'http://localhost/api/bots';
  const headers = { Origin: allowedOrigin, 'Content-Type': 'application/json' };
  const route = createBotRoutes({ home, allowedOrigin });
  const post = (path, body) => route(new Request(url + path, {
    method: 'POST', headers, body: JSON.stringify(body),
  }));
  try {
    const profile = { purpose: 'Summarize', device: 'local', engine: 'ds-agent' };
    const first = await (await post('', { ...profile, name: 'Scout' })).json();
    const second = await (await post('', { ...profile, name: 'Writer' })).json();
    const input = { name: 'Editorial team', botIds: [first.id, second.id] };
    const created = await post('/teams', input);
    assert.equal(created.status, 201);
    assert.equal((await post('/teams', input)).status, 409);
    const result = await route(new Request(url + '/teams', { headers }));
    assert.deepEqual((await result.json()).teams, [await created.json()]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('team dispatch persists both replies and deduplicates by request and member', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-team-dispatch-'));
  const origin = 'dsh-app://app';
  const url = 'http://localhost/api/bots';
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const calls = [];
  const adapter = async bot => { calls.push(bot.id); return 'Reply from ' + bot.name; };
  const route = createBotRoutes({ home, allowedOrigin: origin, runTurn: adapter, adapters: { codex: adapter } });
  const post = (path, body) => route(new Request(url + path, {
    method: 'POST', headers, body: JSON.stringify(body),
  }));
  try {
    const profile = { purpose: 'Summarize', device: 'local' };
    const first = await (await post('', { ...profile, name: 'Scout', engine: 'ds-agent' })).json();
    const second = await (await post('', { ...profile, name: 'Writer', engine: 'codex' })).json();
    const team = await (await post('/teams', { name: 'Review', botIds: [second.id, first.id] })).json();
    const endpoint = '/teams/' + team.id + '/dispatch';
    const task = { id: 'once', prompt: 'Summarize' };
    const initial = await (await post(endpoint, task)).json();
    assert.deepEqual(initial.results.map(result => result.body.reply), ['Reply from Writer', 'Reply from Scout']);
    const repeated = await (await post(endpoint, task)).json();
    assert.deepEqual(repeated.results.map(result => result.status), [200, 200]);
    assert.deepEqual(calls, [second.id, first.id]);
    assert.equal((await post(endpoint, { ...task, prompt: 'Different task' })).status, 400);
    const restarted = createBotRoutes({ home, allowedOrigin: origin });
    const history = await (await restarted(new Request(url + endpoint, { headers }))).json();
    assert.deepEqual(history.dispatches.map(entry => [
      entry.id, entry.prompt, entry.results.map(result => result.body.reply),
    ]), [['once', 'Summarize', ['Reply from Writer', 'Reply from Scout']]]);
    for (const bot of [first, second]) {
      const response = await route(new Request(url + '/' + bot.id + '/turns', { headers }));
      assert.deepEqual((await response.json()).turns.map(turn => turn.reply), ['Reply from ' + bot.name]);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('desktop offer endpoint creates one Bot only after an accepted decision', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-offer-api-'));
  const origin = 'dsh-app://app';
  const url = 'http://localhost/api/bots';
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const route = createBotRoutes({ home, allowedOrigin: origin });
  const get = async path => (await route(new Request(url + path, { headers }))).json();
  const post = (path, data, source = origin) => route(new Request(url + path, {
    method: 'POST', headers: { ...headers, Origin: source }, body: JSON.stringify(data),
  }));
  try {
    const offer = await (await post('/offers', { name: 'Proposed', purpose: 'Review', device: 'local', engine: 'ds-agent' })).json();
    assert.equal((await get('/offers')).offers[0].status, 'pending');
    assert.deepEqual((await get('')).bots, []);
    const decision = '/offers/' + offer.id + '/decision';
    assert.equal((await post(decision, { decision: 'accepted' }, 'https://untrusted.example')).status, 403);
    const accepted = await (await post(decision, { decision: 'accepted' })).json();
    assert.deepEqual(await (await post(decision, { decision: 'accepted' })).json(), accepted);
    assert.deepEqual((await get('')).bots.map(bot => bot.id), [accepted.botId]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP proposal token cannot read drafts or approve Bot creation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-offer-token-'));
  const route = createBotRoutes({ home, allowedOrigin: 'dsh-app://app', proposalToken: 'test-token'.repeat(4) });
  const url = 'http://localhost/api/bots/offers';
  const headers = { Authorization: 'Bearer ' + 'test-token'.repeat(4), 'Content-Type': 'application/json' };
  try {
    const result = await route(new Request(url, {
      method: 'POST', headers, body: JSON.stringify({ name: 'Test', purpose: 'Review', device: 'local', engine: 'ds-agent' }),
    }));
    assert.equal(result.status, 201);
    assert.equal((await route(new Request(url, { headers }))).status, 403);
    const offer = await result.json();
    assert.equal((await route(new Request(url + '/' + offer.id + '/decision', {
      method: 'POST', headers, body: '{"decision":"accepted"}',
    }))).status, 403);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('team dispatch retries an unavailable member without rerunning a completed member', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-team-retry-'));
  const origin = 'dsh-app://app';
  const url = 'http://localhost/api/bots';
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  let localCalls = 0;
  let remoteCalls = 0;
  const device = {
    id: 'remote-qa', label: 'QA host', connected: true,
    adapters: { codex: async () => { remoteCalls++; return 'remote reply'; } },
  };
  const route = createBotRoutes({
    home, allowedOrigin: origin, remoteDevices: () => [device],
    runTurn: async () => { localCalls++; return 'local reply'; },
  });
  const post = async (path, body, status) => {
    const response = await route(new Request(url + path, {
      method: 'POST', headers, body: JSON.stringify(body),
    }));
    assert.equal(response.status, status);
    return response.json();
  };
  try {
    const local = await post('', { name: 'Local QA', purpose: 'Summarize', device: 'local', engine: 'ds-agent' }, 201);
    const remote = await post('', { name: 'Remote QA', purpose: 'Summarize', device: device.id, engine: 'codex' }, 201);
    const team = await post('/teams', { name: 'Retry QA', botIds: [local.id, remote.id] }, 201);
    const path = '/teams/' + team.id + '/dispatch';
    const task = { id: 'retry', prompt: 'Summarize' };

    device.connected = false;
    const partial = await post(path, task, 200);
    assert.deepEqual(partial.results.map(member => member.status), [201, 503]);
    const history = await route(new Request(url + path, { headers }));
    assert.deepEqual((await history.json()).dispatches[0].results.map(member => member.body.status),
      ['completed', 'not-started']);

    device.connected = true;
    const resumed = await post(path, task, 200);
    assert.deepEqual(resumed.results.map(member => member.status), [200, 201]);
    assert.deepEqual(resumed.results.map(member => member.body.reply), ['local reply', 'remote reply']);
    assert.deepEqual([localCalls, remoteCalls], [1, 1]);
    device.connected = false;
    const cancelledTask = { ...task, id: 'cancel' };
    await post(path, cancelledTask, 200);
    await post(path + '/cancel/cancel', {}, 200);
    device.connected = true;
    const afterCancel = await post(path, cancelledTask, 200);
    assert.deepEqual(afterCancel.results.map(member => member.body.status), ['completed', 'cancelled']);
    const reopened = createBotRoutes({ home, allowedOrigin: origin });
    const historyAfterRestart = await reopened(new Request(url + path, { headers }));
    assert.deepEqual((await historyAfterRestart.json()).dispatches[0].results.map(member => member.body.status),
      ['completed', 'cancelled']);
    assert.deepEqual([localCalls, remoteCalls], [2, 1]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cancelling a running team dispatch interrupts its members and preserves their terminal status on replay', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-team-interrupt-'));
  const origin = 'dsh-app://app';
  const url = 'http://localhost/api/bots';
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const armed = Promise.withResolvers();
  let calls = 0;
  const route = createBotRoutes({
    home, allowedOrigin: origin,
    runTurn: async (_bot, _prompt, _history, signal) => {
      if (++calls === 2) armed.resolve();
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const post = (path, body) => route(new Request(url + path, {
    method: 'POST', headers, body: JSON.stringify(body),
  }));
  try {
    const profile = { purpose: 'Review', device: 'local', engine: 'ds-agent' };
    const first = await (await post('', { ...profile, name: 'First' })).json();
    const second = await (await post('', { ...profile, name: 'Second' })).json();
    const team = await (await post('/teams', { name: 'Cancel QA', botIds: [first.id, second.id] })).json();
    const endpoint = '/teams/' + team.id + '/dispatch';
    const task = { id: 'interrupt', prompt: 'Review' };
    const dispatch = post(endpoint, task);
    await armed.promise;
    const cancelled = await post(endpoint + '/interrupt/cancel', {});
    assert.equal((await cancelled.json()).interruptRequested, true);
    for (const response of [await dispatch, await post(endpoint, task)]) {
      assert.deepEqual((await response.json()).results.map(row => row.body.status), ['interrupted', 'interrupted']);
    }
    assert.equal(calls, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
