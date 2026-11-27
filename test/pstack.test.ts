import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkillRegistry } from '../src/env/skills.ts'
import { buildSystemPrompt } from '../src/harness/prompts.ts'

describe('pstack runtime integration', () => {
  const skills = SkillRegistry.fromHome('/nonexistent-ds-agent-home')

  it('routes engineering requests and explicit invocations to pstack', () => {
    const prompt = buildSystemPrompt({ role: 'worker', skills: skills.list() })
    expect(prompt).toContain('/poteto-mode')
    expect(skills.read('poteto-mode').body).toContain('Autopilot')
  })

  it('loads upstream handbooks by bounded identifiers', () => {
    expect(skills.read('pstack-playbook-bug-fix').body).toContain('Reproduce')
    expect(skills.read('pstack:skills/statechart/references/render.md').body).toBeTruthy()
    expect(() => skills.read('pstack:skills/../../LICENSE')).toThrow('unknown skill')
  })
  it('keeps owner skills visible alongside the bundled workflow', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ds-pstack-skills-'))
    try {
      const dir = path.join(home, 'skills', 'zebra')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'SKILL.md'), '---\ndescription: Owner workflow\n---\nOwner steps')
      const registry = SkillRegistry.fromHome(home)
      expect(buildSystemPrompt({ role: 'worker', skills: registry.list() })).toContain('zebra: Owner workflow')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
