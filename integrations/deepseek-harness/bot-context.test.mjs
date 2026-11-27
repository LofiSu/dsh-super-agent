import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readBotRouterReply } from './bot-context.mjs';

test('plain Router fallback uses only the latest unanswered delivery context', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-router-reply-'));
  try {
    const sessions = join(home, 'sessions');
    mkdirSync(sessions);
    const journal = join(sessions, 'router.jsonl');
    const messages = [
      { kind: 'message', role: 'user', content: 'First' },
      { kind: 'message', role: 'assistant', content: 'Old answer' },
      { kind: 'message', role: 'user', content: 'Second' },
    ];
    const writeJournal = () => writeFileSync(journal, messages.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    writeJournal();
    assert.equal(readBotRouterReply(home), '');
    messages.push({ kind: 'message', role: 'assistant', content: 'Planning', toolCalls: [{ name: 'read_object' }] });
    writeJournal();
    assert.equal(readBotRouterReply(home), '');
    messages.push({ kind: 'message', role: 'assistant', content: '  New answer  ', toolCalls: [] });
    writeJournal();
    assert.equal(readBotRouterReply(home), 'New answer');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
