import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const path = process.argv[2] ?? join(homedir(), 'Documents/deepseek-harness/ds-super-agent-tab/client.js');
const installed = readFileSync(path, 'utf8');
const previous = installed.includes('function mountBotsPanel(');
const source = previous ? readFileSync(path + '.before-bots', 'utf8') : installed;
{
  const factory = '    const React = require(\'react\');';
  const apply = '      apply(ctx) {';
  for (const anchor of [factory, apply]) {
    if (source.split(anchor).length !== 2) throw new Error('Unsupported ds-super-agent-tab client layout');
  }
  const panel = readFileSync(new URL('./bots-panel.js', import.meta.url), 'utf8').trimEnd()
    .split('\n').map(line => '    ' + line).join('\n');
  const updated = source.replace(factory, () => factory + '\n' + panel)
    .replace(apply, () => apply + '\n        mountBotsPanel(ctx, React, request);');
  if (updated === installed) {
    console.log('Bots panel already installed:', path);
    process.exit(0);
  }
  const mode = statSync(path).mode & 0o777;
  writeFileSync(path + (previous ? '.before-bots-' + Date.now() : '.before-bots'), installed, { flag: 'wx', mode });
  const staged = path + '.bots-new';
  writeFileSync(staged, updated, { flag: 'wx', mode });
  renameSync(staged, path);
  console.log('Installed Bots panel:', path);
}
