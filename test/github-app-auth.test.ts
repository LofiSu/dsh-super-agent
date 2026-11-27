import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs, { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  UNOWNED_PUBLIC_HANDLE,
  loadDispatchOwnerConfigSync,
} from '../src/dispatch/config.ts'
import {
  GithubAppAuthService,
  bootstrapDispatchGithubAuth,
  ghRunForDispatchHost,
  parseGithubAuthBlock,
  redactGithubAuthSecret,
  signGithubAppJwt,
  type GithubHttpFetch,
} from '../src/dispatch/github-app-auth.ts'
import { UserError } from '../src/shared/errors.ts'
import { tempHome } from './fixtures.ts'

const REPO = 'LofiSu/deepseek-super-agent'
const CLIENT_ID = 'Iv1.testclient'
const APP_ID = '5772121'
const INSTALL_ID = '182274751'
const SLUG = 'lofisu-peanut-agent'

/** PEM outside any tempHome cwd (repo / workspace policy). */
function fixturePem(mode: 0o600 | 0o644 = 0o600): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ds-agent-app-pem-'))
  const file = path.join(dir, 'app.pem')
  writeFileSync(file, pem, { mode: 0o600 })
  try {
    chmodSync(file, mode)
  } catch {
    // some FS ignore chmod in tests
  }
  return file
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  expect(parts.length).toBe(3)
  return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
}

function mockGithubFetch(opts: {
  appId?: string
  slug?: string
  installationId?: string
  token?: string
  expiresAt?: string
  failWithToken?: string
}): GithubHttpFetch {
  const token = opts.token ?? 'ghs_testfixturetoken000000000'
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 55 * 60 * 1000).toISOString()
  return vi.fn(async (urlPath: string, req) => {
    if (opts.failWithToken && urlPath === 'app') {
      throw new UserError(redactGithubAuthSecret(`GitHub API 401: ${opts.failWithToken}`))
    }
    if (urlPath === 'app') {
      return { id: Number(opts.appId ?? APP_ID), slug: opts.slug ?? SLUG }
    }
    if (urlPath.includes('/access_tokens')) {
      return { token, expires_at: expiresAt }
    }
    if (urlPath.includes('/installation')) {
      return { id: Number(opts.installationId ?? INSTALL_ID) }
    }
    void req
    throw new Error(`unexpected fetch ${urlPath}`)
  }) as GithubHttpFetch
}

function authBlock(extra: Record<string, unknown> = {}, pemFile: string) {
  return {
    mode: 'github-app',
    appId: APP_ID,
    clientId: CLIENT_ID,
    installationId: INSTALL_ID,
    privateKeyFile: pemFile,
    expectedSlug: SLUG,
    ...extra,
  }
}

describe('signGithubAppJwt', () => {
  it('uses RS256, iss=clientId, iat in past, exp within 10 minutes', () => {
    const pemFile = fixturePem()
    const pem = fs.readFileSync(pemFile, 'utf8')
    const now = 1_700_000_000
    const jwt = signGithubAppJwt(CLIENT_ID, pem, now)
    const header = JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString())
    expect(header.alg).toBe('RS256')
    const payload = decodeJwtPayload(jwt)
    expect(payload.iss).toBe(CLIENT_ID)
    expect(payload.iat).toBeLessThanOrEqual(now)
    expect(now - Number(payload.iat)).toBeLessThanOrEqual(60)
    expect(Number(payload.exp)).toBeLessThanOrEqual(now + 10 * 60)
    expect(Number(payload.exp)).toBeGreaterThan(now)
  })
})

describe('parseGithubAuthBlock', () => {
  it('coerces numeric appId and installationId', () => {
    const pem = fixturePem()
    const parsed = parseGithubAuthBlock(authBlock({ appId: 5772121, installationId: 182274751 }, pem), process.cwd())
    expect(parsed.mode).toBe('github-app')
    expect(parsed.githubApp?.appId).toBe('5772121')
    expect(parsed.githubApp?.installationId).toBe('182274751')
  })

  it('refuses world-readable PEM', () => {
    const pem = fixturePem(0o644)
    expect(() => parseGithubAuthBlock(authBlock({}, pem), process.cwd())).toThrow(/0600|0400/)
  })

  it('refuses PEM inside repo cwd', () => {
    const cwd = tempHome()
    const pem = path.join(cwd, 'leak.pem')
    writeFileSync(pem, 'x', { mode: 0o600 })
    try {
      expect(() => parseGithubAuthBlock(authBlock({}, pem), cwd)).toThrow(/outside the repository/)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refuses an external symlink to a PEM inside repo cwd', () => {
    const cwd = tempHome()
    const linkDir = mkdtempSync(path.join(os.tmpdir(), 'ds-agent-app-link-'))
    const pem = path.join(cwd, 'leak.pem')
    const link = path.join(linkDir, 'app.pem')
    writeFileSync(pem, 'x', { mode: 0o600 })
    fs.symlinkSync(pem, link)
    try {
      expect(() => parseGithubAuthBlock(authBlock({}, link), cwd)).toThrow(/outside the repository/)
    } finally {
      fs.rmSync(linkDir, { recursive: true, force: true })
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.skipIf(!(() => {
    try {
      fs.accessSync('/workspace', fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  })())('refuses an external symlink to a PEM under /workspace', () => {
    const targetDir = mkdtempSync(path.join('/workspace', 'ds-agent-app-key-'))
    const linkDir = mkdtempSync(path.join(os.tmpdir(), 'ds-agent-app-link-'))
    const pem = path.join(targetDir, 'app.pem')
    const link = path.join(linkDir, 'app.pem')
    writeFileSync(pem, 'x', { mode: 0o600 })
    fs.symlinkSync(pem, link)
    try {
      expect(() => parseGithubAuthBlock(authBlock({}, link), os.tmpdir())).toThrow(/outside workspace roots/)
    } finally {
      fs.rmSync(linkDir, { recursive: true, force: true })
      fs.rmSync(targetDir, { recursive: true, force: true })
    }
  })

  it('accepts an external symlink only by storing its canonical target', () => {
    const targetDir = mkdtempSync(path.join(os.tmpdir(), 'ds-agent-app-target-'))
    const linkDir = mkdtempSync(path.join(os.tmpdir(), 'ds-agent-app-link-'))
    const pem = path.join(targetDir, 'app.pem')
    const link = path.join(linkDir, 'app.pem')
    writeFileSync(pem, 'x', { mode: 0o600 })
    fs.symlinkSync(pem, link)
    const cwd = tempHome()
    try {
      const parsed = parseGithubAuthBlock(authBlock({}, link), cwd)
      expect(parsed.githubApp?.privateKeyFile).toBe(fs.realpathSync(pem))
      expect(parsed.githubApp?.privateKeyFile).not.toBe(link)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(linkDir, { recursive: true, force: true })
      fs.rmSync(targetDir, { recursive: true, force: true })
    }
  })

  it('refuses missing github-app fields', () => {
    const pem = fixturePem()
    expect(() => parseGithubAuthBlock({ mode: 'github-app', privateKeyFile: pem }, process.cwd())).toThrow(/required/)
  })
})

describe('GithubAppAuthService verification', () => {
  it('refuses app id, installation, and slug mismatches', async () => {
    const pem = fixturePem()
    const cfg = parseGithubAuthBlock(authBlock({}, pem), process.cwd()).githubApp!
    const badApp = new GithubAppAuthService(cfg, REPO, mockGithubFetch({ appId: '1' }))
    await expect(badApp.verifyFailClosed()).rejects.toThrow(/appId/)
    const badSlug = new GithubAppAuthService(cfg, REPO, mockGithubFetch({ slug: 'other-slug' }))
    await expect(badSlug.verifyFailClosed()).rejects.toThrow(/expectedSlug/)
    const badInst = new GithubAppAuthService(cfg, REPO, mockGithubFetch({ installationId: '9' }))
    await expect(badInst.verifyFailClosed()).rejects.toThrow(/installationId/)
  })

  it('caches installation token and refreshes after expiry skew', async () => {
    const pem = fixturePem()
    const cfg = parseGithubAuthBlock(authBlock({}, pem), process.cwd()).githubApp!
    let mints = 0
    const fetchJson = vi.fn(async (urlPath: string) => {
      if (urlPath === 'app') return { id: Number(APP_ID), slug: SLUG }
      if (urlPath.includes('/access_tokens')) {
        mints += 1
        const ttlMs = mints === 1 ? 55 * 60 * 1000 : 55 * 60 * 1000
        const soon = new Date(Date.now() + ttlMs).toISOString()
        return { token: `ghs_round${mints}`, expires_at: soon }
      }
      if (urlPath.includes('/installation')) return { id: Number(INSTALL_ID) }
      throw new Error(urlPath)
    }) as GithubHttpFetch
    const svc = new GithubAppAuthService(cfg, REPO, fetchJson)
    vi.useFakeTimers()
    const base = new Date('2026-06-01T12:00:00.000Z')
    vi.setSystemTime(base)
    try {
      const t1 = await svc.getInstallationToken()
      const t2 = await svc.getInstallationToken()
      expect(t1).toBe(t2)
      expect(mints).toBe(1)
      vi.setSystemTime(new Date(base.getTime() + 56 * 60 * 1000))
      const t3 = await svc.getInstallationToken()
      expect(t3).not.toBe(t1)
      expect(mints).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('GithubAppAuthService gh child environment', () => {
  it('pins github.com and removes inherited enterprise credentials', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ds-agent-app-gh-env-'))
    const envKeys = ['PATH', 'GH_HOST', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const
    const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
    try {
      const binDir = path.join(tempDir, 'bin')
      fs.mkdirSync(binDir)
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const pemFile = path.join(tempDir, 'app.pem')
      writeFileSync(pemFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
      const ghStub = path.join(binDir, 'gh')
      writeFileSync(
        ghStub,
        '#!/bin/sh\ncat >/dev/null\nprintf "%s\\n" "${GH_HOST-unset}" "${GH_TOKEN-unset}" "${GITHUB_TOKEN-unset}" "${GH_ENTERPRISE_TOKEN-unset}" "${GITHUB_ENTERPRISE_TOKEN-unset}"\n',
        { mode: 0o700 },
      )

      process.env.PATH = `${binDir}${path.delimiter}${oldEnv.PATH ?? ''}`
      process.env.GH_HOST = 'ghe.example.invalid'
      process.env.GITHUB_TOKEN = 'github_user_token_fixture'
      process.env.GH_ENTERPRISE_TOKEN = 'ghe_enterprise_secret_fixture'
      process.env.GITHUB_ENTERPRISE_TOKEN = 'ghe_enterprise_secret_fixture2'

      const cfg = parseGithubAuthBlock(authBlock({}, pemFile), process.cwd()).githubApp!
      const service = new GithubAppAuthService(cfg, REPO, mockGithubFetch({
        token: 'ghs_installation_token_fixture',
      }))
      const output = await service.createGhRun()([
        'api', '--method', 'GET', `repos/${REPO}/issues`,
      ])
      const [ghHost, ghToken, githubToken, ghEnterpriseToken, githubEnterpriseToken] = output.trim().split('\n')

      expect(ghHost).toBe('github.com')
      expect(ghToken).toBe('ghs_installation_token_fixture')
      expect(githubToken).toBe('unset')
      expect(ghEnterpriseToken).toBe('unset')
      expect(githubEnterpriseToken).toBe('unset')
    } finally {
      for (const key of envKeys) {
        const value = oldEnv[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('GithubAppAuthService git child environment', () => {
  it('uses the installation token only in the github.com extraheader and removes inherited credentials', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ds-agent-app-git-env-'))
    const envKeys = [
      'PATH',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'GH_ENTERPRISE_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      'GIT_CONFIG_GLOBAL',
    ] as const
    const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
    try {
      const binDir = path.join(tempDir, 'bin')
      fs.mkdirSync(binDir)
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const pemFile = path.join(tempDir, 'app.pem')
      writeFileSync(pemFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
      const gitStub = path.join(binDir, 'git')
      writeFileSync(
        gitStub,
        '#!/bin/sh\nprintf "%s\\n" "${PATH-unset}" "${GIT_CONFIG_KEY_0-unset}" "${GIT_CONFIG_VALUE_0-unset}" "${GITHUB_TOKEN-unset}" "${GH_TOKEN-unset}" "${GH_ENTERPRISE_TOKEN-unset}" "${GITHUB_ENTERPRISE_TOKEN-unset}" "${GIT_CONFIG_GLOBAL-unset}"\n',
        { mode: 0o700 },
      )

      process.env.PATH = `${binDir}${path.delimiter}${oldEnv.PATH ?? ''}`
      process.env.GITHUB_TOKEN = 'github_user_token_fixture'
      process.env.GH_TOKEN = 'gh_user_token_fixture'
      process.env.GH_ENTERPRISE_TOKEN = 'ghe_enterprise_secret_fixture'
      process.env.GITHUB_ENTERPRISE_TOKEN = 'ghe_enterprise_secret_fixture2'

      const cfg = parseGithubAuthBlock(authBlock({}, pemFile), process.cwd()).githubApp!
      const service = new GithubAppAuthService(cfg, REPO, mockGithubFetch({
        token: 'ghs_installation_token_fixture',
      }))
      const result = await service.createAuthenticatedGitRun()(
        ['ls-remote', `https://github.com/${REPO}.git`],
        { cwd: process.cwd() },
      )
      const [childPath, gitConfigKey, gitConfigValue, githubToken, ghToken, ghEnterpriseToken, githubEnterpriseToken, gitConfigGlobal] = result.stdout.trim().split('\n')

      expect(result.code).toBe(0)
      expect(childPath).toContain(binDir)
      expect(gitConfigKey).toBe('http.https://github.com/.extraheader')
      expect(gitConfigValue).toBe('Authorization: Bearer ghs_installation_token_fixture')
      expect(githubToken).toBe('unset')
      expect(ghToken).toBe('unset')
      expect(ghEnterpriseToken).toBe('unset')
      expect(githubEnterpriseToken).toBe('unset')
      expect(gitConfigGlobal).toBe('/dev/null')
    } finally {
      for (const key of envKeys) {
        const value = oldEnv[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('ignores HOME and inherited global Git config while retaining the installation extraheader', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ds-agent-app-git-global-config-'))
    const envKeys = ['PATH', 'HOME', 'GIT_CONFIG_GLOBAL'] as const
    const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
    try {
      const homeDir = path.join(tempDir, 'home')
      fs.mkdirSync(homeDir)
      const homeConfig = path.join(homeDir, '.gitconfig')
      const inheritedConfig = path.join(tempDir, 'inherited.gitconfig')
      writeFileSync(homeConfig, [
        '[user]',
        '\trsiProbe = rsi_home_gitconfig_probe_20261127',
        '[credential]',
        '\thelper = evil-home-helper-fixture',
        '[http "https://github.com/"]',
        '\textraheader = Authorization: Bearer user_global_gitconfig_token_fixture',
        '[url "https://evil.example.invalid/"]',
        '\tinsteadOf = https://github.com/',
        '',
      ].join('\n'))
      writeFileSync(inheritedConfig, '[user]\n\trsiInheritedProbe = rsi_inherited_gitconfig_probe_20261127\n')
      process.env.HOME = homeDir
      delete process.env.GIT_CONFIG_GLOBAL

      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const pemFile = path.join(tempDir, 'app.pem')
      writeFileSync(pemFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
      const cfg = parseGithubAuthBlock(authBlock({}, pemFile), process.cwd()).githubApp!
      const service = new GithubAppAuthService(cfg, REPO, mockGithubFetch({
        token: 'ghs_installation_token_fixture',
      }))
      const runConfigList = async () => (await service.createAuthenticatedGitRun()(
        ['config', '--list', '--show-origin', '--show-scope'],
        { cwd: process.cwd() },
      )).stdout

      const homeConfigOutput = await runConfigList()
      expect(homeConfigOutput).toContain('Authorization: Bearer ghs_installation_token_fixture')
      expect(homeConfigOutput).not.toContain('rsi_home_gitconfig_probe_20261127')
      expect(homeConfigOutput).not.toContain('evil-home-helper-fixture')
      expect(homeConfigOutput).not.toContain('user_global_gitconfig_token_fixture')
      expect(homeConfigOutput).not.toContain('evil.example.invalid')

      process.env.GIT_CONFIG_GLOBAL = inheritedConfig
      const inheritedConfigOutput = await runConfigList()
      expect(inheritedConfigOutput).toContain('Authorization: Bearer ghs_installation_token_fixture')
      expect(inheritedConfigOutput).not.toContain('rsi_inherited_gitconfig_probe_20261127')
      expect(inheritedConfigOutput).not.toContain('rsi_home_gitconfig_probe_20261127')
    } finally {
      for (const key of envKeys) {
        const value = oldEnv[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('blocks repository-local hooks and fsmonitor while retaining installation authentication', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'ds-agent-app-git-local-config-'))
    const envKeys = ['PATH', 'HOME', 'GIT_CONFIG_GLOBAL'] as const
    const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
    try {
      const repoDir = path.join(tempDir, 'repo')
      const homeDir = path.join(tempDir, 'home')
      fs.mkdirSync(repoDir)
      fs.mkdirSync(homeDir)
      process.env.HOME = homeDir
      delete process.env.GIT_CONFIG_GLOBAL

      const cleanGitEnv = {
        ...process.env,
        HOME: homeDir,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      }
      execFileSync('git', ['init', repoDir], { env: cleanGitEnv, stdio: 'ignore' })
      const git = (args: string[]) => execFileSync('git', ['-C', repoDir, ...args], {
        env: cleanGitEnv,
        stdio: 'ignore',
      })
      git(['config', 'user.name', 'Local Hook Probe'])
      git(['config', 'user.email', 'local-hook-probe@example.invalid'])
      git(['config', 'user.rsiLocalProbe', 'rsi_local_gitconfig_probe_20261127_1719'])
      git(['config', '--add', 'http.https://github.com/.extraheader', 'Authorization: Bearer user_local_gitconfig_token_fixture'])
      git(['config', '--add', 'url.https://evil.example.invalid/.insteadOf', 'https://github.com/'])

      const fsmonitorMarker = path.join(tempDir, 'fsmonitor-fired')
      const hookMarker = path.join(tempDir, 'pre-commit-fired')
      const fsmonitor = path.join(tempDir, 'fsmonitor.sh')
      writeFileSync(fsmonitor, `#!/bin/sh\nprintf fired > '${fsmonitorMarker}'\nprintf 'token\\n'\n`, { mode: 0o700 })
      git(['config', 'core.fsmonitor', fsmonitor])
      const hooksDir = path.join(repoDir, '.git', 'hooks')
      fs.mkdirSync(hooksDir, { recursive: true })
      writeFileSync(
        path.join(hooksDir, 'pre-commit'),
        `#!/bin/sh\nprintf fired > '${hookMarker}'\n`,
        { mode: 0o700 },
      )

      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const pemFile = path.join(tempDir, 'app.pem')
      writeFileSync(pemFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
      const cfg = parseGithubAuthBlock(authBlock({}, pemFile), repoDir).githubApp!
      const service = new GithubAppAuthService(cfg, REPO, mockGithubFetch({
        token: 'ghs_installation_token_fixture',
      }))
      const runGit = service.createAuthenticatedGitRun()
      const run = (args: string[]) => runGit(args, { cwd: repoDir })

      const status = await run(['status', '--porcelain'])
      expect(status.code).toBe(0)
      expect(fs.existsSync(fsmonitorMarker)).toBe(false)

      const configOutput = await run(['config', '--list', '--show-origin', '--show-scope'])
      expect(configOutput.code).toBe(0)
      expect(configOutput.stdout).toContain('command\tcommand line:\tcore.hookspath=/dev/null')
      expect(configOutput.stdout).toContain('command\tcommand line:\tcore.fsmonitor=false')
      expect(configOutput.stdout).toContain('command\tcommand line:\tuploadpack.packobjectshook=')
      expect(configOutput.stdout).toContain('command\tcommand line:\tcredential.helper=')
      expect(configOutput.stdout).toContain('Authorization: Bearer ghs_installation_token_fixture')
      expect(configOutput.stdout).toContain('user_local_gitconfig_token_fixture')
      expect(configOutput.stdout).toContain('evil.example.invalid')

      const commit = await run(['commit', '--allow-empty', '-m', 'local hook isolation probe'])
      expect(commit.code).toBe(0)
      expect(fs.existsSync(hookMarker)).toBe(false)
      expect(fs.existsSync(fsmonitorMarker)).toBe(false)
    } finally {
      for (const key of envKeys) {
        const value = oldEnv[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('ghRunForDispatchHost', () => {
  it('does not fall back to owner gh when github-app mode lacks app service', async () => {
    await expect(ghRunForDispatchHost({ auth: { mode: 'github-app' } })).rejects.toThrow(/verified App auth/)
  })
})

describe('mentionHandles in github-app mode', () => {
  it('accepts verified slug and [bot] only via sync load', () => {
    const home = tempHome()
    const pem = fixturePem()
    fs.writeFileSync(path.join(home, 'github-dispatch.json'), JSON.stringify({
      github: {
        enabled: true,
        repo: REPO,
        mentionHandles: [SLUG, `${SLUG}[bot]`],
        auth: authBlock({}, pem),
      },
    }))
    const cfg = loadDispatchOwnerConfigSync(home)!
    expect(cfg.github.mentionHandles).toEqual([SLUG, `${SLUG}[bot]`])
    expect(() => loadDispatchOwnerConfigSync(home)).not.toThrow()
  })

  it('refuses arbitrary slug and ds-agent', () => {
    const home = tempHome()
    const pem = fixturePem()
    const write = (handles: string[]) => {
      fs.writeFileSync(path.join(home, 'github-dispatch.json'), JSON.stringify({
        github: { enabled: true, repo: REPO, mentionHandles: handles, auth: authBlock({}, pem) },
      }))
    }
    write(['evil-bot'])
    expect(() => loadDispatchOwnerConfigSync(home)).toThrow(/verified App slug/)
    write([UNOWNED_PUBLIC_HANDLE])
    expect(() => loadDispatchOwnerConfigSync(home)).toThrow(/unrelated public account/)
  })

  it('mentionHandlesForConfig does not require gh api user', () => {
    const pem = fixturePem()
    const cfg = parseGithubAuthBlock(authBlock({}, pem), process.cwd()).githubApp!
    const svc = new GithubAppAuthService(cfg, REPO, mockGithubFetch({}))
    expect(svc.mentionHandlesForConfig()).toEqual([SLUG, `${SLUG}[bot]`])
  })
})

describe('redactGithubAuthSecret', () => {
  it('strips tokens and PEM material from errors', () => {
    const fake = 'ghs_leakedtok_AAAA and Bearer ghs_xxx and BEGIN RSA PRIVATE KEY\nMII\nEND RSA PRIVATE KEY'
    const out = redactGithubAuthSecret(fake)
    expect(out).not.toMatch(/ghs_leakedtok/)
    expect(out).not.toMatch(/BEGIN RSA/)
    expect(out).toContain('[REDACTED]')
  })

  it('redacts JWT-shaped installation tokens and PKCS#8 PEM blocks', () => {
    const dotted = 'ghs_eyJhbGciOiJSUzI1NiJ9.eyJzaXRlIjoiaW5zdGFsbGF0aW9uIn0.signature_part'
    const hyphenated = 'ghs_abc-def.ghi-jkl.mno-pqr'
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----'
    const out = redactGithubAuthSecret(`${dotted} ${hyphenated} ${pem}`)
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiJ9')
    expect(out).not.toContain('signature_part')
    expect(out).not.toContain('abc-def')
    expect(out).not.toContain('ghi-jkl')
    expect(out).not.toContain('MIIEvQIB')
    expect(out).not.toContain('BEGIN PRIVATE KEY')
    expect(out).not.toContain('END PRIVATE KEY')
    expect(out).not.toContain('-----')
    expect(out.match(/ghs_\[REDACTED\]/g)).toHaveLength(2)
    expect(out).toContain('[PEM REDACTED]')
  })

  it('redacts PEM before truncating an API error diagnostic', async () => {
    const pemBody = `-----BEGIN PRIVATE KEY-----\n${'MIIEvQIBADANBgkqhkiG9w0B'.repeat(20)}\n-----END PRIVATE KEY-----`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(pemBody, { status: 401 })))
    try {
      await bootstrapDispatchGithubAuth(authBlock({}, fixturePem()), REPO, process.cwd())
      expect.fail('expected bootstrap to throw')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).not.toContain('MIIEvQIB')
      expect(msg).not.toContain('BEGIN PRIVATE KEY')
      expect(msg).toContain('[PEM REDACTED]')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('redacts through bootstrap failure path', async () => {
    const pem = fixturePem()
    const failWith = 'ghs_supersecret_in_error_body'
    try {
      await bootstrapDispatchGithubAuth(
        authBlock({}, pem),
        REPO,
        process.cwd(),
        mockGithubFetch({ failWithToken: failWith }),
      )
      expect.fail('expected bootstrap to throw')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).not.toContain('ghs_supersecret')
      expect(msg).toMatch(/401|GitHub API/)
    }
  })
})
