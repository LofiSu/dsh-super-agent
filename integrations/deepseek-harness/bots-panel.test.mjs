import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

test('sidebar panel creates a profile and restores it on remount', async () => {
  const profiles = [];
  const effects = [];
  const requests = [];
  const slots = new Map();
  let hooks = [];
  let cursor = 0;
  const React = {
    useEffect: effect => effects.push(effect),
    useRef(initial) { return this.useState(() => ({ current: initial }))[0]; },
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
  };
  const mount = runInNewContext(readFileSync(new URL('./bots-panel.js', import.meta.url), 'utf8') + '\nmountBotsPanel', {
    crypto: { randomUUID: () => 'bot-1' },
    FormData: class { constructor(fields) { this.fields = fields; } get(key) { return this.fields[key]; } },
  });
  const navigation = [];
  const openBots = mount({ layout: { selectPanel: id => navigation.push(id) }, slots: { inject: (_, register) => register(), register: (entry, component) => slots.set(entry.name, { entry, component }) } }, React, async (path, options) => {
    if (path.endsWith('/turns')) {
      if (!options) return Response.json({ turns: [] });
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) throw new Error('Lost response');
      if (requests.length === 2) return Response.json({ id: 'bot-1', status: 'running' });
      return Response.json({ id: 'bot-1', status: 'completed', prompt: requests.at(-1).prompt, reply: '恢复成功' });
    }
    if (options) {
      const bot = { ...JSON.parse(options.body), id: 'bot-1' };
      profiles.push(bot);
      return Response.json(bot, { status: 201 });
    }
    return Response.json({ bots: [...profiles], devices: [{ id: 'local', label: '本机 Mac', status: 'ready', engines: ['ds-agent'] }] });
  });
  assert.equal(slots.get('sidebar.panellist').entry.label(), 'Bots');
  openBots();
  assert.deepEqual(navigation, ['dsh-super-bot']);
  const render = () => { cursor = 0; return slots.get('main').component(); };
  render();
  effects.shift()();
  await new Promise(setImmediate);
  assert.match(JSON.stringify(render()), /创建你的第一个 Bot/);
  const actions = render().children[1].children[1].children;
  actions[0].props.onClick();
  assert.deepEqual(navigation, ['dsh-super-bot', 'ds-super-agent']);
  actions[1].props.onClick();
  const findForm = () => render().children.find(child => child?.tag === 'dialog').children[0];
  findForm().children.find(child => child?.tag === 'footer').children[0].children[1].props.onChange({ target: { value: '项目跟进' } });
  const form = findForm();
  assert.equal(form.children.find(child => child?.props?.className === 'bots-identity').children[1].props.value, '项目跟进');
  assert.match(form.children.find(child => child?.tag === 'textarea').props.value, /阻塞/);
  let submitted = false;
  form.props.onKeyDown({ metaKey: true, key: 'Enter', preventDefault() {}, currentTarget: {
    requestSubmit: () => { submitted = true; },
  } });
  assert.equal(submitted, true);
  await form.props.onSubmit({ preventDefault() {}, currentTarget: { name: '花生', purpose: '整理任务进度', device: 'local', engine: 'ds-agent' } });
  hooks = [];
  effects.length = 0;
  render();
  effects.shift()();
  await new Promise(setImmediate);
  const dashboard = render();
  assert.match(JSON.stringify(dashboard), /花生.*ds-agent.*整理任务进度/);
  const cards = dashboard.children.find(child => Array.isArray(child) && child[0]?.tag === 'article');
  cards[0].children[0].children[2].props.onClick();
  const selectedCards = render().children.find(child => Array.isArray(child) && child[0]?.tag === 'article');
  const conversation = selectedCards[0].children.at(-1);
  hooks = [];
  effects.length = 0;
  const renderConversation = () => { cursor = 0; return conversation.tag(conversation.props); };
  renderConversation();
  effects.shift()();
  await new Promise(setImmediate);
  const formFor = () => renderConversation().children.find(child => child?.tag === 'form');
  formFor().children[0].children[1].props.onChange({ target: { value: '我的消息' } });
  for (let attempt = 0; attempt < 3; attempt++) await formFor().props.onSubmit({ preventDefault() {} });
  assert.deepEqual(requests.map(turn => turn.id), ['bot-1', 'bot-1', 'bot-1']);
  assert.match(JSON.stringify(renderConversation()), /恢复成功/);
});
