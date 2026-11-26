import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadDispatchOwnerConfigSync } from '../src/dispatch/config.ts'
import {
  acceptanceFromInstinctEvidenceColumn,
  classifyGapRisk,
  ingestCompetitiveGapFromFile,
  ingestGap,
  isImplementableLowRiskGap,
  runRsiSchedulerTick,
  RSI_RESEARCH_CACHE_KIND,
} from '../src/dispatch/rsi.ts'
import type { DispatchGapDoc, DispatchJobDoc } from '../src/dispatch/store.ts'
import { Store } from '../src/store/sqlite.ts'
import { trustedFetch } from '../src/dispatch/trusted-fetch.ts'
import { tempHome } from './fixtures.ts'

const REPO = 'LofiSu/deepseek-super-agent'

function dispatchConfig(home: string, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(home, 'github-dispatch.json'), JSON.stringify({
    github: { enabled: false, repo: REPO },
    rsi: { enabled: true, intervalMs: 0 },
    ...extra,
  }))
}

function docsDir(home: string): string {
  const dir = path.join(home, 'docs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe('trusted-fetch redirects', () => {
  it('follows allowlisted https redirect and returns body', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { Location: 'https://example.com/final' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const out = await trustedFetch('https://example.com/start', {
      allowHosts: ['example.com'],
      fetchImpl: fetchImpl as typeof fetch,
    })
    expect(out.body).toBe('ok')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('refuses redirect to private host', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response('', { status: 302, headers: { Location: 'https://127.0.0.1/x' } }),
    )
    await expect(trustedFetch('https://example.com/', {
      allowHosts: ['example.com', '127.0.0.1'],
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow(/private|allowlist/i)
  })

  it('refuses redirect to host outside allowlist', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response('', { status: 302, headers: { Location: 'https://evil.example/xx' } }),
    )
    await expect(trustedFetch('https://example.com/', {
      allowHosts: ['example.com'],
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow(/allowlist/i)
  })
})

describe('trusted-fetch SSRF', () => {
  const allow = ['example.com']
  const urls = [
    'http://127.0.0.1/',
    'https://127.0.0.1/',
    'https://127.0.0.2/',
    'https://0.0.0.0/',
    'https://localhost/',
    'https://10.0.0.1/',
    'https://169.254.169.254/',
    'file:///etc/passwd',
  ]
  for (const url of urls) {
    it(`refuses ${url}`, async () => {
      await expect(trustedFetch(url, { allowHosts: allow })).rejects.toThrow()
    })
  }

  it('refuses IPv4-mapped loopback host when allowlisted', async () => {
    await expect(trustedFetch('https://::ffff:127.0.0.1/', {
      allowHosts: ['::ffff:127.0.0.1'],
    })).rejects.toThrow()
  })

  it('refuses IPv4-mapped loopback hex when allowlisted', async () => {
    await expect(trustedFetch('https://[::ffff:7f00:1]/', {
      allowHosts: ['::ffff:7f00:1'],
    })).rejects.toThrow(/private|blocked/i)
  })

  it.each([
    ['172.16.0.1', '172.16.0.1'],
    ['192.168.1.1', '192.168.1.1'],
    ['169.254.169.254', '169.254.169.254'],
    ['IPv4-mapped 172.16.0.1', '[::ffff:ac10:1]'],
    ['IPv4-mapped 192.168.1.1', '[::ffff:c0a8:101]'],
    ['IPv4-mapped 169.254.169.254', '[::ffff:a9fe:a9fe]'],
  ])('refuses private IPv4 range %s when allowlisted', async (_name, host) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok'))
    await expect(trustedFetch(`https://${host}/`, { allowHosts: [host], fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow(/private|blocked/i)
  })

  it('refuses IPv6 link-local fe81::1 when allowlisted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok'))
    await expect(trustedFetch('https://[fe81::1]/', {
      allowHosts: ['fe81::1'],
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow(/private|blocked/i)
  })

  it('refuses 0.1.2.3 in 0.0.0.0/8 when allowlisted', async () => {
    await expect(trustedFetch('https://0.1.2.3/', { allowHosts: ['0.1.2.3'] }))
      .rejects.toThrow(/private|blocked/i)
  })

  it('refuses IPv6 unspecified when allowlisted', async () => {
    await expect(trustedFetch('https://[::]/', { allowHosts: ['::'] }))
      .rejects.toThrow(/private|blocked/i)
  })
})

describe('RSI gap pool', () => {
  it('extracts a backtick-wrapped test path while failing closed on unsafe evidence', () => {
    expect(acceptanceFromInstinctEvidenceColumn('`test/dispatch-rsi-ingest.test.ts`'))
      .toBe('Offline test file test/dispatch-rsi-ingest.test.ts passes in CI holdout.')
    expect(acceptanceFromInstinctEvidenceColumn('n/a')).toBe('')
    expect(acceptanceFromInstinctEvidenceColumn('No test path supplied')).toBe('')
    expect(acceptanceFromInstinctEvidenceColumn('不是验收标准；`test/dispatch-rsi-ingest.test.ts`')).toBe('')
  })

  it('ingests sourced gaps; high risk stays proposal and duplicate PR keeps tick idle', async () => {
    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    const gap = ingestGap(store, {
      title: 'Docs tweak',
      description: 'Add note',
      acceptance: 'Test passes',
      sourceUrl: 'https://docs.github.com/en',
      fetchedAt: '2026-11-15T00:00:00Z',
    }, prefix => store.nextId(prefix))!
    expect(gap.sourceUrl).toContain('docs.github.com')
    expect(gap.fetchedAt).toBe('2026-11-15T00:00:00Z')
    expect(gap.manusCue).toBe('unknown')

    const high = ingestGap(store, {
      title: 'Change sandbox network policy',
      description: 'widen network',
      acceptance: 'n/a',
      sourceUrl: 'https://docs.github.com/policy',
      fetchedAt: '2026-11-15T00:00:00Z',
      dedupeKey: 'high-1',
    }, prefix => store.nextId(prefix))!
    expect(classifyGapRisk(high.title, high.description)).toBe('high')
    expect(high.status).toBe('proposal')
    expect(store.listDocs<DispatchJobDoc>('dispatch_job').some(job => job.type === 'rsi_proposal')).toBe(true)

    cfg.rsi.intervalMs = 0
    const tick = await runRsiSchedulerTick(store, cfg, prefix => store.nextId(prefix), {
      fetchPage: async () => ({ body: 'ok', fetchedAt: '2026-11-15T12:00:00Z' }),
      hasOpenPeanutPr: async () => true,
      repoRoot: home,
    })
    expect(tick.idle).toBe(true)
    store.close()
  })

  it('keeps missing WhatsApp-like capability proposal-only', async () => {
    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    const dir = docsDir(home)
    fs.writeFileSync(path.join(dir, 'INSTINCT_CAPABILITIES.md'), [
      '| # | 能力项 | Instinct 公开证据 | 等级 | ds-agent 状态 | 本仓库路径 / 验收依据 |',
      '|---|---|---|---|---|---|',
      '| A2 | WhatsApp 入口 | evidence | teardown | `missing` | path notes |',
    ].join('\n'))
    const tick = await runRsiSchedulerTick(store, cfg, prefix => store.nextId(prefix), {
      fetchPage: async () => ({ body: 'ok', fetchedAt: '2026-11-15T12:00:00Z' }),
      repoRoot: home,
    })
    expect(tick.idle).toBe(true)
    expect(store.listDocs<DispatchJobDoc>('dispatch_job').filter(job => job.type === 'rsi_implement')).toHaveLength(0)
    expect(store.listDocs<DispatchGapDoc>('dispatch_gap').some(gap => gap.status === 'proposal')).toBe(true)
    store.close()
  })

  it('fails closed on disclaimer evidence', async () => {
    const evidence = '名称数量不是验收标准。本仓库 tool surface 是显式 tool list；不要用“577”当能力声明'
    expect(acceptanceFromInstinctEvidenceColumn(evidence)).toBe('')

    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    const dir = docsDir(home)
    fs.writeFileSync(path.join(dir, 'INSTINCT_CAPABILITIES.md'), [
      '| # | 能力项 | Instinct 公开证据 | 等级 | ds-agent 状态 | 本仓库路径 / 验收依据 |',
      '|---|---|---|---|---|---|',
      `| C2 | 工具/动作总量口径 | evidence | teardown | \`missing\` | ${evidence} |`,
    ].join('\n'))
    const tick = await runRsiSchedulerTick(store, cfg, prefix => store.nextId(prefix), {
      fetchPage: async () => ({ body: 'ok', fetchedAt: '2026-11-15T12:00:00Z' }),
      hasOpenPeanutPr: async () => false,
      repoRoot: home,
    })
    const gap = store.listDocs<DispatchGapDoc>('dispatch_gap').find(item => item.title.includes('工具/动作总量口径'))
    expect(tick.idle).toBe(true)
    expect(gap).toMatchObject({ acceptance: '', status: 'proposal' })
    expect(isImplementableLowRiskGap(gap!)).toBe(false)
    expect(store.listDocs<DispatchJobDoc>('dispatch_job').filter(job => job.type === 'rsi_implement')).toHaveLength(0)
    store.close()
  })

  it('ingests competitive Behind rows as sourced proposals only', async () => {
    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    const dir = docsDir(home)
    fs.writeFileSync(path.join(dir, 'COMPETITIVE_GAP.md'), [
      '| Dimension | Instinct / Open Instinct | Muse | Grok Bot | ds-agent now | Verdict |',
      '|---|---|---|---|---|---|',
      '| **Owner model** | tiers | single | one | single owner | **Behind** on tiers; ahead on ingress |',
    ].join('\n'))
    const gaps = ingestCompetitiveGapFromFile(store, home, prefix => store.nextId(prefix))
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ status: 'proposal', acceptance: '', manusCue: 'unknown' })
    expect(gaps[0]!.sourceUrl).toContain('COMPETITIVE_GAP.md')
    const tick = await runRsiSchedulerTick(store, cfg, prefix => store.nextId(prefix), {
      fetchPage: async () => ({ body: 'ok', fetchedAt: '2026-11-15T12:00:00Z' }),
      hasOpenPeanutPr: async () => false,
      repoRoot: home,
    })
    expect(tick.idle).toBe(true)
    expect(store.listDocs<DispatchJobDoc>('dispatch_job').filter(job => job.type === 'rsi_implement')).toHaveLength(0)
    store.close()
  })

  it('enqueues one implement job for an accepted low-risk gap', async () => {
    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    const gap = ingestGap(store, {
      title: 'Small helper export',
      description: 'Add typed export',
      acceptance: 'test/foo.test.ts passes in offline holdout.',
      sourceUrl: 'file://docs/x.md',
      fetchedAt: '2026-11-15T00:00:00Z',
      dedupeKey: 'low-1',
    }, prefix => store.nextId(prefix))!
    expect(gap.risk).toBe('low')
    const tick = await runRsiSchedulerTick(store, cfg, prefix => store.nextId(prefix), {
      fetchPage: async () => ({ body: 'ok', fetchedAt: '2026-11-15T12:00:00Z' }),
      hasOpenPeanutPr: async () => false,
      repoRoot: home,
    })
    expect(tick.idle).toBe(false)
    expect(store.listDocs<DispatchJobDoc>('dispatch_job').filter(job => job.type === 'rsi_implement')).toHaveLength(1)
    store.close()
  })

  it('caches homepage and sourceUrl fetches without implementing HTML', async () => {
    const home = tempHome()
    const store = new Store(home)
    const src = 'https://docs.github.com/en/actions'
    dispatchConfig(home, { rsi: { enabled: true, intervalMs: 0, sourceUrls: [src, 'https://docs.github.com/bad-path'] } })
    const cfg = loadDispatchOwnerConfigSync(home)!
    let call = 0
    const tick = await runRsiSchedulerTick(store, cfg, prefix => store.nextId(prefix), {
      fetchPage: async url => {
        call += 1
        if (url === src) return { body: 'actions-doc', fetchedAt: '2026-11-15T13:00:00Z' }
        if (url === 'https://docs.github.com/') return { body: '<html>homepage</html>', fetchedAt: '2026-11-15T12:00:00Z' }
        throw new Error('simulated 404')
      },
      repoRoot: home,
    })
    expect(tick.idle).toBe(true)
    expect(call).toBeGreaterThanOrEqual(3)
    expect(store.getDoc(RSI_RESEARCH_CACHE_KIND, 'host:docs.github.com')).toBeTruthy()
    expect(store.getDoc(RSI_RESEARCH_CACHE_KIND, `url:${src}`)).toMatchObject({ ok: true, body: 'actions-doc', url: src })
    expect(store.getDoc(RSI_RESEARCH_CACHE_KIND, 'url:https://docs.github.com/bad-path'))
      .toMatchObject({ ok: false, error: 'simulated 404' })
    expect(store.listDocs<DispatchJobDoc>('dispatch_job').filter(job => job.type === 'rsi_implement')).toHaveLength(0)
    store.close()
  })

  it('rehearses against the current worktree documents without inventing acceptance', async () => {
    const home = tempHome()
    const store = new Store(home)
    dispatchConfig(home)
    const cfg = loadDispatchOwnerConfigSync(home)!
    const tick = await runRsiSchedulerTick(store, cfg, prefix => store.nextId(prefix), {
      fetchPage: async () => ({ body: 'research only', fetchedAt: '2026-11-15T12:00:00Z' }),
      hasOpenPeanutPr: async () => false,
      repoRoot: process.cwd(),
    })
    const gaps = store.listDocs<DispatchGapDoc>('dispatch_gap')
    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps.every(gap => gap.manusCue === 'unknown')).toBe(true)
    expect(gaps.some(gap => gap.sourceUrl.includes('INSTINCT_CAPABILITIES.md'))).toBe(true)
    expect(gaps.some(gap => gap.sourceUrl.includes('COMPETITIVE_GAP.md'))).toBe(true)
    expect(store.listDocs<DispatchJobDoc>('dispatch_job').filter(job => job.type === 'rsi_implement')).toHaveLength(0)
    expect(tick.idle).toBe(true)
    store.close()
  })

  it('keeps implemented and dismissed structured gaps terminal on re-ingest', () => {
    const home = tempHome()
    const store = new Store(home)
    const dir = docsDir(home)
    const file = path.join(dir, 'COMPETITIVE_GAP.md')
    fs.writeFileSync(file, [
      '| Dimension | Instinct | Muse | Grok | ds-agent now | Verdict |',
      '|---|---|---|---|---|---|',
      '| **Memory** | x | x | x | current | **Partial** |',
    ].join('\n'))
    const [created] = ingestCompetitiveGapFromFile(store, home, prefix => store.nextId(prefix))
    for (const status of ['implemented', 'dismissed'] as const) {
      store.putDoc('dispatch_gap', created!.id, { ...created!, status })
      const [again] = ingestCompetitiveGapFromFile(store, home, prefix => store.nextId(prefix))
      expect(again?.status).toBe(status)
    }
    store.close()
  })
})
