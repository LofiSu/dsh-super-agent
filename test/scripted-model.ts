import { ruleClassify, type SemanticHit } from '../src/ingress/filter.ts'
import type { Completion, CompletionRequest, Model } from '../src/harness/model.ts'
import type { Trigger } from '../src/shared/types.ts'

/**
 * Deterministic model for control-plane tests. Unlike MockModel it is not a
 * product fixture; it exists so a test can assert a branch without asking a
 * live model to choose a tool. Admission still uses the real rule classifier.
 */
export class ScriptedModel implements Model {
  readonly name: string

  constructor(
    private readonly script: (request: CompletionRequest) => Completion | Promise<Completion>,
    name = 'ScriptedModel',
  ) {
    this.name = name
  }

  classify(trigger: Trigger): SemanticHit {
    return ruleClassify(trigger)
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    const result = await this.script(request)
    // Older control-plane fixtures test reporting, not workflow planning.
    const ready = result.toolCalls?.some(tool => tool.name === 'report_to_router'
      && (tool.args.kind === 'ready' || (tool.args.kind === undefined && tool.args.deliver === true)))
    if (!ready || !request.tools.some(tool => tool.name === 'pstack_checkpoint')
      || request.messages.some(message => message.name === 'pstack_checkpoint')) return result
    const checkpoints = ['plan', 'execute', 'verify'].map(phase => ({
      id: `fixture-pstack-${phase}`, name: 'pstack_checkpoint',
      args: { phase, playbook: 'pstack-playbook-investigation', evidence: 'Scripted control-plane fixture' },
    }))
    return { ...result, toolCalls: [...checkpoints, ...result.toolCalls!] }
  }
}

/** A model that never calls a tool. */
export function silentModel(text = 'scripted-done'): ScriptedModel {
  return new ScriptedModel(() => ({ text }))
}

/** Last user prompt in the transcript. */
export function lastPrompt(request: CompletionRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]
    if (message?.role === 'user') return message.content
  }
  return ''
}

export function field(prompt: string, key: string): string {
  return new RegExp(`^${key}=(.*)$`, 'm').exec(prompt)?.[1]?.trim() ?? ''
}
