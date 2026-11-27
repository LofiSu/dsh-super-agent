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
    'Respond to the current message. Use prior messages as conversation context.',
    JSON.stringify({ bot: bot.name, purpose: bot.purpose, history: recent, currentMessage: prompt }),
  ].join('\n');
}
