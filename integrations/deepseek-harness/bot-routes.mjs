import { createHash, timingSafeEqual } from 'node:crypto';
import { openBotRegistry } from './bot-registry.mjs';

function memberTurnId(teamId, dispatchId, botId) {
  return createHash('sha256').update(JSON.stringify([teamId, dispatchId, botId])).digest('hex');
}

/** Mount behind host authentication. Reject cross-origin requests before reading state. */
export function createBotRoutes({ home, allowedOrigin, runTurn, adapters = {}, remoteDevices = [], probeHost, proposalToken, supportsConversationScope }) {
  const activeDispatches = new Map();
  const runtimes = new Map(Object.entries(adapters));
  if (runTurn) runtimes.set('ds-agent', runTurn);
  const engines = [...new Set(['ds-agent', ...runtimes.keys()])];
  async function readDevices() {
    const devices = [{ id: 'local', label: '本机 Mac', status: 'ready', engines }];
    if (await supportsConversationScope?.()) devices[0].toolScopes = ['conversation'];
    const deviceRuntimes = new Map([['local', runtimes]]);
    const inventory = typeof remoteDevices === 'function' ? await remoteDevices() : remoteDevices;
    const registry = openBotRegistry(home);
    let saved;
    try {
      saved = registry.listDevices();
    } finally {
      registry.close();
    }
    const entries = Array.isArray(inventory) ? inventory : inventory.devices;
    for (const { id, label, adapters: remoteAdapters = {}, connected } of [...entries, ...saved.filter(device => !entries.some(entry => entry.id === device.id))]) {
      if (!/^[a-z0-9-]{1,80}$/.test(id) || deviceRuntimes.has(id)) {
        throw new Error('Invalid or duplicate device ID.');
      }
      const registered = new Map(Object.entries(remoteAdapters));
      deviceRuntimes.set(id, registered);
      devices.push({
        id, label, status: connected && registered.size ? 'ready' : 'offline',
        engines: [...registered.keys()],
      });
    }
    return { devices, deviceRuntimes, warning: inventory.warning };
  }
  const origin = allowedOrigin;
  if (origin !== 'dsh-app://app' && (new URL(origin).origin !== origin || !/^https?:/.test(origin))) {
    throw new Error('Bot routes require an explicit Harness origin.');
  }

  return async function botRoutes(request) {
    const pathname = new URL(request.url).pathname;
    const conversation = /^\/api\/bots\/([a-f0-9-]{36})\/turns$/.exec(pathname);
    const trigger = /^\/api\/bots\/([a-f0-9-]{36})\/trigger$/.exec(pathname);
    const profile = /^\/api\/bots\/([a-f0-9-]{36})\/profile$/.exec(pathname);
    const avatar = /^\/api\/bots\/([a-f0-9-]{36})\/avatar$/.exec(pathname);
    const probe = /^\/api\/bots\/devices\/(device-[a-f0-9-]{36})\/probe$/.exec(pathname);
    const cancel = /^\/api\/bots\/teams\/([a-f0-9-]{36})\/dispatch\/([a-z0-9-]{1,80})\/cancel$/i.exec(pathname);
    const dispatch = /^\/api\/bots\/teams\/([a-f0-9-]{36})\/dispatch$/.exec(pathname);
    const offers = pathname === '/api/bots/offers';
    const decision = /^\/api\/bots\/offers\/([a-f0-9-]{36})\/decision$/.exec(pathname);
    const teams = pathname === '/api/bots/teams';
    const addDevice = pathname === '/api/bots/devices';
    if (!cancel && !offers && !decision && !dispatch && !teams && !probe && !addDevice && pathname !== '/api/bots' && !conversation && !avatar && !profile && !trigger) return undefined;
    const headers = { 'Cache-Control': 'no-store', Vary: 'Origin' };
    const json = (data, status) => Response.json(data, { status, headers });
    const desktop = request.headers.get('Origin') === origin;
    const authorization = Buffer.from(request.headers.get('Authorization') ?? '');
    const expected = Buffer.from('Bearer ' + (proposalToken ?? ''));
    const proposal = offers && request.method === 'POST' && !request.headers.has('Origin') &&
      proposalToken?.length >= 32 && authorization.length === expected.length &&
      timingSafeEqual(authorization, expected);
    const externalTrigger = trigger && request.method === 'POST' && !request.headers.has('Origin');
    if (!desktop && !proposal && !externalTrigger) return json({ error: 'Forbidden' }, 403);
    if (desktop) headers['Access-Control-Allow-Origin'] = origin;
    if (request.method === 'OPTIONS') {
      headers['Access-Control-Allow-Methods'] = 'GET, POST';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Ds-Desktop';
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }
    let input;
    if (request.method === 'POST') {
      if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
        return json({ error: 'Expected JSON' }, 415);
      }
      const reader = request.body?.getReader();
      if (!reader) return json({ error: 'Expected JSON' }, 400);
      try {
        let total = 0;
        const chunks = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > 8192) {
            await reader.cancel();
            return json({ error: 'Request too large' }, 413);
          }
          chunks.push(Buffer.from(value));
        }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
    }
    if (externalTrigger) {
      const triggerRegistry = openBotRegistry(home);
      try {
        if (!triggerRegistry.authenticateTrigger(trigger[1], request.headers.get('Authorization') ?? '')) {
          return json({ error: 'Forbidden' }, 403);
        }
      } finally {
        triggerRegistry.close();
      }
    }
    const needsDevices = pathname === '/api/bots' || ((conversation || dispatch || offers || decision || profile || externalTrigger) && request.method === 'POST');
    const { devices, deviceRuntimes, warning } = needsDevices ? await readDevices() : {};
    const registry = openBotRegistry(home, devices);
    async function executeTurn(bot, id, prompt, signal) {
      if (typeof id === 'string') {
        const existing = registry.findTurn(bot.id, id);
        if (existing) {
          if (typeof prompt !== 'string' || existing.prompt !== prompt.trim()) throw new RangeError('Turn ID is already in use.');
          return { body: existing, status: 200 };
        }
      }
      const available = devices.find(device => device.id === bot.device)?.status === 'ready';
      const execute = available && deviceRuntimes.get(bot.device)?.get(bot.engine);
      if (bot.toolScope === 'conversation' &&
          (bot.device !== 'local' || bot.engine !== 'ds-agent' || !devices[0].toolScopes?.includes('conversation'))) {
        return { body: { error: 'Required Bot tool scope unavailable' }, status: 503 };
      }
      if (!execute) return { body: { error: 'Bot execution unavailable' }, status: 503 };
      const { started, turn } = registry.beginTurn(bot.id, id, prompt);
      if (!started) return { body: turn, status: 200 };
      try {
        const reply = await execute(bot, turn.prompt, registry.recentCompletedTurns(bot.id), signal);
        if (typeof reply !== 'string' || !reply.trim()) throw new Error('No reply');
        registry.finishTurn(bot.id, turn.id, { status: 'completed', reply });
      } catch {
        registry.finishTurn(bot.id, turn.id, { status: signal?.aborted ? 'interrupted' : 'failed' });
      }
      return { body: registry.findTurn(bot.id, turn.id), status: 201 };
    }
    try {
      if (cancel) {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        const [, teamId, id] = cancel;
        if (!registry.cancelDispatch(teamId, id)) return json({ error: 'Dispatch not found' }, 404);
        const active = activeDispatches.get(teamId + '/' + id);
        active?.controller.abort();
        return json({ cancelledPending: true, interruptRequested: Boolean(active) }, 200);
      }
      if (offers) {
        return request.method === 'GET'
          ? json({ offers: registry.listOffers() }, 200)
          : json(registry.propose(input), 201);
      }
      if (decision) {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        return json(registry.decideOffer(decision[1], input?.decision), 200);
      }
      if (dispatch) {
        const team = registry.listTeams().find(entry => entry.id === dispatch[1]);
        if (!team) return json({ error: 'Team not found' }, 404);
        if (request.method === 'GET') {
          const dispatches = registry.listDispatches(team.id).map(entry => ({
            ...entry,
            results: team.botIds.map(botId => ({
              botId,
              body: registry.findTurn(botId, memberTurnId(team.id, entry.id, botId)) ?? { status: registry.isDispatchCancelled(team.id, entry.id) ? 'cancelled' : 'not-started' },
            })),
          }));
          return json({ dispatches }, 200);
        }
        if (typeof input?.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(input.id) ||
            typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 6000) {
          return json({ error: 'Invalid dispatch ID or message' }, 400);
        }
        registry.recordDispatch(team.id, input.id, input.prompt.trim());
        const bots = new Map(registry.list().map(bot => [bot.id, bot]));
        const key = team.id + '/' + input.id;
        const active = activeDispatches.get(key) ?? { controller: new AbortController(), users: 0 };
        activeDispatches.set(key, active);
        active.users++;
        try {
          const results = await Promise.all(team.botIds.map(async botId => {
            const id = memberTurnId(team.id, input.id, botId);
            if (registry.isDispatchCancelled(team.id, input.id)) {
              return { botId, body: registry.findTurn(botId, id) ?? { status: 'cancelled' }, status: 200 };
            }
            try {
              const result = await executeTurn(bots.get(botId), id, input.prompt, active.controller.signal);
              return { botId, ...result };
            } catch (error) {
              const status = error instanceof RangeError ? 400 : error.errcode === 2067 ? 409 : 500;
              return { botId, body: { error: 'Unable to dispatch to this Bot' }, status };
            }
          }));
          return json({ results }, 200);
        } finally {
          if (--active.users === 0) activeDispatches.delete(key);
        }
      }
      if (teams) {
        return request.method === 'GET'
          ? json({ teams: registry.listTeams() }, 200)
          : json(registry.createTeam(input), 201);
      }
      if (probe) {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        const device = registry.listDevices().find(entry => entry.id === probe[1]);
        if (!device) return json({ error: 'Host not found' }, 404);
        if (!probeHost) return json({ error: 'SSH check unavailable' }, 503);
        return json({ reachable: await probeHost(device.alias) }, 200);
      }
      if (addDevice) {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        const { id, label } = registry.addDevice(input);
        return json({ id, label, status: 'offline', engines: [] }, 201);
      }
      if (trigger) {
        const botId = trigger[1];
        if (externalTrigger) {
          const prompt = registry.authenticateTrigger(botId, request.headers.get('Authorization') ?? '');
          if (!prompt) return json({ error: 'Forbidden' }, 403);
          const bot = registry.list().find(entry => entry.id === botId);
          if (bot?.toolScope !== 'conversation') return json({ error: 'Required Bot tool scope unavailable' }, 503);
          const eventId = input?.id;
          if (typeof eventId !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(eventId)) {
            return json({ error: 'Invalid trigger event ID' }, 400);
          }
          const id = createHash('sha256').update(JSON.stringify(['trigger', botId, eventId])).digest('hex');
          const existing = registry.findTurn(botId, id);
          if (existing) return json({ id, status: existing.status }, 200);
          const { body, status } = await executeTurn(bot, id, prompt);
          return json(body.error ? body : { id, status: body.status }, status);
        }
        if (!registry.list().some(entry => entry.id === botId)) return json({ error: 'Bot not found' }, 404);
        if (request.method === 'GET') {
          const triggerConfig = registry.readTrigger(botId);
          return json({ enabled: Boolean(triggerConfig), ...triggerConfig }, 200);
        }
        return json(registry.configureTrigger(botId, input), 200);
      }
      if (profile) {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        const bot = registry.updateProfile(profile[1], input);
        if (bot === null) return json({ error: 'Wait for the running turn before changing runtime or permissions' }, 409);
        return bot ? json(bot, 200) : json({ error: 'Bot not found' }, 404);
      }
      if (avatar) {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        const bot = registry.setAvatar(avatar[1], input?.avatar);
        return bot ? json(bot, 200) : json({ error: 'Bot not found' }, 404);
      }
      if (conversation) {
        const bot = registry.list().find(profile => profile.id === conversation[1]);
        if (!bot) return json({ error: 'Bot not found' }, 404);
        if (request.method === 'GET') return json({ turns: registry.history(bot.id) }, 200);
        const { body, status } = await executeTurn(bot, input?.id, input?.prompt);
        return json(body, status);
      }
      return request.method === 'GET' ? json({ bots: registry.list(), devices, warning }, 200) : json(registry.create(input), 201);
    } catch (error) {
      if (error instanceof RangeError) return json({ error: error.message }, 400);
      if (error.errcode === 2067) return json({ error: teams ? 'Team name already exists' : addDevice ? 'Host alias already exists' : (conversation || trigger) ? 'Bot already has a running turn' : 'Bot name already exists' }, 409);
      throw error;
    } finally {
      registry.close();
    }
  };
}
