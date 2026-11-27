import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openBotRegistry(home, devices = [{ id: 'local', status: 'ready', engines: ['ds-agent'] }]) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, 'bots.db');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS bot_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      purpose TEXT NOT NULL,
      device TEXT NOT NULL,
      engine TEXT NOT NULL,
      createdAt TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bot_offers (
      id TEXT PRIMARY KEY,
      draft TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
      botId TEXT REFERENCES bot_profiles(id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bot_devices (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      alias TEXT NOT NULL COLLATE NOCASE UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bot_teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bot_team_members (
      teamId TEXT NOT NULL REFERENCES bot_teams(id),
      botId TEXT NOT NULL REFERENCES bot_profiles(id),
      position INTEGER NOT NULL,
      PRIMARY KEY (teamId, botId)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bot_team_dispatches (
      teamId TEXT NOT NULL REFERENCES bot_teams(id),
      id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      PRIMARY KEY (teamId, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bot_dispatch_cancellations (
      teamId TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (teamId, id),
      FOREIGN KEY (teamId, id) REFERENCES bot_team_dispatches(teamId, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bot_turns (
      id TEXT PRIMARY KEY,
      botId TEXT NOT NULL REFERENCES bot_profiles(id),
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
      reply TEXT
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_running_turn_per_bot ON bot_turns(botId) WHERE status = 'running';
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('PRAGMA table_info(bot_profiles)').all().some(column => column.name === 'avatar')) {
      db.exec("ALTER TABLE bot_profiles ADD COLUMN avatar TEXT NOT NULL DEFAULT 'initial'");
    }
    if (!db.prepare('PRAGMA table_info(bot_profiles)').all().some(column => column.name === 'toolScope')) {
      db.exec("ALTER TABLE bot_profiles ADD COLUMN toolScope TEXT NOT NULL DEFAULT 'default' CHECK (toolScope IN ('default', 'conversation'))");
    }
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    throw error;
  }
  const insert = db.prepare('INSERT INTO bot_profiles (id, name, purpose, device, engine, createdAt, avatar) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const list = db.prepare('SELECT * FROM bot_profiles ORDER BY createdAt, id');
  function normalizeIdentity(input) {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    const purpose = typeof input?.purpose === 'string' ? input.purpose.trim() : '';
    if (!name || name.length > 80 || !purpose || purpose.length > 1000) {
      throw new RangeError('Bot name and purpose are required and must fit the field limits.');
    }
    return { name, purpose };
  }

  function validateRuntime(deviceId, engine) {
    if (!devices.some(device => device.id === deviceId && device.status === 'ready' && device.engines.includes(engine))) {
      throw new RangeError('The selected Agent is unavailable on this device.');
    }
  }

  function normalizeProfile(input) {
    const identity = normalizeIdentity(input);
    validateRuntime(input.device, input.engine);
    const avatar = input.avatar ?? 'initial';
    if (!['initial', 'leaf', 'spark', 'moon'].includes(avatar)) throw new RangeError('Unknown avatar.');
    return { ...identity, device: input.device, engine: input.engine, avatar };
  }

  function create(input) {
    const profile = { ...normalizeProfile(input), toolScope: 'default', id: randomUUID(), createdAt: new Date().toISOString() };
    insert.run(profile.id, profile.name, profile.purpose, profile.device, profile.engine, profile.createdAt, profile.avatar);
    return profile;
  }
  function validateToolScope(device, engine, scope) {
    if (scope === 'default') return;
    if (scope !== 'conversation' || device !== 'local' || engine !== 'ds-agent' ||
        !devices.find(entry => entry.id === device)?.toolScopes?.includes(scope)) {
      throw new RangeError('The selected Agent does not support this tool scope.');
    }
  }

  return {
    close: () => db.close(),
    list: () => list.all(),
    updateProfile(id, input) {
      const current = db.prepare('SELECT * FROM bot_profiles WHERE id = ?').get(id);
      if (!current) return undefined;
      const { name, purpose } = normalizeIdentity(input);
      const device = input.device ?? current.device;
      const engine = input.engine ?? current.engine;
      const targetChanged = device !== current.device || engine !== current.engine;
      const toolScope = input.toolScope ?? current.toolScope;
      if (targetChanged || toolScope !== current.toolScope) {
        validateRuntime(device, engine);
        validateToolScope(device, engine, toolScope);
        if (db.prepare("SELECT 1 FROM bot_turns WHERE botId = ? AND status = 'running'").get(id)) {
          return null;
        }
      }
      return db.prepare('UPDATE bot_profiles SET name = ?, purpose = ?, device = ?, engine = ?, toolScope = ? WHERE id = ? RETURNING *')
        .get(name, purpose, device, engine, toolScope, id);
    },
    setAvatar(id, avatar) {
      if (!['initial', 'leaf', 'spark', 'moon'].includes(avatar)) throw new RangeError('Unknown avatar.');
      return db.prepare('UPDATE bot_profiles SET avatar = ? WHERE id = ? RETURNING *').get(avatar, id);
    },
    listTeams() {
      const members = db.prepare('SELECT botId FROM bot_team_members WHERE teamId = ? ORDER BY position');
      return db.prepare('SELECT id, name FROM bot_teams ORDER BY name, id').all().map(team => ({
        ...team, botIds: members.all(team.id).map(row => row.botId),
      }));
    },
    cancelDispatch(teamId, id) {
      const exists = db.prepare('SELECT 1 FROM bot_team_dispatches WHERE teamId = ? AND id = ?').get(teamId, id);
      if (!exists) return false;
      db.prepare('INSERT OR IGNORE INTO bot_dispatch_cancellations VALUES (?, ?)').run(teamId, id);
      return true;
    },
    isDispatchCancelled(teamId, id) {
      return Boolean(db.prepare('SELECT 1 FROM bot_dispatch_cancellations WHERE teamId = ? AND id = ?').get(teamId, id));
    },
    listDispatches(teamId) {
      return db.prepare('SELECT id, prompt FROM bot_team_dispatches WHERE teamId = ? ORDER BY rowid DESC LIMIT 20').all(teamId);
    },
    recordDispatch(teamId, id, prompt) {
      db.prepare('INSERT INTO bot_team_dispatches VALUES (?, ?, ?) ON CONFLICT(teamId, id) DO NOTHING').run(teamId, id, prompt);
      const saved = db.prepare('SELECT prompt FROM bot_team_dispatches WHERE teamId = ? AND id = ?').get(teamId, id);
      if (saved.prompt !== prompt) throw new RangeError('Dispatch ID is already in use.');
    },
    recentCompletedTurns(botId) {
      return db.prepare("SELECT prompt, reply, status FROM bot_turns WHERE botId = ? AND status = 'completed' ORDER BY rowid DESC LIMIT 10")
        .all(botId).reverse();
    },
    findTurn(botId, id) {
      return db.prepare('SELECT * FROM bot_turns WHERE botId = ? AND id = ?').get(botId, id);
    },
    createTeam(input) {
      const name = typeof input?.name === 'string' ? input.name.trim() : '';
      const botIds = input?.botIds;
      if (!name || name.length > 80 || !Array.isArray(botIds) || botIds.length < 2 || botIds.length > 8 ||
          botIds.some(id => typeof id !== 'string') || new Set(botIds).size !== botIds.length) {
        throw new RangeError('Choose a team name and two to eight distinct Bots.');
      }
      const id = randomUUID();
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare('SELECT 1 FROM bot_profiles WHERE id = ?');
        if (botIds.some(botId => !existing.get(botId))) throw new RangeError('Team member not found.');
        db.prepare('INSERT INTO bot_teams VALUES (?, ?)').run(id, name);
        const insertMember = db.prepare('INSERT INTO bot_team_members VALUES (?, ?, ?)');
        botIds.forEach((botId, position) => insertMember.run(id, botId, position));
        db.exec('COMMIT');
        return { id, name, botIds };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    listDevices() {
      return db.prepare('SELECT id, label, alias FROM bot_devices ORDER BY label, id').all();
    },
    addDevice(input) {
      const label = typeof input?.label === 'string' ? input.label.trim() : '';
      const alias = typeof input?.alias === 'string' ? input.alias.trim() : '';
      if (!label || label.length > 80 || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(alias)) {
        throw new RangeError('Enter a display name and a valid SSH host alias.');
      }
      const device = { id: 'device-' + randomUUID(), label, alias };
      db.prepare('INSERT INTO bot_devices VALUES (?, ?, ?)').run(device.id, label, alias);
      return device;
    },
    history(botId) {
      return db.prepare('SELECT * FROM bot_turns WHERE botId = ? ORDER BY rowid').all(botId);
    },
    beginTurn(botId, id, input) {
      const prompt = typeof input === 'string' ? input.trim() : '';
      if (!prompt || prompt.length > 6000 || typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(id)) {
        throw new RangeError('Invalid turn ID or message.');
      }
      const result = db.prepare("INSERT INTO bot_turns VALUES (?, ?, ?, 'running', NULL) ON CONFLICT(id) DO NOTHING")
        .run(id, botId, prompt);
      const turn = db.prepare('SELECT * FROM bot_turns WHERE id = ?').get(id);
      if (turn.botId !== botId || turn.prompt !== prompt) throw new RangeError('Turn ID is already in use.');
      return { started: result.changes === 1, turn };
    },
    finishTurn(botId, id, { status, reply }) {
      if (!['completed', 'failed', 'interrupted'].includes(status)) throw new RangeError('Invalid terminal status.');
      return db.prepare("UPDATE bot_turns SET status = ?, reply = ? WHERE id = ? AND botId = ? AND status = 'running'")
        .run(status, reply ?? null, id, botId).changes === 1;
    },
    interruptRunningTurns() {
      return db.prepare("UPDATE bot_turns SET status = 'interrupted' WHERE status = 'running'").run().changes;
    },
    create,
    propose(input) {
      const draft = normalizeProfile(input);
      const id = randomUUID();
      db.prepare('INSERT INTO bot_offers (id, draft) VALUES (?, ?)').run(id, JSON.stringify(draft));
      return { id, draft, status: 'pending', botId: null };
    },
    listOffers() {
      return db.prepare('SELECT * FROM bot_offers ORDER BY rowid DESC LIMIT 100').all().map(offer => ({
        ...offer, draft: JSON.parse(offer.draft),
      }));
    },
    decideOffer(id, decision) {
      if (!['accepted', 'declined'].includes(decision)) throw new RangeError('Unknown offer decision.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const offer = db.prepare('SELECT * FROM bot_offers WHERE id = ?').get(id);
        if (!offer) throw new RangeError('Offer not found.');
        if (offer.status !== 'pending' && offer.status !== decision) {
          throw new RangeError('The offer already has a different decision.');
        }
        let botId = offer.botId;
        if (offer.status === 'pending') {
          if (decision === 'accepted') botId = create(JSON.parse(offer.draft)).id;
          db.prepare('UPDATE bot_offers SET status = ?, botId = ? WHERE id = ?').run(decision, botId, id);
        }
        db.exec('COMMIT');
        return { id, status: decision, botId };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export function recoverBotTurns(home) {
  const registry = openBotRegistry(home);
  try {
    return registry.interruptRunningTurns();
  } finally {
    registry.close();
  }
}
