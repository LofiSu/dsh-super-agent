/** Mount via the existing ds-super-agent-tab client factory. */
function mountBotsPanel(ctx, React, request) {
  const h = React.createElement;
  const panel = 'dsh-super-bot';
  const openBots = () => ctx.layout.selectPanel(panel);
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
    const [section, setSection] = React.useState('bots');
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

    async function updateProfile(event, id) {
      event.preventDefault();
      setError('');
      const fields = new FormData(event.currentTarget);
      try {
        const [device, engine] = JSON.parse(fields.get('runtime'));
        const response = await request('/api/bots/' + id + '/profile', {
          method: 'POST', body: JSON.stringify({ name: fields.get('name'), purpose: fields.get('purpose'), device, engine }),
        });
        if (!response.ok) throw new Error();
        const saved = await response.json();
        setProfiles(current => current.map(bot => bot.id === id ? saved : bot));
      } catch {
        setError('无法保存 Bot 配置。请检查名称、可用运行环境及当前会话状态。');
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

    function openCreate() {
      setError('');
      setTemplate('');
      setName('');
      setPurpose('');
      setEditing(true);
    }

    return h('main', { className: 'dsh-bots' },
      h('style', null, `
        .dsh-bots{--bot-accent:#6755c8;--bot-line:color-mix(in srgb,currentColor 15%,transparent);--bot-tint:color-mix(in srgb,var(--bot-accent) 10%,transparent);box-sizing:border-box;width:100%;max-width:1120px;min-width:0;margin:0 auto;padding:clamp(16px,4vw,44px);font-family:inherit}
        .dsh-bots header{display:flex;align-items:center;justify-content:space-between;gap:16px}
        .dsh-bots .bots-hero{padding:0 0 20px;border-bottom:1px solid var(--bot-line)}
        .dsh-bots .bots-title{display:flex;align-items:center;gap:12px}
        .dsh-bots .bots-title .bots-icon{margin:0}
        .dsh-bots .bots-nav{display:flex;gap:6px;flex-wrap:wrap;margin:20px 0}
        .dsh-bots .bots-nav button{border-color:transparent;margin:0}
        .dsh-bots .bots-nav button[aria-pressed=true]{border-color:var(--bot-line)}
        .dsh-bots .bots-card-header{display:flex;align-items:center;gap:14px}
        .dsh-bots .bots-card-header .bots-icon{flex:none;margin:0}
        .dsh-bots .bots-card-header h2{overflow-wrap:anywhere}
        .dsh-bots .bots-card-header>div{flex:1;min-width:0}
        .dsh-bots .bots-card-header>button{flex:none}
        .dsh-bots .bots-description{margin:12px 0 0;white-space:pre-wrap}
        .dsh-bots .bots-hero-actions{display:flex;flex-wrap:wrap;gap:8px}.dsh-bots .bots-hero-actions button+button{margin-left:0}
        .dsh-bots h1{font-size:clamp(28px,5vw,42px);line-height:1.1;letter-spacing:-.04em;margin:0}
        .dsh-bots h2{font-size:18px;margin:0}.dsh-bots header p,.dsh-bots small{opacity:.74}
        .dsh-bots form,.dsh-bots article,.dsh-bots .bots-empty{border:1px solid var(--bot-line);border-radius:16px;padding:20px;margin:16px 0;overflow-wrap:anywhere}
        .dsh-bots .bots-dialog{box-sizing:border-box;width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 32px);padding:0;color:inherit;background:var(--dsw-alias-bg-primary,Canvas);border:1px solid var(--bot-line);border-radius:18px;box-shadow:0 28px 100px #0007}
        .dsh-bots .bots-dialog::backdrop{background:#0706109c;backdrop-filter:blur(4px)}
        .dsh-bots .bots-create{margin:0;padding:24px;border:0}
        .dsh-bots .bots-create footer{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
        .dsh-bots .bots-create footer button{margin:0}
        .dsh-bots .bots-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
        @media(max-width:580px){.dsh-bots .bots-fields{grid-template-columns:1fr;gap:0}.dsh-bots .bots-hero{align-items:flex-start;flex-direction:column}}
        .dsh-bots .bots-empty{text-align:center;padding:36px 24px;background:var(--bot-tint)}
        .dsh-bots .bots-icon{display:inline-grid;place-items:center;width:42px;height:42px;border-radius:14px;background:var(--bot-tint);color:var(--bot-accent);margin-bottom:14px}
        .dsh-bots label{display:grid;gap:6px;margin:12px 0;font-weight:550}
        .dsh-bots input,.dsh-bots select,.dsh-bots textarea,.dsh-bots button{box-sizing:border-box;font:inherit;padding:9px 12px;border-radius:9px;border:1px solid var(--bot-line);color:inherit;background:transparent}
        .dsh-bots input,.dsh-bots select,.dsh-bots textarea{width:100%;background:color-mix(in srgb,Canvas 72%,transparent)}
        .dsh-bots textarea{min-height:80px;resize:vertical}.dsh-bots option{color:CanvasText;background:Canvas}
        .dsh-bots :focus-visible{outline:2px solid var(--bot-accent);outline-offset:2px}
        .dsh-bots button{cursor:pointer;transition:background-color .16s ease,border-color .16s ease}
        .dsh-bots button:hover:not(:disabled){background:var(--bot-tint);border-color:var(--bot-accent)}
        .dsh-bots .bots-primary,.dsh-bots .bots-primary:hover:not(:disabled){background:var(--bot-accent);color:white;border-color:var(--bot-accent);font-weight:650}
        .dsh-bots button:disabled{cursor:default;opacity:.5}.dsh-bots button+button{margin-left:8px}
        .dsh-bots [aria-pressed=true]{border-color:var(--bot-accent);background:var(--bot-tint)}
        .dsh-bots [role=alert]{padding:12px;border-radius:9px;background:color-mix(in srgb,#e65a4f 15%,transparent)}
        @media(prefers-reduced-motion:reduce){.dsh-bots button{transition:none}}
      `),
      h('header', { className: 'bots-hero' },
        h('div', { className: 'bots-title' }, h('span', { className: 'bots-icon' }, h(BotIcon)), h('h1', null, 'Bots')),
        h('div', { className: 'bots-hero-actions' },
          h('button', { type: 'button', onClick: () => ctx.layout.selectPanel('ds-super-agent') }, '返回聊天'),
          h('button', { className: 'bots-primary',
            type: 'button', disabled: loading || saving || !devices.length, onClick: openCreate,
          }, '＋ 新建 Bot'))),
      h('nav', { className: 'bots-nav', 'aria-label': 'Bots 工作区' },
        ...[['bots', '我的 Bots'], ['teams', '团队'], ['hosts', '运行设备'], ['offers', '待审提议']].map(([id, title]) =>
          h('button', { key: id, type: 'button', 'aria-pressed': section === id, onClick: () => { setError(''); setSection(id); } }, title))),
      !editing && error && h('p', { role: 'alert' }, error),
      section === 'hosts' && deviceWarning && h('p', { role: 'status' }, deviceWarning),
      editing && h('dialog', {
        className: 'bots-dialog',
        ref: dialog => { if (dialog && !dialog.open) dialog.showModal(); },
        'aria-label': '新建 Bot',
        onCancel: event => { event.preventDefault(); if (!saving) setEditing(false); },
      }, h('form', { className: 'bots-create', 'aria-label': '新建 Bot', onSubmit: create, onKeyDown: event => {
        if (event.metaKey && event.key === 'Enter' && !event.nativeEvent?.isComposing) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      } },
        h('h2', null, '新建 Bot'),
        error && h('p', { role: 'alert' }, error),
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
        h('div', { className: 'bots-fields' }, h('label', null, '运行设备', h('select', {
          name: 'device', value: deviceId, onChange: event => setDeviceId(event.target.value),
        }, ...devices.map(device => h('option', {
          key: device.id, value: device.id, disabled: device.status !== 'ready',
        }, device.label + (device.status === 'ready' ? '' : ' · 未连接'))))),
        h('label', null, 'Agent', h('select', { name: 'engine' }, ...engines.map(engine => h('option', { key: engine }, engine))))),
        h('footer', null,
          h('button', { type: 'button', disabled: saving, onClick: () => setEditing(false) }, '取消'),
          h('button', { className: 'bots-primary', type: 'submit', disabled: saving || !engines.length }, saving ? '正在创建…' : '创建 Bot')))),
      section === 'hosts' && !loading && h('button', { type: 'button', onClick: () => setAddingHost(true) }, '添加主机'),
      section === 'hosts' && probeNotice && h('p', { role: 'status' }, probeNotice),
      section === 'hosts' && devices.map(device => h('article', { key: device.id },
        h('h2', null, device.label),
        h('p', null, device.status === 'ready' ? device.engines.join(' · ') : '离线 · 无可用 Agent'),
        device.id.startsWith('device-') && h('button', { type: 'button', disabled: !!probing, onClick: () => void checkHost(device) }, '检查 SSH'))),
      section === 'hosts' && addingHost && h('form', { onSubmit: addHost, 'aria-label': '添加主机' },
        h('label', null, '显示名称', h('input', { name: 'label', required: true, maxLength: 80 })),
        h('label', null, 'SSH 别名', h('input', { name: 'alias', required: true, maxLength: 80 })),
        h('button', { type: 'submit', disabled: saving }, '登记主机'),
        h('button', { type: 'button', onClick: () => setAddingHost(false) }, '取消')),
      loading && h('p', { role: 'status' }, '正在读取 Bots…'),
      section === 'bots' && !loading && !error && !profiles.length && !editing && h('section', { className: 'bots-empty' },
        h('span', { className: 'bots-icon' }, h(BotIcon)),
        h('h2', null, '创建你的第一个 Bot'),
        h('p', null, '从模板开始，选择运行设备和 Agent。'),
        h('button', { className: 'bots-primary', type: 'button', onClick: openCreate, disabled: !devices.length }, '新建 Bot')),
      section === 'offers' && !loading && h(Offers, { onAccepted: async () => {
        const response = await request('/api/bots');
        if (!response.ok) throw new Error();
        setProfiles((await response.json()).bots);
      } }),
      section === 'teams' && !loading && h(Teams, { profiles }),
      section === 'bots' && profiles.map(bot => h('article', { key: bot.id },
        h('header', { className: 'bots-card-header' },
          h('span', { className: 'bots-icon', 'aria-hidden': true }, avatars[bot.avatar] && bot.avatar !== 'initial' ? avatars[bot.avatar] : Array.from(bot.name)[0]),
          h('div', null, h('h2', null, bot.name),
            h('small', null, `${devices.find(device => device.id === bot.device)?.label ?? bot.device} · ${bot.engine}`)),
          h('button', { type: 'button', onClick: () => setSelected(selected === bot.id ? null : bot.id), 'aria-expanded': selected === bot.id }, selected === bot.id ? '收起会话' : '打开会话')),
        h('p', { className: 'bots-description' }, bot.purpose),
        selected === bot.id && h('details', null,
          h('summary', null, '编辑 Bot'),
          h('form', { onSubmit: event => void updateProfile(event, bot.id) },
            h('label', null, '名称', h('input', { name: 'name', required: true, maxLength: 80, defaultValue: bot.name })),
            h('label', null, '职责', h('textarea', { name: 'purpose', required: true, maxLength: 1000, defaultValue: bot.purpose })),
            h('label', null, '主机和 Agent', h('select', {
              name: 'runtime', defaultValue: JSON.stringify([bot.device, bot.engine]),
            },
            h('option', { value: JSON.stringify([bot.device, bot.engine]) }, '当前配置 · ' + bot.engine),
            ...devices.filter(device => device.status === 'ready').flatMap(device =>
              device.engines.filter(engine => device.id !== bot.device || engine !== bot.engine).map(engine => {
                const value = JSON.stringify([device.id, engine]);
                return h('option', { key: value, value }, device.label + ' · ' + engine);
              })))),
            h('button', { type: 'submit' }, '保存配置'))),
        selected === bot.id && h('label', null, '编辑头像', h('select', {
          value: bot.avatar ?? 'initial', onChange: event => void updateAvatar(bot.id, event.target.value),
        }, ...Object.entries(avatars).map(([value, label]) => h('option', { key: value, value }, label)))),
        selected === bot.id && h('p', null, runtimePermissions[bot.engine] ?? '工具权限由目标设备配置。'),
        selected === bot.id && h(Conversation, { bot }))));
  }

  function BotIcon() {
    return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', 'aria-hidden': true },
    h('rect', { x: 4, y: 7, width: 16, height: 13, rx: 4 }),
    h('path', { d: 'M12 7V4m-3 9h.01m6 0h.01M10 16h4M2 12v3m20-3v3' }));
  }

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panel, order: 6, label: () => 'Bots',
  }, BotIcon));
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panel,
  }, Bots));
  return openBots;
}
