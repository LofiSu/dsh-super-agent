import type { SnapshotEvent, SnapshotOutbox, SnapshotThread, SnapshotTicket, UiSnapshot } from './server.ts'

const PAGE_STYLE = `
:root {
  color-scheme: light dark;
  --bg: #0f172a;
  --panel: #16213a;
  --line: #2b3a55;
  --text: #e6edf7;
  --muted: #94a3b8;
  --accent: #7dd3fc;
  --ok: #86efac;
  --warn: #fde68a;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; margin-bottom: 20px; }
h1 { font-size: 20px; margin: 0; letter-spacing: 0.01em; }
h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 8px; }
.sub { color: var(--muted); }
.live { color: var(--ok); font-variant-numeric: tabular-nums; }
main { display: grid; gap: 18px; max-width: 1180px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
code { color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.empty { color: var(--muted); font-style: italic; }
.count { color: var(--muted); font-weight: 400; margin-left: 6px; }
.wrap { overflow-wrap: anywhere; }
`

/** Escape untrusted text before it reaches the HTML page. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/gu, char => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return char
    }
  })
}

/** Render all snapshot sections with one implementation for SSR and SSE updates. */
export function renderSnapshotContent(snapshot: UiSnapshot): string {
  const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/gu, char => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return char
    }
  })
  const code = (value: unknown): string => `<code>${escape(value)}</code>`
  const table = (headers: readonly string[], rows: readonly (readonly string[])[], empty: string): string => {
    if (rows.length === 0) return `<p class="empty">${escape(empty)}</p>`
    const head = headers.map(header => `<th>${escape(header)}</th>`).join('')
    const body = rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  }
  const ticketRows = (tickets: readonly SnapshotTicket[]): string[][] => tickets.map(ticket => [
    code(ticket.id),
    `<span class="wrap">${escape(ticket.title)}</span>`,
    code(ticket.stage),
    ticket.ended ? 'yes' : 'no',
    ticket.paused ? 'yes' : 'no',
    code(ticket.createdAt),
  ])
  const threadRows = (threads: readonly SnapshotThread[]): string[][] => threads.map(thread => [
    code(thread.key),
    thread.subscriptions.length === 0 ? '<span class="empty">none</span>' : thread.subscriptions.map(code).join(', '),
    String(thread.pending),
    thread.deferred ? 'yes' : 'no',
    thread.lastAt ? code(thread.lastAt) : '<span class="empty">-</span>',
  ])
  const outboxRows = (outbox: readonly SnapshotOutbox[]): string[][] => outbox.map(row => [
    code(row.id), code(row.status), code(row.channel), code(row.thread), code(row.ticketId),
    String(row.attempts), code(row.createdAt),
  ])
  const eventRows = (events: readonly SnapshotEvent[]): string[][] => events.map(event => [
    code(event.kind), `<span class="wrap">${escape(JSON.stringify(event.payload) ?? '')}</span>`,
  ])
  const counters = Object.entries(snapshot.metrics.counters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => [code(name), String(value)])
  const latency = snapshot.metrics.modelLatencyMs
  const healthRows = [
    [code('store'), escape(snapshot.health.store)],
    [code('vault'), escape(snapshot.health.vaultMode)],
    [code('machines online'), String(snapshot.health.machinesOnline)],
    [code('watchdog idle'), snapshot.health.watchdogIdle ? 'yes' : 'no'],
  ]

  return `<section>
  <h2>Health</h2>
  ${table(['check', 'value'], healthRows, 'no health data')}
</section>
<section>
  <h2>Metrics<span class="count">${counters.length} counters</span></h2>
  ${table(['counter', 'value'], counters, 'no counters')}
  <p class="sub">model latency: count ${escape(latency.count)} · sum ${escape(latency.sum)} ms · max ${escape(latency.max)} ms · last ${escape(latency.last)} ms</p>
</section>
<section>
  <h2>Tickets<span class="count">${snapshot.tickets.length}</span></h2>
  ${table(['id', 'title', 'stage', 'ended', 'paused', 'created'], ticketRows(snapshot.tickets), 'no tickets')}
</section>
<section>
  <h2>Threads<span class="count">${snapshot.threads.length}</span></h2>
  ${table(['thread', 'subscriptions', 'pending', 'deferred', 'last'], threadRows(snapshot.threads), 'no threads')}
</section>
<section>
  <h2>Outbox<span class="count">${snapshot.outbox.length}</span></h2>
  ${table(['id', 'status', 'channel', 'thread', 'ticket', 'attempts', 'created'], outboxRows(snapshot.outbox), 'no outbox rows')}
</section>
<section>
  <h2>Lifecycle events<span class="count">${snapshot.events.length}</span></h2>
  ${table(['kind', 'payload'], eventRows(snapshot.events), 'no lifecycle events')}
</section>`
}

/** Reject malformed JSON values before the renderer or visible page is changed. */
export function isUiSnapshot(value: unknown): value is UiSnapshot {
  if (value === null || typeof value !== 'object') return false
  const snapshot = value as Record<string, unknown>
  const isRecord = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)
  if (typeof snapshot.generatedAt !== 'string' || !Array.isArray(snapshot.tickets)
    || !Array.isArray(snapshot.threads) || !Array.isArray(snapshot.outbox) || !Array.isArray(snapshot.events)
    || !isRecord(snapshot.health) || !isRecord(snapshot.metrics)) return false
  const health = snapshot.health
  const metrics = snapshot.metrics
  if (typeof health.store !== 'string' || typeof health.vaultMode !== 'string'
    || typeof health.machinesOnline !== 'number' || typeof health.watchdogIdle !== 'boolean'
    || !isRecord(metrics.counters) || !isRecord(metrics.modelLatencyMs)) return false
  const latency = metrics.modelLatencyMs
  if (typeof latency.count !== 'number' || typeof latency.sum !== 'number'
    || typeof latency.max !== 'number' || typeof latency.last !== 'number') return false
  return snapshot.tickets.every(item => isRecord(item) && typeof item.id === 'string'
    && typeof item.title === 'string' && typeof item.stage === 'string' && typeof item.ended === 'boolean'
    && typeof item.paused === 'boolean' && typeof item.createdAt === 'string')
    && snapshot.threads.every(item => isRecord(item) && typeof item.key === 'string'
      && Array.isArray(item.subscriptions) && item.subscriptions.every(id => typeof id === 'string')
      && typeof item.pending === 'number' && typeof item.deferred === 'boolean'
      && (item.lastAt === undefined || typeof item.lastAt === 'string'))
    && snapshot.outbox.every(item => isRecord(item) && typeof item.id === 'string' && typeof item.ticketId === 'string'
      && typeof item.status === 'string' && typeof item.channel === 'string' && typeof item.thread === 'string'
      && typeof item.attempts === 'number' && typeof item.createdAt === 'string')
    && snapshot.events.every(item => isRecord(item) && typeof item.kind === 'string' && isRecord(item.payload))
    && Object.values(metrics.counters).every(count => typeof count === 'number')
}

/** Apply a valid snapshot atomically; malformed frames preserve the last view. */
export function applySnapshot(
  snapshot: unknown,
  content: { innerHTML: string },
  generated: { textContent: string | null },
): boolean {
  try {
    if (!isUiSnapshot(snapshot)) return false
    const rendered = renderSnapshotContent(snapshot)
    content.innerHTML = rendered
    generated.textContent = `generated ${snapshot.generatedAt}`
    return true
  } catch {
    return false
  }
}

function browserApplyScript(): string {
  // Keep this as plain browser JavaScript. The host functions above pass through
  // tsx/esbuild, whose function source can contain helpers unavailable in-page.
  return `(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isUiSnapshot = value => {
    if (!isRecord(value) || typeof value.generatedAt !== 'string'
      || !Array.isArray(value.tickets) || !Array.isArray(value.threads)
      || !Array.isArray(value.outbox) || !Array.isArray(value.events)
      || !isRecord(value.health) || !isRecord(value.metrics)) return false;
    const health = value.health;
    const metrics = value.metrics;
    if (typeof health.store !== 'string' || typeof health.vaultMode !== 'string'
      || typeof health.machinesOnline !== 'number' || typeof health.watchdogIdle !== 'boolean'
      || !isRecord(metrics.counters) || !isRecord(metrics.modelLatencyMs)) return false;
    const latency = metrics.modelLatencyMs;
    if (['count', 'sum', 'max', 'last'].some(key => typeof latency[key] !== 'number')) return false;
    return value.tickets.every(item => isRecord(item) && typeof item.id === 'string'
      && typeof item.title === 'string' && typeof item.stage === 'string'
      && typeof item.ended === 'boolean' && typeof item.paused === 'boolean'
      && typeof item.createdAt === 'string')
      && value.threads.every(item => isRecord(item) && typeof item.key === 'string'
        && Array.isArray(item.subscriptions) && item.subscriptions.every(id => typeof id === 'string')
        && typeof item.pending === 'number' && typeof item.deferred === 'boolean'
        && (item.lastAt === undefined || typeof item.lastAt === 'string'))
      && value.outbox.every(item => isRecord(item) && typeof item.id === 'string'
        && typeof item.ticketId === 'string' && typeof item.status === 'string'
        && typeof item.channel === 'string' && typeof item.thread === 'string'
        && typeof item.attempts === 'number' && typeof item.createdAt === 'string')
      && value.events.every(item => isRecord(item) && typeof item.kind === 'string' && isRecord(item.payload))
      && Object.values(metrics.counters).every(count => typeof count === 'number');
  };
  const renderSnapshotContent = snapshot => {
    const code = value => '<code>' + escape(value) + '</code>';
    const table = (headers, rows, empty) => rows.length === 0
      ? '<p class="empty">' + escape(empty) + '</p>'
      : '<table><thead><tr>' + headers.map(header => '<th>' + escape(header) + '</th>').join('')
        + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>';
    const tickets = snapshot.tickets.map(ticket => [code(ticket.id), '<span class="wrap">' + escape(ticket.title) + '</span>',
      code(ticket.stage), ticket.ended ? 'yes' : 'no', ticket.paused ? 'yes' : 'no', code(ticket.createdAt)]);
    const threads = snapshot.threads.map(thread => [code(thread.key), thread.subscriptions.length === 0
      ? '<span class="empty">none</span>' : thread.subscriptions.map(code).join(', '), String(thread.pending),
      thread.deferred ? 'yes' : 'no', thread.lastAt ? code(thread.lastAt) : '<span class="empty">-</span>']);
    const outbox = snapshot.outbox.map(row => [code(row.id), code(row.status), code(row.channel), code(row.thread),
      code(row.ticketId), String(row.attempts), code(row.createdAt)]);
    const events = snapshot.events.map(event => [code(event.kind), '<span class="wrap">' + escape(JSON.stringify(event.payload) ?? '') + '</span>']);
    const counters = Object.entries(snapshot.metrics.counters).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [code(name), String(value)]);
    const latency = snapshot.metrics.modelLatencyMs;
    const health = [[code('store'), escape(snapshot.health.store)], [code('vault'), escape(snapshot.health.vaultMode)],
      [code('machines online'), String(snapshot.health.machinesOnline)], [code('watchdog idle'), snapshot.health.watchdogIdle ? 'yes' : 'no']];
    return '<section><h2>Health</h2>' + table(['check', 'value'], health, 'no health data') + '</section>'
      + '<section><h2>Metrics<span class="count">' + counters.length + ' counters</span></h2>'
      + table(['counter', 'value'], counters, 'no counters') + '<p class="sub">model latency: count '
      + escape(latency.count) + ' · sum ' + escape(latency.sum) + ' ms · max ' + escape(latency.max)
      + ' ms · last ' + escape(latency.last) + ' ms</p></section>'
      + '<section><h2>Tickets<span class="count">' + snapshot.tickets.length + '</span></h2>'
      + table(['id', 'title', 'stage', 'ended', 'paused', 'created'], tickets, 'no tickets') + '</section>'
      + '<section><h2>Threads<span class="count">' + snapshot.threads.length + '</span></h2>'
      + table(['thread', 'subscriptions', 'pending', 'deferred', 'last'], threads, 'no threads') + '</section>'
      + '<section><h2>Outbox<span class="count">' + snapshot.outbox.length + '</span></h2>'
      + table(['id', 'status', 'channel', 'thread', 'ticket', 'attempts', 'created'], outbox, 'no outbox rows') + '</section>'
      + '<section><h2>Lifecycle events<span class="count">' + snapshot.events.length + '</span></h2>'
      + table(['kind', 'payload'], events, 'no lifecycle events') + '</section>';
  };
  const content = document.getElementById('snapshot-content');
  const generated = document.getElementById('generated');
  const status = document.getElementById('live');
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => { if (status) status.textContent = 'live'; });
  source.addEventListener('error', () => { if (status) status.textContent = 'reconnecting'; });
  source.addEventListener('message', event => {
    try {
      const snapshot = JSON.parse(event.data);
      if (!content || !generated || !isUiSnapshot(snapshot)) return;
      const rendered = renderSnapshotContent(snapshot);
      content.innerHTML = rendered;
      generated.textContent = 'generated ' + snapshot.generatedAt;
    } catch {
      // Ignore malformed frames and retain the last good snapshot.
    }
  });
})();`
}

/** Server-rendered read-only page. All dynamic text is escaped. */
export function renderHtml(snapshot: UiSnapshot): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ds-agent local ui</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<header>
  <h1>ds-agent local ui</h1>
  <span class="sub" id="generated">generated ${escapeHtml(snapshot.generatedAt)}</span>
  <span class="sub">stream <span class="live" id="live">connecting</span></span>
</header>
<main id="snapshot-content">${renderSnapshotContent(snapshot)}</main>
<script>
${browserApplyScript()}
</script>
</body>
</html>
`
}
