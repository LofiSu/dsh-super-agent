import assert from 'node:assert/strict';
import { test } from 'node:test';
import { botEnvironment } from './bot-env.mjs';

test('Bot environment excludes proposal credentials and preserves provider settings', () => {
  const source = {
    DSH_BOT_PROPOSAL_TOKEN: 'fixture',
    DSH_BOT_PROPOSAL_TOKEN_FILE: '/fixture',
    DS_AGENT_API_BASE: 'http://127.0.0.1:3425/v1',
  };
  assert.deepEqual(botEnvironment(source), { DS_AGENT_API_BASE: source.DS_AGENT_API_BASE });
  assert.equal(source.DSH_BOT_PROPOSAL_TOKEN, 'fixture');
});
