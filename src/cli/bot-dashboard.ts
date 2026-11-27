import { escapeHtml } from '../ui/render.ts'
import { ticketStage } from '../core/stage.ts'
import type { TeamRecord } from '../harness/team.ts'
import type { Ticket } from '../shared/types.ts'
import { visibleTickets } from '../speculate/index.ts'
import { Store } from '../store/sqlite.ts'

export const dashboardUri = 'ui://dsh-super-bot/dashboard.html'

export function renderBotDashboard(home: string): string {
  let tasks = ''
  let teams = ''
  let status = 'Local workspace'
  try {
    const store = Store.openReadOnly(home)
    try {
      tasks = visibleTickets(store.listDocs<Ticket>('ticket')).map(ticket =>
        `<li><strong>${escapeHtml(ticket.title)}</strong><small>${escapeHtml(ticketStage(ticket))} · ${escapeHtml(ticket.id)}</small></li>`,
      ).join('')
      teams = store.listDocs<TeamRecord>('team').map(team =>
        `<article><h3>${escapeHtml(team.id)}</h3><small>${escapeHtml(team.ticketId)} · ${team.completedAt ? 'Completed' : 'Active'}</small>
        <ul>${team.members.map(member => `<li><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(member.role)} · ${escapeHtml(member.status)}</small></li>`).join('')}</ul></article>`,
      ).join('')
    } finally {
      store.close()
    }
  } catch {
    status = 'State unavailable. Check DS_AGENT_HOME and initialize the database.'
  }

  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-super-bot</title>
<style>
:root{color-scheme:light dark;--page:#f4f7f5;--card:#fff;--ink:#19342c;--muted:#49645a;--line:#d4e3db}
@media(prefers-color-scheme:dark){:root{--page:#10231d;--card:#19332a;--ink:#e6f4ec;--muted:#afc9bb;--line:#365248}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:1060px;margin:auto;padding:clamp(18px,5vw,48px)}h1{font-size:clamp(26px,5vw,42px);margin:0}p,small{color:var(--muted)}
header{margin-bottom:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;overflow-wrap:anywhere}h2{margin:0;font-size:18px}h3{margin:0;font-size:15px}
ul{list-style:none;padding:0;margin:8px 0 0}li,article{padding:10px 0;border-bottom:1px solid var(--line)}li:last-child,article:last-child{border-bottom:0}small{display:block}
</style>
<main><header><h1>dsh-super-bot</h1><p>${escapeHtml(status)}</p></header>
<div class="grid"><section><h2>Tasks</h2>${tasks ? `<ul>${tasks}</ul>` : '<p>No tasks in this snapshot.</p>'}</section>
<section><h2>Teams</h2>${teams || '<p>No teams in this snapshot.</p>'}</section></div></main></html>`
}
