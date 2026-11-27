/** Mount via the existing ds-super-agent-tab client factory. */
function mountBotsPanel(ctx, React, request) {
  const h = React.createElement;
  const panel = 'dsh-super-bot';
  const avatars = { initial: '首字', leaf: '🌿', spark: '✨', moon: '🌙' };
  const runtimePermissions = {
    'ds-agent': '使用本机 ds-agent 的工具与审批配置。',
    codex: '使用 Codex 的只读沙箱，禁止提权审批。',
    claude: '工具调用已禁用。',
    harness: '使用 Harness 的只读权限预设，禁止提权审批。',
  };
  const templates = {
    '项目跟进': '汇总项目进度、待办事项和阻塞，并注明信息来源。',
    '代码审查': '检查用户提供的代码变更，报告回归风险并建议验证步骤。',
    '支持分诊': '整理用户提供的反馈，归纳问题并草拟回复。',
  };


  function Conversation({ bot }) {
    const [turns, setTurns] = React.useState([]);
    const [ready, setReady] = React.useState(false);
    const [draft, setDraft] = React.useState('');
    const [sending, setSending] = React.useState(false);
    const [notice, setNotice] = React.useState('');
    const endpoint = '/api/bots/' + bot.id + '/turns';

    React.useEffect(() => {
      let active = true;
      async function load() {
        try {
          const response = await request(endpoint);
          if (!response.ok) throw new Error();
          const data = await response.json();
          if (active) {
            setTurns(data.turns);
            setReady(true);
          }
        } catch {
          if (active) setNotice('无法读取会话。');
        }
      }
      void load();
      return () => { active = false; };
    }, [endpoint]);

    async function send(event) {
      event.preventDefault();
      const prompt = draft.trim();
      if (!ready || sending || !prompt) return;
      setSending(true);
      setNotice('');
      try {
        const response = await request(endpoint, {
          method: 'POST',
          body: JSON.stringify({ id: crypto.randomUUID(), prompt }),
        });
        if (!response.ok) throw new Error();
        const turn = await response.json();
        setTurns(current => [...current, turn]);
        setDraft('');
      } catch {
        setNotice('未能确认发送结果。重新打开会话可查看已保存的记录。');
      } finally {
        setSending(false);
      }
    }

    const labels = { running: '执行中', failed: '执行失败', interrupted: '已中断' };
    return h('section', { 'aria-label': bot.name + ' 会话' },
      ...turns.map(turn => h('article', { key: turn.id },
        h('p', { style: { whiteSpace: 'pre-wrap' } }, turn.prompt),
        h('p', { style: { whiteSpace: 'pre-wrap' } }, turn.reply || labels[turn.status]))),
      notice && h('p', { role: 'alert' }, notice),
      h('form', { onSubmit: send },
        h('label', null, '消息', h('textarea', {
          required: true, maxLength: 2400, value: draft, disabled: sending,
          onChange: event => setDraft(event.target.value),
        })),
        h('button', { type: 'submit', disabled: !ready || sending || !draft.trim() }, sending ? '执行中…' : '发送')));
  }

  function TeamDispatch({ team, members }) {
    const [running, setRunning] = React.useState(false);
    const [activeId, setActiveId] = React.useState(null);
    const [cancelling, setCancelling] = React.useState(false);
    const [history, setHistory] = React.useState([]);
    const [notice, setNotice] = React.useState('');
    const pending = React.useRef(null);
    const endpoint = '/api/bots/teams/' + team.id + '/dispatch';

    React.useEffect(() => {
      const controller = new AbortController();
      void (async () => {
        try {
          const response = await request(endpoint, { signal: controller.signal });
          if (!response.ok) throw new Error();
          const { dispatches } = await response.json();
          if (!controller.signal.aborted) {
            setHistory(current => [...current, ...dispatches.filter(entry => !current.some(item => item.id === entry.id))].slice(0, 20));
          }
        } catch {
          if (!controller.signal.aborted) setNotice('无法读取派工历史。');
        }
      })();
      return () => controller.abort();
    }, [endpoint]);

    async function submit(event) {
      event.preventDefault();
      if (running) return;
      const form = event.currentTarget;
      const prompt = String(new FormData(form).get('task') ?? '').trim();
      if (!prompt) return;
      if (pending.current?.prompt !== prompt) {
        pending.current = { prompt, id: crypto.randomUUID() };
      }
      await dispatch(pending.current, form);
    }

    async function dispatch(task, form) {
      if (running) return;
      setActiveId(task.id);
      setRunning(true);
      setNotice('');
      try {
        const response = await request(endpoint, {
          method: 'POST', body: JSON.stringify(task),
        });
        if (!response.ok) throw new Error();
        const data = await response.json();
        const entry = { ...task, results: data.results };
        setHistory(current => [entry, ...current.filter(item => item.id !== entry.id)].slice(0, 20));
        if (data.results.every(item => item.body.status === 'completed')) {
          if (pending.current?.id === task.id) pending.current = null;
          form?.reset();
        }
      } catch {
        setNotice('无法确认派工结果。保留原任务文字重试可沿用本次请求。');
      } finally {
        setActiveId(null);
        setRunning(false);
      }
    }

    async function cancelDispatch(id) {
      if (cancelling) return;
      setCancelling(true);
      setNotice('');
      try {
        const response = await request(endpoint + '/' + id + '/cancel', { method: 'POST', body: '{}' });
        if (!response.ok) throw new Error();
        if (running) {
          setNotice('已请求中止，等待执行端确认。');
          return;
        }
        const historyResponse = await request(endpoint);
        if (!historyResponse.ok) throw new Error();
        setHistory((await historyResponse.json()).dispatches);
      } catch {
        setNotice('无法确认取消结果，请重新打开团队查看。');
      } finally {
        setCancelling(false);
      }
    }

    return h('div', null,
      h('form', { onSubmit: submit },
        h('label', null, '团队任务', h('textarea', { name: 'task', required: true, maxLength: 2400, disabled: running })),
        h('button', { type: 'submit', disabled: running || cancelling }, running ? '正在派工…' : '发给团队')),
      activeId && h('button', { type: 'button', disabled: cancelling, onClick: () => void cancelDispatch(activeId) }, '请求中止派工'),
      notice && h('p', { role: 'alert' }, notice),
      ...history.map(entry => h('details', { key: entry.id },
        h('summary', null, entry.prompt),
        entry.results.some(item => item.body.status === 'not-started' || item.status === 503 || item.status === 409) &&
          h('button', { type: 'button', disabled: running || cancelling, onClick: () => void dispatch({ id: entry.id, prompt: entry.prompt }) },
            '重试未启动成员'),
        entry.results.some(item => item.body.status === 'not-started' || item.status === 503 || item.status === 409) &&
          h('button', { type: 'button', disabled: running || cancelling, onClick: () => void cancelDispatch(entry.id) },
            '取消待执行成员'),
        ...entry.results.map(item => h('article', { key: item.botId },
          h('strong', null, members.find(bot => bot.id === item.botId)?.name ?? item.botId),
          h('p', { style: { whiteSpace: 'pre-wrap' } }, item.body.reply || item.body.error ||
            ({ failed: '执行失败', interrupted: '已中断', running: '执行中', 'not-started': '尚未执行', cancelled: '已取消' })[item.body.status]))))));
  }

  function Teams({ profiles }) {
    const [teams, setTeams] = React.useState([]);
    const [editing, setEditing] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [ready, setReady] = React.useState(false);
    const [error, setError] = React.useState('');
    const endpoint = '/api/bots/teams';

    React.useEffect(() => {
      let active = true;
      void (async () => {
        try {
          const response = await request(endpoint);
          if (!response.ok) throw new Error();
          const result = await response.json();
          if (active) {
            setTeams(result.teams);
            setReady(true);
          }
        } catch {
          if (active) setError('无法读取团队。');
        }
      })();
      return () => { active = false; };
    }, []);

    async function create(event) {
      event.preventDefault();
      if (saving) return;
      const fields = new FormData(event.currentTarget);
      const botIds = fields.getAll('member');
      if (botIds.length < 2 || botIds.length > 8) {
        setError('请选择 2 到 8 位团队成员。');
        return;
      }
      setSaving(true);
      setError('');
      try {
        const response = await request(endpoint, {
          method: 'POST', body: JSON.stringify({ name: fields.get('teamName'), botIds }),
        });
        if (response.status === 409) {
          setError('团队名称已存在。');
          return;
        }
        if (!response.ok) throw new Error();
        const team = await response.json();
        setTeams(current => [...current, team]);
        setEditing(false);
      } catch {
        setError('无法保存团队。');
      } finally {
        setSaving(false);
      }
    }

    return h('section', { 'aria-label': 'Bot 团队' },
      h('h2', null, '团队'),
      h('button', { type: 'button', disabled: !ready || profiles.length < 2, onClick: () => { setError(''); setEditing(true); } }, '新建团队'),
      error && h('p', { role: 'alert' }, error),
      editing && h('form', { onSubmit: create, 'aria-label': '新建团队' },
        h('label', null, '团队名称', h('input', { name: 'teamName', required: true, maxLength: 80 })),
        h('fieldset', null, h('legend', null, '成员'),
          ...profiles.map(bot => h('label', { key: bot.id },
            h('input', { type: 'checkbox', name: 'member', value: bot.id }), bot.name))),
        h('button', { type: 'submit', disabled: saving }, '保存团队'),
        h('button', { type: 'button', disabled: saving, onClick: () => setEditing(false) }, '取消')),
      ...teams.map(team => h('article', { key: team.id },
        h('strong', null, team.name),
        h('ul', null, ...team.botIds.map(id => h('li', { key: id }, profiles.find(bot => bot.id === id)?.name ?? id))),
        h(TeamDispatch, { team, members: profiles }))));
  }

  function Offers({ onAccepted }) {
    const [offers, setOffers] = React.useState([]);
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState('');
    async function refresh() {
      try {
        const response = await request('/api/bots/offers');
        if (!response.ok) throw new Error();
        setOffers((await response.json()).offers);
        setNotice('');
      } catch {
        setNotice('无法读取 Bot 提议。');
      }
    }
    React.useEffect(() => { void refresh(); }, []);

    async function decide(id, decision) {
      setBusy(true);
      try {
        const response = await request('/api/bots/offers/' + id + '/decision', {
          method: 'POST', body: JSON.stringify({ decision }),
        });
        if (!response.ok) throw new Error();
        await refresh();
        if (decision === 'accepted') await onAccepted();
      } catch {
        setNotice('无法确认审批结果，请刷新后查看。');
      } finally {
        setBusy(false);
      }
    }

    return h('section', { 'aria-label': 'Bot 提议' },
      h('h2', null, 'Bot 提议'),
      h('button', { type: 'button', disabled: busy, onClick: () => void refresh() }, '刷新提议'),
      notice && h('p', { role: 'alert' }, notice),
      ...offers.filter(offer => offer.status === 'pending').map(({ id, draft }) =>
        h('article', { key: id },
          h('strong', null, draft.name),
          h('p', null, draft.purpose),
          h('p', null, draft.device + ' · ' + draft.engine),
          h('button', { type: 'button', disabled: busy, onClick: () => void decide(id, 'accepted') }, '批准创建'),
          h('button', { type: 'button', disabled: busy, onClick: () => void decide(id, 'declined') }, '拒绝'))));
  }

  function Bots() {
    const [template, setTemplate] = React.useState('');
    const [name, setName] = React.useState('');
    const [purpose, setPurpose] = React.useState('');
    const [selected, setSelected] = React.useState(null);
    const [probing, setProbing] = React.useState(null);
    const [probeNotice, setProbeNotice] = React.useState('');
    const [addingHost, setAddingHost] = React.useState(false);
    const [deviceWarning, setDeviceWarning] = React.useState('');
    const [devices, setDevices] = React.useState([]);
    const [deviceId, setDeviceId] = React.useState('local');
    const engines = devices.find(device => device.id === deviceId)?.engines ?? [];
    const [profiles, setProfiles] = React.useState([]);
    const [loading, setLoading] = React.useState(true);
    const [editing, setEditing] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState('');

    React.useEffect(() => {
      let active = true;
      async function load() {
        try {
          const result = await request('/api/bots');
          if (!result.ok) throw new Error();
          const data = await result.json();
          if (active) {
            setProfiles(data.bots);
            setDevices(data.devices ?? []);
            setDeviceWarning(data.warning ?? '');
          }
        } catch {
          if (active) setError('无法连接 Bot 服务。');
        } finally {
          if (active) setLoading(false);
        }
      }
      void load();
      return () => { active = false; };
    }, []);

    async function create(event) {
      event.preventDefault();
      if (saving) return;
      const fields = new FormData(event.currentTarget);
      setSaving(true);
      setError('');
      try {
        const result = await request('/api/bots', {
          method: 'POST',
          body: JSON.stringify({
            name: fields.get('name'), purpose: fields.get('purpose'),
            engine: fields.get('engine'), avatar: fields.get('avatar') ?? 'initial', device: fields.get('device'),
          }),
        });
        if (result.status === 409) {
          setError('这个名称已经在使用。');
          return;
        }
        if (!result.ok) throw new Error();
        const bot = await result.json();
        setProfiles(current => [...current, bot]);
        setEditing(false);
      } catch {
        setError('保存失败，请检查 Bot 服务或重试。');
      } finally {
        setSaving(false);
      }
    }

    async function addHost(event) {
      event.preventDefault();
      if (saving) return;
      const fields = new FormData(event.currentTarget);
      setSaving(true);
      setError('');
      try {
        const response = await request('/api/bots/devices', {
          method: 'POST',
          body: JSON.stringify({ label: fields.get('label'), alias: fields.get('alias') }),
        });
        if (!response.ok) throw new Error(response.status === 409 ? '该 SSH 别名已登记。' : '无法添加主机。');
        const device = await response.json();
        setDevices(current => [...current, device]);
        setAddingHost(false);
      } catch (error) {
        setError(error.message);
      } finally {
        setSaving(false);
      }
    }

    async function checkHost(device) {
      if (probing) return;
      setProbing(device.id);
      setProbeNotice('');
      try {
        const response = await request('/api/bots/devices/' + device.id + '/probe', { method: 'POST', body: '{}' });
        if (!response.ok) throw new Error();
        const { reachable } = await response.json();
        setProbeNotice(device.label + (reachable ? ' · SSH 可达，Agent 尚未连接' : ' · SSH 连接失败'));
      } catch {
        setProbeNotice('无法检查 SSH 连接。');
      } finally {
        setProbing(null);
      }
    }

    async function updateIdentity(event, id) {
      event.preventDefault();
      setError('');
      const fields = new FormData(event.currentTarget);
      try {
        const response = await request('/api/bots/' + id + '/profile', {
          method: 'POST', body: JSON.stringify({ name: fields.get('name'), purpose: fields.get('purpose') }),
        });
        if (!response.ok) throw new Error();
        const saved = await response.json();
        setProfiles(current => current.map(bot => bot.id === id ? saved : bot));
      } catch {
        setError('无法保存 Bot 名称或职责。请检查名称是否已被使用。');
      }
    }

    async function updateAvatar(id, avatar) {
      setError('');
      try {
        const response = await request('/api/bots/' + id + '/avatar', {
          method: 'POST', body: JSON.stringify({ avatar }),
        });
        if (!response.ok) throw new Error();
        const saved = await response.json();
        setProfiles(current => current.map(bot => bot.id === id ? saved : bot));
      } catch {
        setError('无法保存头像。');
      }
    }

    return h('main', { className: 'dsh-bots' },
      h('style', null, `
        .dsh-bots{padding:clamp(20px,5vw,52px);max-width:960px;margin:auto}
        .dsh-bots header{display:flex;align-items:center;justify-content:space-between;gap:16px}
        .dsh-bots h1{font-size:2rem;margin:0}.dsh-bots form,.dsh-bots article{border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:12px;padding:18px;margin:16px 0;overflow-wrap:anywhere}
        .dsh-bots label{display:grid;gap:5px;margin:12px 0}.dsh-bots input,.dsh-bots select,.dsh-bots textarea,.dsh-bots button{font:inherit;padding:8px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 30%,transparent);color:inherit;background:transparent}
        .dsh-bots option{color:CanvasText;background:Canvas}.dsh-bots button{cursor:pointer}.dsh-bots button:disabled{cursor:default;opacity:.5}.dsh-bots button+button{margin-left:10px}
      `),
      h('header', null, h('h1', null, 'Bots'), h('button', {
        type: 'button', disabled: loading || saving || !devices.length, onClick: () => { setError(''); setTemplate(''); setName(''); setPurpose(''); setEditing(true); },
      }, '新建 Bot')),
      error && h('p', { role: 'alert' }, error),
      deviceWarning && h('p', { role: 'status' }, deviceWarning),
      editing && h('form', { onSubmit: create, onKeyDown: event => {
        if (event.metaKey && event.key === 'Enter' && !event.nativeEvent?.isComposing) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      } },
        h('label', null, '模板', h('select', {
          value: template, onChange: event => {
            const choice = event.target.value;
            setTemplate(choice);
            if (choice) {
              setName(choice);
              setPurpose(templates[choice]);
            }
          },
        }, h('option', { value: '' }, '自定义'), ...Object.keys(templates).map(label => h('option', { key: label }, label)))),
        h('label', null, '名称', h('input', { name: 'name', value: name, onChange: event => setName(event.target.value), required: true, maxLength: 80, autoFocus: true })),
        h('label', null, '头像', h('select', { name: 'avatar' },
          ...Object.entries(avatars).map(([value, label]) => h('option', { key: value, value }, label)))),
        h('label', null, '职责', h('textarea', { name: 'purpose', value: purpose, onChange: event => setPurpose(event.target.value), required: true, maxLength: 1000 })),
        h('label', null, '运行设备', h('select', {
          name: 'device', value: deviceId, onChange: event => setDeviceId(event.target.value),
        }, ...devices.map(device => h('option', {
          key: device.id, value: device.id, disabled: device.status !== 'ready',
        }, device.label + (device.status === 'ready' ? '' : ' · 未连接'))))),
        h('label', null, 'Agent', h('select', { name: 'engine' }, ...engines.map(engine => h('option', { key: engine }, engine)))),
        h('button', { type: 'submit', disabled: saving || !engines.length }, '保存 Bot'),
        h('button', { type: 'button', onClick: () => setEditing(false) }, '取消')),
      !loading && h('button', { type: 'button', onClick: () => setAddingHost(true) }, '添加主机'),
      probeNotice && h('p', { role: 'status' }, probeNotice),
      ...devices.filter(device => device.id.startsWith('device-')).map(device => h('p', { key: device.id },
        device.label, ' ', h('button', { type: 'button', disabled: !!probing, onClick: () => void checkHost(device) }, '检查 SSH'))),
      addingHost && h('form', { onSubmit: addHost, 'aria-label': '添加主机' },
        h('label', null, '显示名称', h('input', { name: 'label', required: true, maxLength: 80 })),
        h('label', null, 'SSH 别名', h('input', { name: 'alias', required: true, maxLength: 80 })),
        h('button', { type: 'submit', disabled: saving }, '登记主机'),
        h('button', { type: 'button', onClick: () => setAddingHost(false) }, '取消')),
      !loading && !error && !profiles.length && h('p', null, '还没有 Bot。'),
      !loading && h(Offers, { onAccepted: async () => {
        const response = await request('/api/bots');
        if (!response.ok) throw new Error();
        setProfiles((await response.json()).bots);
      } }),
      !loading && h(Teams, { profiles }),
      ...profiles.map(bot => h('article', { key: bot.id },
        h('strong', null, (avatars[bot.avatar] && bot.avatar !== 'initial' ? avatars[bot.avatar] : Array.from(bot.name)[0]) + ' · ' + bot.name), h('p', null, bot.purpose),
        h('small', null, `${devices.find(device => device.id === bot.device)?.label ?? bot.device} · ${bot.engine} · 配置已保存`),
        h('button', { type: 'button', onClick: () => setSelected(bot.id), 'aria-pressed': selected === bot.id }, '打开会话'),
        selected === bot.id && h('details', null,
          h('summary', null, '编辑 Bot'),
          h('form', { onSubmit: event => void updateIdentity(event, bot.id) },
            h('label', null, '名称', h('input', { name: 'name', required: true, maxLength: 80, defaultValue: bot.name })),
            h('label', null, '职责', h('textarea', { name: 'purpose', required: true, maxLength: 1000, defaultValue: bot.purpose })),
            h('button', { type: 'submit' }, '保存配置'))),
        selected === bot.id && h('label', null, '编辑头像', h('select', {
          value: bot.avatar ?? 'initial', onChange: event => void updateAvatar(bot.id, event.target.value),
        }, ...Object.entries(avatars).map(([value, label]) => h('option', { key: value, value }, label)))),
        selected === bot.id && h('p', null, runtimePermissions[bot.engine] ?? '工具权限由目标设备配置。'),
        selected === bot.id && h(Conversation, { bot }))));
  }

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panel, order: 6, label: 'Bots',
  }, () => h('span', { 'aria-hidden': true }, '▦')));
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panel,
  }, Bots));
}
