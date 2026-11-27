import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openBotRegistry, recoverBotTurns } from './bot-registry.mjs';

test('host Bot profiles survive process-store reopen and reject unconfigured adapters', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bot-registry-'));
  let registry = openBotRegistry(home);
  try {
    const input = { name: 'Peanut', purpose: 'Summarize project tasks', device: 'local', engine: 'ds-agent' };
    assert.throws(() => registry.create({ ...input, engine: 'unconfigured' }), RangeError);
    const bot = registry.create(input);
    assert.throws(() => registry.create({ ...input, name: 'PEANUT' }));
    registry.close();
    registry = openBotRegistry(home);
    assert.deepEqual(registry.list().map(row => ({ ...row })), [bot]);
  } finally {
    registry.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('turn admission is idempotent and recovery preserves independent Bot histories', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bot-turns-'));
  let registry = openBotRegistry(home);
  try {
    const input = { purpose: 'Summarize tasks', device: 'local', engine: 'ds-agent' };
    const bot = registry.create({ ...input, name: 'One' });
    const other = registry.create({ ...input, name: 'Two' });
    assert.equal(registry.beginTurn(bot.id, 'first', 'Hello').started, true);
    assert.equal(registry.beginTurn(bot.id, 'first', 'Hello').started, false);
    assert.throws(() => registry.beginTurn(bot.id, 'second', 'Parallel'));
    assert.equal(registry.finishTurn(bot.id, 'first', { status: 'completed', reply: 'Hello back' }), true);
    assert.equal(registry.beginTurn(bot.id, 'second', 'Continue').started, true);
    registry.close();
    assert.equal(recoverBotTurns(home), 1);
    registry = openBotRegistry(home);
    assert.deepEqual(registry.history(bot.id).map(turn => [turn.status, turn.reply]), [
      ['completed', 'Hello back'], ['interrupted', null],
    ]);
    assert.equal(registry.history(other.id).length, 0);
    assert.equal(registry.beginTurn(bot.id, "third", "Resume").started, true);
  } finally {
    registry.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('legacy profile gets an initial avatar and new selections persist', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bot-avatar-'));
  try {
    const db = new DatabaseSync(join(home, 'bots.db'));
    db.exec(`
      CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, name TEXT, purpose TEXT, device TEXT, engine TEXT, createdAt TEXT);
      INSERT INTO bot_profiles VALUES ('old', 'Legacy', 'Review', 'local', 'ds-agent', '2026-01-01');
    `);
    db.close();
    const registry = openBotRegistry(home);
    try {
      assert.equal(registry.list()[0].avatar, 'initial');
      const input = { name: 'Peanut', purpose: 'Review', device: 'local', engine: 'ds-agent' };
      assert.throws(() => registry.create({ ...input, avatar: 'unknown' }), RangeError);
      const bot = registry.create({ ...input, avatar: 'leaf' });
      assert.equal(registry.list().find(row => row.id === bot.id).avatar, 'leaf');
    } finally {
      registry.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('team membership is atomic and survives reopening the registry', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bot-teams-'));
  try {
    const registry = openBotRegistry(home);
    let team;
    try {
      const profile = { purpose: 'Summarize status', device: 'local', engine: 'ds-agent' };
      const first = registry.create({ ...profile, name: 'Scout' });
      const second = registry.create({ ...profile, name: 'Writer' });
      assert.throws(() => registry.createTeam({ name: 'Review', botIds: [first.id, 'missing'] }), RangeError);
      assert.deepEqual(registry.listTeams(), []);
      team = registry.createTeam({ name: 'Review', botIds: [second.id, first.id] });
    } finally {
      registry.close();
    }
    const reopened = openBotRegistry(home);
    try {
      assert.deepEqual(reopened.listTeams(), [team]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('offers create a Bot only after approval and replay the same decision', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bot-offers-'));
  const registry = openBotRegistry(home);
  try {
    const input = { name: 'Proposed', purpose: 'Review', device: 'local', engine: 'ds-agent' };
    const offer = registry.propose(input);
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.listOffers()[0].status, 'pending');
    const accepted = registry.decideOffer(offer.id, 'accepted');
    assert.equal(registry.list()[0].id, accepted.botId);
    assert.deepEqual(registry.decideOffer(offer.id, 'accepted'), accepted);
    assert.throws(() => registry.decideOffer(offer.id, 'declined'), RangeError);
    const other = registry.propose({ ...input, name: 'Declined' });
    assert.equal(registry.decideOffer(other.id, 'declined').botId, null);
    assert.equal(registry.list().length, 1);
  } finally {
    registry.close();
    rmSync(home, { recursive: true, force: true });
  }
});
