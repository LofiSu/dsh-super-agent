import { describe, expect, it } from 'vitest'
import { demoModel } from '../src/cli/demo.ts'
import { createModelFromEnv, HttpOpenAI, requireLiveModelFromEnv } from '../src/harness/model.ts'
import { PROVIDER_PRESETS, resolveLiveApi } from '../src/harness/providers.ts'

const PRESET_ROWS = [
  { key: 'DEEPSEEK_API_KEY', provider: 'deepseek', base: 'https://api.deepseek.com', model: 'deepseek-flash' },
  { key: 'OPENAI_API_KEY', provider: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { key: 'OPENROUTER_API_KEY', provider: 'openrouter', base: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
  { key: 'XAI_API_KEY', provider: 'xai', base: 'https://api.x.ai/v1', model: 'grok-4.7' },
  { key: 'GROK_API_KEY', provider: 'xai', base: 'https://api.x.ai/v1', model: 'grok-4.7' },
  { key: 'MOONSHOT_API_KEY', provider: 'moonshot', base: 'https://api.moonshot.cn/v1', model: 'kimi-k3.1-pro' },
  { key: 'KIMI_API_KEY', provider: 'moonshot', base: 'https://api.moonshot.cn/v1', model: 'kimi-k3.1-pro' },
  { key: 'ZHIPU_API_KEY', provider: 'zhipu', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' },
  { key: 'GLM_API_KEY', provider: 'zhipu', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' },
  { key: 'GEMINI_API_KEY', provider: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
  { key: 'GOOGLE_API_KEY', provider: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
  { key: 'ANTHROPIC_API_KEY', provider: 'anthropic', base: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5' },
] as const

describe('resolveLiveApi', () => {
  it('returns null when no provider is configured and does not read process.env', () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'from-process'
    try {
      expect(resolveLiveApi({})).toBeNull()
      expect(createModelFromEnv({}).name).toBe('MockModel')
      expect(() => demoModel({})).toThrow(/MockModel is forbidden|requires a live model/)
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })

  it('treats blank values as unset', () => {
    expect(resolveLiveApi({
      OPENAI_API_KEY: '   ',
      LOFIBOT_API_BASE: '',
      LOFIBOT_API_KEY: '\n',
      LOFIBOT_PROVIDER: '  ',
    })).toBeNull()
  })

  it('keeps the explicit base/key pair on HttpOpenAI with the deepseek-chat default', () => {
    const live = resolveLiveApi({
      LOFIBOT_API_BASE: 'http://127.0.0.1:9/v1',
      LOFIBOT_API_KEY: 'test-key',
      OPENAI_API_KEY: 'other',
      LOFIBOT_PROVIDER: 'openai',
    })
    expect(live).toEqual({
      provider: 'custom',
      base: 'http://127.0.0.1:9/v1',
      apiKey: 'test-key',
      model: 'deepseek-chat',
    })
    expect(createModelFromEnv({
      LOFIBOT_API_BASE: 'http://127.0.0.1:9/v1',
      LOFIBOT_API_KEY: 'test-key',
    })).toBeInstanceOf(HttpOpenAI)
    const required = requireLiveModelFromEnv({
      LOFIBOT_API_BASE: 'https://api.openai.com/v1',
      LOFIBOT_API_KEY: 'test-key',
    })
    expect(required.name).toBe('HttpOpenAI')
  })

  it('honors provider-specific base and model overrides', () => {
    expect(resolveLiveApi({
      OPENAI_API_KEY: 'k',
      OPENAI_BASE_URL: 'https://azure-proxy.example/v1',
      OPENAI_MODEL: 'gpt-proxy',
    })).toEqual({
      provider: 'openai',
      base: 'https://azure-proxy.example/v1',
      apiKey: 'k',
      model: 'gpt-proxy',
    })
    expect(resolveLiveApi({
      DEEPSEEK_API_KEY: 'k',
      DEEPSEEK_API_BASE: 'https://deepseek.internal/v1',
      DEEPSEEK_MODEL: 'deepseek-internal',
    })).toMatchObject({ base: 'https://deepseek.internal/v1', model: 'deepseek-internal' })
    // A LOFIBOT_PROVIDER preset keeps its overrides too.
    expect(resolveLiveApi({
      LOFIBOT_PROVIDER: 'openai',
      OPENAI_API_KEY: 'k',
      OPENAI_API_BASE: 'https://gateway.example/v1',
    })).toMatchObject({ provider: 'openai', base: 'https://gateway.example/v1' })
    // The generic model variables still outrank provider-specific ones.
    expect(resolveLiveApi({
      OPENAI_API_KEY: 'k',
      OPENAI_MODEL: 'provider-model',
      LOFIBOT_MODEL: 'generic-model',
    })?.model).toBe('generic-model')
    // ANTHROPIC_BASE_URL addresses the native Messages API; using it here would
    // drop the /v1 prefix and break /chat/completions. Only the OpenAI-compatible
    // override is honored.
    expect(resolveLiveApi({
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    })).toMatchObject({ provider: 'anthropic', base: 'https://api.anthropic.com/v1' })
    expect(resolveLiveApi({
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_API_BASE: 'https://anthropic-proxy.example/v1',
    })).toMatchObject({ base: 'https://anthropic-proxy.example/v1' })
  })

  it('prefers LOFIBOT_API_MODEL, then LOFIBOT_MODEL', () => {
    expect(resolveLiveApi({
      LOFIBOT_API_BASE: 'https://api.deepseek.com',
      LOFIBOT_API_KEY: 'k',
      LOFIBOT_API_MODEL: 'deepseek-v4-pro',
      LOFIBOT_MODEL: 'ignored',
    })?.model).toBe('deepseek-v4-pro')
    expect(resolveLiveApi({
      LOFIBOT_API_BASE: 'https://api.deepseek.com',
      LOFIBOT_API_KEY: 'k',
      LOFIBOT_MODEL: 'deepseek-chat',
    })?.model).toBe('deepseek-chat')
    expect(resolveLiveApi({
      MOONSHOT_API_KEY: 'k',
      LOFIBOT_API_MODEL: 'kimi-k3.1-pro-highspeed',
    })?.model).toBe('kimi-k3.1-pro-highspeed')
  })

  it('refuses MockModel when only one of base or key is set', () => {
    expect(() => resolveLiveApi({ LOFIBOT_API_KEY: 'k', OPENAI_API_KEY: 'other' }))
      .toThrow(/LOFIBOT_API_KEY is set but LOFIBOT_API_BASE is missing; refusing MockModel/)
    expect(() => resolveLiveApi({ LOFIBOT_API_BASE: 'https://api.deepseek.com' }))
      .toThrow(/LOFIBOT_API_BASE is set but LOFIBOT_API_KEY is missing; refusing MockModel/)
    expect(() => createModelFromEnv({ LOFIBOT_API_KEY: 'k' })).toThrow(/refusing MockModel/)
    expect(() => demoModel({ LOFIBOT_API_BASE: 'https://api.deepseek.com' })).toThrow(/refusing MockModel/)
  })

  it('maps each provider key to its OpenAI-compatible base without calling the network', () => {
    const original = globalThis.fetch
    globalThis.fetch = () => {
      throw new Error('network')
    }
    try {
      for (const row of PRESET_ROWS) {
        const live = resolveLiveApi({ [row.key]: '  test-key  ' })
        expect(live).toEqual({
          provider: row.provider,
          base: row.base,
          apiKey: 'test-key',
          model: row.model,
        })
        expect(createModelFromEnv({ [row.key]: 'test-key' }).name).toBe('HttpOpenAI')
        expect(requireLiveModelFromEnv({ [row.key]: 'test-key' })).toBeInstanceOf(HttpOpenAI)
        const selected = demoModel({ [row.key]: 'test-key' })
        expect(selected.provider).toBe(row.provider)
        expect(selected.model.name).toBe('HttpOpenAI')
      }
    } finally {
      globalThis.fetch = original
    }
  })

  it('uses the first key listed for a provider and the first preset in scan order', () => {
    expect(resolveLiveApi({
      MOONSHOT_API_KEY: 'moon',
      KIMI_API_KEY: 'kimi',
    })).toMatchObject({ provider: 'moonshot', apiKey: 'moon', base: 'https://api.moonshot.cn/v1' })
    expect(resolveLiveApi({
      ZHIPU_API_KEY: 'zhipu',
      GLM_API_KEY: 'glm',
    })).toMatchObject({ provider: 'zhipu', apiKey: 'zhipu', base: 'https://open.bigmodel.cn/api/paas/v4' })
    expect(resolveLiveApi({
      XAI_API_KEY: 'xai',
      GROK_API_KEY: 'grok',
    })).toMatchObject({ provider: 'xai', apiKey: 'xai' })
    expect(resolveLiveApi({
      DEEPSEEK_API_KEY: 'ds',
      OPENAI_API_KEY: 'oa',
      KIMI_API_KEY: 'kimi',
    })?.provider).toBe('deepseek')
    expect(resolveLiveApi({
      OPENAI_API_KEY: 'oa',
      KIMI_API_KEY: 'kimi',
    })?.provider).toBe('openai')
  })

  it('lets LOFIBOT_PROVIDER select a preset, including aliases', () => {
    expect(resolveLiveApi({
      LOFIBOT_PROVIDER: 'kimi',
      OPENAI_API_KEY: 'oa',
      KIMI_API_KEY: 'kimi-key',
    })).toMatchObject({
      provider: 'moonshot',
      base: 'https://api.moonshot.cn/v1',
      apiKey: 'kimi-key',
      model: 'kimi-k3.1-pro',
    })
    expect(resolveLiveApi({
      LOFIBOT_PROVIDER: 'Grok',
      GROK_API_KEY: 'grok-key',
      OPENAI_API_KEY: 'oa',
    })?.provider).toBe('xai')
    expect(resolveLiveApi({
      LOFIBOT_PROVIDER: 'glm',
      GLM_API_KEY: 'glm-key',
    })).toMatchObject({ provider: 'zhipu', base: 'https://open.bigmodel.cn/api/paas/v4' })
    expect(resolveLiveApi({ LOFIBOT_PROVIDER: 'google', GOOGLE_API_KEY: 'g' })?.provider).toBe('gemini')
    expect(resolveLiveApi({ LOFIBOT_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'a' })?.provider).toBe('anthropic')
  })

  it('uses the provider key before LOFIBOT_API_KEY when a preset is selected', () => {
    expect(resolveLiveApi({
      LOFIBOT_PROVIDER: 'moonshot',
      MOONSHOT_API_KEY: 'moon',
      LOFIBOT_API_KEY: 'generic',
    })?.apiKey).toBe('moon')
    expect(resolveLiveApi({
      LOFIBOT_PROVIDER: 'moonshot',
      LOFIBOT_API_KEY: 'generic',
    })).toMatchObject({
      provider: 'moonshot',
      base: 'https://api.moonshot.cn/v1',
      apiKey: 'generic',
    })
  })

  it('throws for an unknown provider, a provider with no key, and custom without a pair', () => {
    expect(() => resolveLiveApi({ LOFIBOT_PROVIDER: 'nope', OPENAI_API_KEY: 'k' })).toThrow(/Unknown LOFIBOT_PROVIDER/)
    expect(() => resolveLiveApi({ LOFIBOT_PROVIDER: 'zhipu' })).toThrow(/no API key/)
    expect(() => resolveLiveApi({ LOFIBOT_PROVIDER: 'custom' })).toThrow(/LOFIBOT_PROVIDER=custom/)
    expect(() => requireLiveModelFromEnv({})).toThrow(/No live model configured; refusing MockModel/)
  })

  it('lists the documented presets in priority order', () => {
    expect(PROVIDER_PRESETS.map(preset => preset.id)).toEqual([
      'deepseek',
      'openai',
      'openrouter',
      'xai',
      'moonshot',
      'zhipu',
      'gemini',
      'anthropic',
    ])
    expect(PROVIDER_PRESETS.every(preset => preset.base.startsWith('https://') && preset.defaultModel.length > 0)).toBe(true)
  })
})
