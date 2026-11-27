import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { prepareBotInstall } from './install-integrity.mjs';
import { join } from 'node:path';

const path = process.argv[2] ?? join(homedir(), 'Documents/deepseek-harness/ds-super-agent-tab/client.js');
const installed = readFileSync(path, 'utf8');
const previous = installed.includes('function mountBotsPanel(');
const source = previous ? readFileSync(path + '.before-bots', 'utf8') : installed;
{
  const factory = '    const React = require(\'react\');';
  const apply = '      apply(ctx) {';
  const props = 'function Desktop({ t }) {';
  const header = "          h('button', { type: 'button', className: 'dsd-share', onClick: share,";
  const render = 'return h(Desktop, { t });';
  for (const anchor of [factory, apply, props, header, render]) {
    if (source.split(anchor).length !== 2) throw new Error('Unsupported ds-super-agent-tab client layout');
  }
  const panel = readFileSync(new URL('./bots-panel.js', import.meta.url), 'utf8').trimEnd()
    .split('\n').map(line => '    ' + line).join('\n');
  const generated = source.replace(factory, () => factory + '\n' + panel)
    .replace(apply, () => apply + '\n        const openBots = mountBotsPanel(ctx, React, request);')
    .replace(props, 'function Desktop({ t, openBots }) {')
    .replace(header, () => "          h('button', { type: 'button', className: 'dsd-share', onClick: openBots }, 'Bots'),\n" + header)
    .replace(render, 'return h(Desktop, { t, openBots });');
  const updated = prepareBotInstall(installed, generated, previous);
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
