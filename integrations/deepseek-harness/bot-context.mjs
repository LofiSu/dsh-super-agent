import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Bound historical context while preserving the current prompt in full. */
export function buildBotPrompt(bot, prompt, history) {
  const recent = [];
  let remaining = 8000;
  for (const turn of history.slice(-10).reverse()) {
    if (turn.status !== 'completed') continue;
    const entry = { user: turn.prompt, assistant: turn.reply };
    remaining -= JSON.stringify(entry).length;
    if (remaining < 0) break;
    recent.unshift(entry);
  }
  return [
    'Current message:',
    prompt,
    'Use this Bot profile and prior messages as context:',
    JSON.stringify({ bot: bot.name, purpose: bot.purpose, history: recent }),
  ].join('\n');
}

/** Recover a plain answer from this turn's isolated Router journal. */
export function readBotRouterReply(stateHome) {
  const journal = join(stateHome, 'sessions', 'router.jsonl');
  const entries = readFileSync(journal, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  const latestUser = entries.findLastIndex(entry => entry.kind === 'message' && entry.role === 'user');
  if (latestUser < 0) return '';
  const following = entries.slice(latestUser + 1).findLast(entry => entry.kind === 'message' && entry.role === 'assistant');
  return typeof following?.content === 'string' && !following.toolCalls?.length ? following.content.trim() : '';
}
