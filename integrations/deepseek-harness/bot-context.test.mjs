import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildBotPrompt, readBotRouterReply } from './bot-context.mjs';

test('puts the current question in the trigger preview before long history', () => {
  const question = 'What is 19 plus 24?';
  const prompt = buildBotPrompt({ name: 'QA', purpose: 'Answer briefly' }, question, [
    { status: 'completed', prompt: 'Earlier question', reply: '背景'.repeat(3600) },
  ]);
  assert.match(prompt.slice(0, 80), /^Current message:\nWhat is 19 plus 24\?/);
  assert.match(prompt, /Earlier question/);
});

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
