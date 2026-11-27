// New Bot dialog, Bot row, and group row layouts adapted from stablyai/orca at 16852f2d.
/*
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
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
    const pendingTurn = React.useRef(null);
    const transcript = React.useRef(null);
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

    React.useEffect(() => {
      const viewport = transcript.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    }, [turns]);

    async function send(event) {
      event.preventDefault();
      const prompt = draft.trim();
      if (!ready || sending || !prompt) return;
      if (pendingTurn.current?.prompt !== prompt) pendingTurn.current = { id: crypto.randomUUID(), prompt };
      setSending(true);
      setNotice('');
      try {
        const response = await request(endpoint, {
          method: 'POST',
          body: JSON.stringify(pendingTurn.current),
        });
        if (!response.ok) throw new Error();
        const turn = await response.json();
        if (turn.status === 'running') {
          setNotice('上一条消息仍在执行。稍后再次发送可查看结果。');
          return;
        }
        setTurns(current => [...current.filter(item => item.id !== turn.id), turn]);
        pendingTurn.current = null;
        setDraft('');
      } catch {
        setNotice('未能确认发送结果。再次发送同一条消息可恢复结果。');
      } finally {
        setSending(false);
      }
    }

    const labels = { running: '执行中', failed: '执行失败', interrupted: '已中断' };
    return h('section', { className: 'bots-conversation', 'aria-label': bot.name + ' 会话' },
      h('div', { className: 'bots-transcript', ref: transcript },
        ...turns.map(turn => h('article', { className: 'bots-turn', key: turn.id },
        h('p', { style: { whiteSpace: 'pre-wrap' } }, turn.prompt),
        h('p', { style: { whiteSpace: 'pre-wrap' } }, turn.reply || labels[turn.status])))),
      notice && h('p', { role: 'alert' }, notice),
      h('form', { className: 'bots-composer', onSubmit: send },
        h('label', null, '消息', h('textarea', {
          required: true, maxLength: 2400, value: draft, disabled: sending,
          onChange: event => setDraft(event.target.value),
        })),
        h('button', { type: 'submit', disabled: !ready || sending || !draft.trim() }, sending ? '执行中…' : '发送')));
  }

  const teamRequests = new Map();

  function TeamDispatch({ team, members }) {
    const [running, setRunning] = React.useState(false);
    const [activeId, setActiveId] = React.useState(null);
    const [resumedId, setResumedId] = React.useState(() => teamRequests.get(team.id) ?? null);
    const [cancelling, setCancelling] = React.useState(false);
    const [history, setHistory] = React.useState([]);
    const [notice, setNotice] = React.useState('');
    const pending = React.useRef(null);
    const endpoint = '/api/bots/teams/' + team.id + '/dispatch';
    const recoveredDispatch = history.find(entry => entry.active || entry.results.some(item => item.body.status === 'running'));
    const busy = running || Boolean(resumedId || recoveredDispatch);
    const canRefresh = busy && !running;


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

    React.useEffect(() => {
      if (!canRefresh) return undefined;
      const controller = new AbortController();
      let nextPoll;
      async function poll() {
        try {
          const response = await request(endpoint, { signal: controller.signal });
          if (!response.ok) throw new Error();
          const { dispatches } = await response.json();
          if (!controller.signal.aborted) {
            setHistory(dispatches);
            setResumedId(teamRequests.get(team.id) ?? null);
          }
        } catch {
          if (!controller.signal.aborted) setNotice('无法刷新派工状态。');
        } finally {
          if (!controller.signal.aborted) nextPoll = setTimeout(poll, 1500);
        }
      }
      nextPoll = setTimeout(poll, 1500);
      return () => {
        controller.abort();
        clearTimeout(nextPoll);
      };
    }, [endpoint, canRefresh, team.id]);

    async function submit(event) {
      event.preventDefault();
      if (busy) return;
      const form = event.currentTarget;
      const prompt = String(new FormData(form).get('task') ?? '').trim();
      if (!prompt) return;
      if (pending.current?.prompt !== prompt) {
        pending.current = { prompt, id: crypto.randomUUID() };
      }
      await dispatch(pending.current, form);
    }

    async function dispatch(task, form) {
      if (busy) return;
      teamRequests.set(team.id, task.id);
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
        teamRequests.delete(team.id);
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
      h('form', { className: 'bots-composer', onSubmit: submit },
        h('label', null, '团队任务', h('textarea', { name: 'task', required: true, maxLength: 2400, disabled: busy })),
        h('button', { type: 'submit', disabled: busy || cancelling }, busy ? '正在派工…' : '发给团队')),
      (activeId || recoveredDispatch) && h('button', { type: 'button', disabled: cancelling,
        onClick: () => void cancelDispatch(activeId ?? recoveredDispatch.id) }, '请求中止派工'),
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
    const [selected, setSelected] = React.useState(null);
    const activeTeam = teams.find(team => team.id === selected) ?? teams[0];
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
        setSelected(team.id);
        setEditing(false);
      } catch {
        setError('无法保存团队。');
      } finally {
        setSaving(false);
      }
    }

    return h('section', { 'aria-label': 'Bot 团队' },
      h('header', { className: 'bots-team-header' }, h('h2', null, '团队'),
        h('button', { type: 'button', disabled: !ready || profiles.length < 2, onClick: () => { setError(''); setEditing(true); } }, '新建团队')),
      error && h('p', { role: 'alert' }, error),
      editing && h('form', { onSubmit: create, 'aria-label': '新建团队' },
        h('label', null, '团队名称', h('input', { name: 'teamName', required: true, maxLength: 80 })),
        h('fieldset', { className: 'bots-team-members' }, h('legend', null, '成员'),
          ...profiles.map(bot => h('label', { key: bot.id },
            h('input', { type: 'checkbox', name: 'member', value: bot.id }), bot.name))),
        h('button', { type: 'submit', disabled: saving }, '保存团队'),
        h('button', { type: 'button', disabled: saving, onClick: () => setEditing(false) }, '取消')),
      activeTeam && h('div', { className: 'bots-workspace' },
        h('nav', { className: 'bots-list', 'aria-label': '团队列表' },
          ...teams.map(team => {
            const members = team.botIds.map(id => profiles.find(bot => bot.id === id)).filter(Boolean);
            return h('button', { key: team.id, type: 'button', onClick: () => setSelected(team.id),
              'aria-current': activeTeam.id === team.id ? 'true' : undefined },
            h('span', { className: 'bots-team-faces', 'aria-hidden': true },
              ...members.slice(0, 3).map(bot => h('span', { key: bot.id }, Array.from(bot.name)[0]))),
            h('span', { className: 'bots-row-text' }, h('strong', null, team.name),
              h('small', null, members.map(bot => bot.name).join('、'))));
          })),
        h('section', { className: 'bots-detail', 'aria-label': activeTeam.name, key: activeTeam.id },
          h('header', null, h('div', null, h('h2', null, activeTeam.name), h('small', null,
            activeTeam.botIds.map(id => profiles.find(bot => bot.id === id)?.name ?? id).join(' · ')))),
          h(TeamDispatch, { team: activeTeam, members: profiles }))),
      ready && teams.length === 0 && !editing && h('p', null, '还没有团队。选择至少两个 Bot 创建团队。'));
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

  function BotTrigger({ bot }) {
    const [config, setConfig] = React.useState(null);
    const [prompt, setPrompt] = React.useState('');
    const [token, setToken] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState('');
    const endpoint = '/api/bots/' + bot.id + '/trigger';

    React.useEffect(() => {
      let active = true;
      void (async () => {
        try {
          const response = await request(endpoint);
          if (!response.ok) throw new Error();
          const saved = await response.json();
          if (active) {
            setConfig(saved);
            setPrompt(saved.prompt ?? '');
          }
        } catch {
          if (active) setNotice('无法读取触发器。');
        }
      })();
      return () => { active = false; };
    }, [endpoint]);

    async function save(enabled) {
      setBusy(true);
      setToken('');
      setNotice('');
      try {
        const response = await request(endpoint, { method: 'POST', body: JSON.stringify({ enabled, prompt }) });
        if (!response.ok) throw new Error();
        const saved = await response.json();
        setConfig({ enabled: saved.enabled });
        if (saved.token) setToken(saved.token);
      } catch {
        setNotice('无法保存触发器。');
      } finally {
        setBusy(false);
      }
    }

    return h('details', null,
      h('summary', null, '本机触发器'),
      h('form', { onSubmit: event => { event.preventDefault(); void save(true); } },
        h('label', null, '触发时发送的消息',
          h('textarea', { value: prompt, required: true, maxLength: 2400, onChange: event => setPrompt(event.target.value) })),
        h('button', { type: 'submit', disabled: busy || !config }, config?.enabled ? '保存并更换令牌' : '启用触发器'),
        config?.enabled && h('button', { type: 'button', disabled: busy, onClick: () => void save(false) }, '撤销触发器'),
        token && h('label', null, '触发令牌（仅显示一次）', h('input', { readOnly: true, value: token })),
        token && h('p', null, '本机地址 ', 'http://127.0.0.1:4328' + endpoint),
        notice && h('p', { role: 'alert' }, notice)));
  }

  function Bots() {
    const [template, setTemplate] = React.useState('');
    const [avatar, setAvatar] = React.useState('initial');
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
    const activeBot = profiles.find(bot => bot.id === selected);

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

    async function refreshDevices() {
      const response = await request('/api/bots');
      if (!response.ok) throw new Error('无法刷新运行设备。');
      const data = await response.json();
      setDevices(data.devices ?? []);
      setDeviceWarning(data.warning ?? '');
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
        await refreshDevices();
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
        const { reachable, runtimeReady } = await response.json();
        await refreshDevices();
        setProbeNotice(device.label + (runtimeReady ? ' · Agent 已就绪' : reachable ? ' · SSH 可达，Agent 尚未连接' : ' · SSH 连接失败'));
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
          method: 'POST', body: JSON.stringify({ name: fields.get('name'), purpose: fields.get('purpose'), device, engine, toolScope: fields.get('toolScope') ?? undefined }),
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
      setAvatar('initial');
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
        .dsh-bots .bots-workspace{display:grid;grid-template-columns:minmax(200px,28%) minmax(0,1fr);border:1px solid var(--bot-line);border-radius:14px;height:clamp(340px,calc(100dvh - 220px),720px);overflow:hidden}
        .dsh-bots .bots-list{padding:10px;border-right:1px solid var(--bot-line);min-width:0;overflow:auto;background:color-mix(in srgb,currentColor 3%,transparent)}
        .dsh-bots .bots-list h2{font-size:13px;margin:7px 8px 10px}
        .dsh-bots .bots-list button{display:flex;align-items:center;gap:9px;width:100%;margin:2px 0;padding:7px;border-color:transparent;text-align:left}
        .dsh-bots .bots-list button[aria-current=true]{border-color:var(--bot-line);background:var(--bot-tint)}
        .dsh-bots .bots-list .bots-icon{width:33px;height:33px;flex:none;margin:0;border-radius:10px}
        .dsh-bots .bots-team-header{margin:0 0 12px}
        .dsh-bots .bots-team-faces{position:relative;width:33px;height:33px;flex:none}
        .dsh-bots .bots-team-faces span{position:absolute;display:grid;place-items:center;width:21px;height:21px;border:1px solid var(--bot-line);border-radius:50%;background:Canvas;color:CanvasText;font-size:10px}
        .dsh-bots .bots-team-faces span:nth-child(2){right:0;bottom:0}
        .dsh-bots .bots-team-faces span:nth-child(3){left:0;bottom:0}
        .dsh-bots .bots-row-text{display:grid;gap:2px;min-width:0}
        .dsh-bots .bots-row-text>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dsh-bots .bots-detail{min-width:0;min-height:0;padding:18px;display:flex;flex-direction:column;overflow:auto}
        .dsh-bots .bots-detail>header{align-items:first baseline;border-bottom:1px solid var(--bot-line);padding-bottom:12px}
        .dsh-bots .bots-detail>header details{flex:none}
        .dsh-bots .bots-detail>details>summary{cursor:pointer;margin:10px 0}
        .dsh-bots .bots-conversation{display:flex;flex:1;flex-direction:column;min-height:180px}
        .dsh-bots .bots-transcript{flex:1;min-height:0;overflow:auto;padding-right:4px}
        .dsh-bots .bots-conversation .bots-turn{border:0;padding:0;margin:16px 0}
        .dsh-bots .bots-turn p{padding:9px 12px;margin:5px 0;max-width:90%;width:fit-content;border-radius:10px}
        .dsh-bots .bots-turn p:first-child{margin-left:auto;background:var(--bot-tint)}
        .dsh-bots .bots-turn p:last-child{background:color-mix(in srgb,currentColor 5%,transparent)}
        .dsh-bots .bots-composer{padding:10px;margin-bottom:0}
        .dsh-bots .bots-composer label{margin:0 0 7px}
        .dsh-bots .bots-composer textarea{min-height:58px}
        @media(max-width:720px){.dsh-bots .bots-workspace{grid-template-columns:1fr;grid-template-rows:auto minmax(260px,1fr);height:auto}.dsh-bots .bots-list{border-right:0;border-bottom:1px solid var(--bot-line);max-height:220px;overflow:auto}}
        .dsh-bots h1{font-size:clamp(28px,5vw,42px);line-height:1.1;letter-spacing:-.04em;margin:0}
        .dsh-bots h2{font-size:18px;margin:0}.dsh-bots header p,.dsh-bots small{opacity:.74}
        .dsh-bots form,.dsh-bots article,.dsh-bots .bots-empty{border:1px solid var(--bot-line);border-radius:16px;padding:20px;margin:16px 0;overflow-wrap:anywhere}
        .dsh-bots .bots-dialog{box-sizing:border-box;width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 32px);padding:0;color:inherit;background:var(--dsw-alias-bg-primary,Canvas);border:1px solid var(--bot-line);border-radius:18px;box-shadow:0 28px 100px #0007}
        .dsh-bots .bots-dialog::backdrop{background:#0706109c;backdrop-filter:blur(4px)}
        .dsh-bots .bots-create{position:relative;isolation:isolate;margin:0;padding:24px;border:0}
        .dsh-bots .bots-create::before{content:"";position:absolute;z-index:-1;inset:0 0 auto;height:110px;background:linear-gradient(180deg,color-mix(in srgb,#8bbde4 28%,transparent),transparent)}
        .dsh-bots .bots-create-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
        .dsh-bots .bots-create-close{border:0;padding:4px 8px;font-size:22px;line-height:1}
        .dsh-bots .bots-identity{display:flex;align-items:center;gap:16px;margin:0 0 16px}
        .dsh-bots .bots-identity input{min-width:0;border:0;background:transparent;font-size:24px;font-weight:650;padding:6px 0}
        .dsh-bots .bots-avatar-picker{position:relative;display:grid;place-items:center;flex:none;width:68px;height:68px;border-radius:21px;color:var(--bot-accent);background:var(--bot-tint);border:1px solid var(--bot-line);font-size:28px;cursor:pointer;margin:0}
        .dsh-bots .bots-avatar-picker select{position:absolute;inset:0;height:100%;opacity:0;cursor:pointer}
        .dsh-bots .bots-avatar-picker:focus-within{outline:2px solid var(--bot-accent);outline-offset:2px}
        .dsh-bots .bots-avatar-picker .avatar-edit{position:absolute;right:-4px;bottom:-4px;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:Canvas;color:CanvasText;border:1px solid var(--bot-line);font-size:13px;pointer-events:none}
        .dsh-bots .bots-create textarea{display:block;min-height:112px;padding:10px 12px}
        .dsh-bots .bots-create footer{display:flex;align-items:end;justify-content:flex-end;gap:10px;margin-top:14px}
        .dsh-bots .bots-create footer button{margin:0}
        .dsh-bots .bots-create footer label{display:flex;align-items:center;gap:6px;margin:0;font-size:12px}
        .dsh-bots .bots-create footer select{width:auto;max-width:145px}
        .dsh-bots .bots-create kbd{margin-left:9px;opacity:.8;font-size:11px}
        .dsh-bots .bots-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
        @media(max-width:580px){.dsh-bots .bots-fields{grid-template-columns:1fr;gap:0}.dsh-bots .bots-hero{align-items:flex-start;flex-direction:column}}
        .dsh-bots .bots-empty{text-align:center;padding:36px 24px;background:var(--bot-tint)}
        .dsh-bots .bots-icon{display:inline-grid;place-items:center;width:42px;height:42px;border-radius:14px;background:var(--bot-tint);color:var(--bot-accent);margin-bottom:14px}
        .dsh-bots label{display:grid;gap:6px;margin:12px 0;font-weight:550}
        .dsh-bots input,.dsh-bots select,.dsh-bots textarea,.dsh-bots button{box-sizing:border-box;font:inherit;padding:9px 12px;border-radius:9px;border:1px solid var(--bot-line);color:inherit;background:transparent}
        .dsh-bots input,.dsh-bots select,.dsh-bots textarea{width:100%;background:color-mix(in srgb,Canvas 72%,transparent)}
        .dsh-bots .bots-team-members{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin:16px 0;padding:12px;border:1px solid var(--bot-line);border-radius:12px}
        .dsh-bots .bots-team-members label{display:flex;align-items:center;gap:9px;margin:0;padding:9px;border-radius:8px}
        .dsh-bots .bots-team-members label:has(:checked){background:var(--bot-tint)}
        .dsh-bots .bots-team-members input{width:16px;height:16px;flex:none;margin:0;accent-color:var(--bot-accent)}
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
        ref: dialog => {
          if (dialog && !dialog.open) {
            dialog.showModal();
            dialog.querySelector('input[name=name]')?.focus();
          }
        },
        'aria-label': '新建 Bot',
        onCancel: event => { event.preventDefault(); if (!saving) setEditing(false); },
      }, h('form', { className: 'bots-create', 'aria-label': '新建 Bot', onSubmit: create, onKeyDown: event => {
        if (event.metaKey && event.key === 'Enter' && !event.nativeEvent?.isComposing) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      } },
        h('div', { className: 'bots-create-heading' },
          h('h2', null, '新建 Bot'),
          h('button', { className: 'bots-create-close', type: 'button', 'aria-label': '关闭', disabled: saving,
            onClick: () => setEditing(false) }, '×')),
        error && h('p', { role: 'alert' }, error),
        h('div', { className: 'bots-identity' },
          h('label', { className: 'bots-avatar-picker' },
            avatar === 'initial' ? (Array.from(name.trim())[0] || h(BotIcon)) : avatars[avatar],
            h('span', { className: 'avatar-edit', 'aria-hidden': true }, '✎'),
            h('select', { name: 'avatar', 'aria-label': '头像', value: avatar, onChange: event => setAvatar(event.target.value) },
              ...Object.entries(avatars).map(([value, label]) => h('option', { key: value, value }, label)))),
          h('input', { name: 'name', 'aria-label': '名称', placeholder: '名称', value: name, onChange: event => setName(event.target.value), required: true, maxLength: 80 })),
        h('textarea', { name: 'purpose', 'aria-label': '职责', placeholder: '它是谁，负责什么？', value: purpose, onChange: event => setPurpose(event.target.value), required: true, maxLength: 1000 }),
        h('div', { className: 'bots-fields' }, h('label', null, '运行设备', h('select', {
          name: 'device', value: deviceId, onChange: event => setDeviceId(event.target.value),
        }, ...devices.map(device => h('option', {
          key: device.id, value: device.id, disabled: device.status !== 'ready',
        }, device.label + (device.status === 'ready' ? '' : ' · 未连接'))))),
        h('label', null, 'Agent', h('select', { name: 'engine' }, ...engines.map(engine => h('option', { key: engine }, engine))))),
        h('footer', null,
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
          h('button', { className: 'bots-primary', type: 'submit', disabled: saving || !engines.length },
            saving ? '正在创建…' : '创建 Bot', h('kbd', { 'aria-hidden': true }, '⌘↵'))))),
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
      section === 'bots' && profiles.length > 0 && h('div', { className: 'bots-workspace' },
        h('nav', { className: 'bots-list', 'aria-label': 'Bot 列表' },
          h('h2', null, 'Bots'),
          ...profiles.map(bot => h('button', { key: bot.id, type: 'button', onClick: () => setSelected(bot.id),
            'aria-current': selected === bot.id ? 'true' : undefined },
          h('span', { className: 'bots-icon', 'aria-hidden': true }, avatars[bot.avatar] && bot.avatar !== 'initial' ? avatars[bot.avatar] : Array.from(bot.name)[0]),
          h('span', { className: 'bots-row-text' }, h('strong', null, bot.name), h('small', null, bot.purpose))))),
        activeBot ? renderBot(activeBot) : h('section', { className: 'bots-detail' },
          h('p', null, '选择一个 Bot 打开会话。'))));
    function renderBot(bot) {
      return h('section', { className: 'bots-detail', key: bot.id },
        h('header', null, h('div', null, h('h2', null, bot.name),
          h('small', null, `${devices.find(device => device.id === bot.device)?.label ?? bot.device} · ${bot.engine}`))),
        h('details', null,
          h('summary', null, 'Bot 设置'),
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
            bot.device === 'local' && bot.engine === 'ds-agent' &&
              (bot.toolScope === 'conversation' || devices.find(device => device.id === 'local')?.toolScopes?.includes('conversation')) &&
              h('label', null, '工具权限', h('select', { name: 'toolScope', defaultValue: bot.toolScope ?? 'default' },
                h('option', { value: 'default' }, '运行时默认'),
                h('option', { value: 'conversation' }, '仅会话'))),
            h('label', null, '编辑头像', h('select', {
              value: bot.avatar ?? 'initial', onChange: event => void updateAvatar(bot.id, event.target.value),
            }, ...Object.entries(avatars).map(([value, label]) => h('option', { key: value, value }, label)))),
            h('p', null, bot.toolScope === 'conversation' ? '仅会话 · 外部工具已关闭' : (bot.device === 'local' ? (runtimePermissions[bot.engine] ?? '工具权限由目标设备配置。') : '工具权限由远程运行时执行。')),
            h('button', { type: 'submit' }, '保存配置'))),
        bot.toolScope === 'conversation' && h(BotTrigger, { key: bot.id, bot }),
        h(Conversation, { key: bot.id, bot }));
    }
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
