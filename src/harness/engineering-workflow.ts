import type { SkillRegistry } from '../env/skills.ts'
import type { Store } from '../store/sqlite.ts'
import type { Ticket } from '../shared/types.ts'

// Prefer a task's shipping or PR lifecycle intent over lower-level mentions
// of the bug or code it contains.
const mergeDeclined = /\b(?:do not|don't|never|without|no)\s+(?:automatically\s+)?merg(?:e|ing)\b|(?:不要|别|禁止|不允许|暂不|不能).{0,6}合并/i
const otherEngineering = /\b(?:debug|test|inspect|update|change)\b[^.\n]{0,80}\b(?:code|codebase|repository|function|test suite|implementation)\b|(?:排查|修改|更新|测试|写测试|补测试).{0,24}(?:代码|函数|仓库|项目|模块|接口)/i

const playbooks: readonly [string, RegExp][] = [
  ['shipping', /\bmerge (?:the |this )?(?:pr|pull request|stack)\b|合并.{0,12}(?:\bPR\b|拉取请求|提交栈)/i],
  ['babysit', /\b(?:(?:watch|babysit|follow up on) (?:this |the )?(?:pr|pull request)|ci (?:failure|failed)|failing ci)\b|(?:跟进|处理).{0,12}\bPR\b|(?:处理|修复).{0,12}\bCI\b.{0,10}(?:失败|错误|红灯)/i],
  ['interrogate', /\b(?:review|check) (?:this |the )?(?:pr|pull request|diff)\b|(?:评审|审查|检查).{0,12}\bPR\b/i],
  ['hillclimb', /\bhillclimb\b|持续优化.{0,24}(?:性能|延迟|吞吐)/i],
  ['perf-issue', /\b(?:performance regression|slow query|high cpu|memory leak|profile the)\b|性能回退|优化性能|内存泄漏|响应缓慢/i],
  ['refactoring', /\brefactor\b|重构(?:代码|模块|接口|服务|项目|现有|这段)/i],
  ['bug-fix', /\b(?:fix|repair)\b[^.\n]{0,80}\b(?:bug|error|regression|timeout|crash|failing tests?)\b|(?:修复|修好).{0,36}(?:故障|错误|报错|超时|崩溃|缺陷|失败|bug)/i],
  ['feature', /\b(?:implement|add|build)\b[^.\n]{0,70}\b(?:feature|api|endpoint|cli|component|module|handler|integration)\b|(?:实现|新增|接入|添加|移植|迁移|替换).{0,32}(?:功能|接口|模块|组件|工作流|命令|测试|插件|代码)|(?:实现|移植|接入).{0,32}(?:ds-agent|仓库|项目)/i],
  ['investigation', /\b(?:reproduce|debug|diagnose|investigate)\b[^.\n]{0,80}\b(?:bug|error|regression|timeout|crash|failing tests?)\b|(?:排查|复现|查下|查一下).{0,36}(?:故障|错误|报错|超时|崩溃|缺陷|失败|bug)|\b(?:investigate|explain|trace)\b[^.\n]{0,80}\b(?:code|codebase|module|service|repository|implementation)\b|(?:解释|分析|梳理).{0,30}(?:源码|代码|实现|调用链)/i],
]

export function engineeringWorkflow(ticket: Ticket, skills: SkillRegistry, store: Pick<Store, 'getSpill' | 'spillGrants'>): string | undefined {
  if (ticket.speculative || ticket.conversation || ticket.mandate.strength !== 'explicit') return undefined
  const origin = ticket.inputs.find(input => input.kind === 'trigger' && input.triggerId === ticket.originTriggerId)
  if (!origin?.human || !origin.text) return undefined
  const spill = origin.spillId
  const authorizedSpill = spill && store.spillGrants(spill).includes(`ticket:${ticket.id}`)
  const request = (authorizedSpill ? store.getSpill(spill) : undefined) ?? origin.text
  if (!skills.list().some(skill => skill.bundled && skill.id === 'poteto-mode')) return undefined

  const selected = playbooks.find(([id, pattern]) =>
    pattern.test(request) && (id !== 'shipping' || !mergeDeclined.test(request)),
  )?.[0]
  const manual = /^\s*\/poteto-mode(?:\s|$)/.test(request)
  if (!selected && !manual && !otherEngineering.test(request)) return undefined

  const playbook = selected === 'interrogate' ? selected : selected ? 'pstack-playbook-' + selected : 'figure-it-out'
  const mode = skills.read('poteto-mode').body
  const steps = skills.read(playbook).body
  return [
    '# Active engineering workflow',
    `The runtime selected pstack and loaded ${playbook} before this turn. Follow the selected playbook in order and continue from prior ticket progress when resuming.`,
    'Existing ticket scope, tools, stop rules and approval gates take precedence. Only perform publication or merge steps when specifically authorized; otherwise stop at the verified local result. Missing tools or evidence are blockers to report. Keep the checklist in ticket progress and verify the result before reporting delivery.',
    mode,
    steps,
  ].join('\n\n')
}
