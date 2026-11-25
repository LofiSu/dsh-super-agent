import { platform } from 'node:os'
import path from 'node:path'
import { dirname } from 'node:path'
import fs, { existsSync, lstatSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { UserError } from '../shared/errors.ts'

export interface SandboxPolicy {
  /** Explicit `false` is a test/embedding opt-out. Production defaults to sandboxed. */
  enabled: boolean
  allowNetwork?: boolean
  /** Worker workspace. Without this the sandboxed shell cannot write where it runs. */
  writableRoots?: readonly string[]
  /**
   * Opt-in strict read confinement. When false or omitted the sandbox keeps
   * today's host-wide read access; it never changes the write/network rules.
   */
  readIsolation?: boolean
  /** Extra host paths exposed read-only in strict mode (absolute paths). */
  readRoots?: readonly string[]
  /**
   * Linux non-strict mode: overlay these paths with tmpfs after `--ro-bind / /`
   * so host credentials are not readable at their absolute paths.
   */
  hidePaths?: readonly string[]
  /** Linux bwrap: separate PID namespace when the wrapper supports it. */
  unsharePid?: boolean
}

export interface SandboxSystem {
  platform: NodeJS.Platform
  available: (bin: string) => boolean
  /** Existence probe for optional Linux binds. Injected in tests. */
  exists?: (path: string) => boolean
  /** Node executable whose directory must stay readable in strict mode. */
  execPath?: string
}

/**
 * Read-only Darwin paths for strict mode. Deliberately excludes `/` and the
 * user's whole home: a writable root inside home is allowed individually below.
 */
const DARWIN_READ_PATHS = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/Library',
  '/private/etc',
  // `/etc` is a symlink to `/private/etc`; path resolution through the link
  // needs its own rule or `cat /etc/hosts` is denied.
  '/etc',
  '/private/var/db/dyld',
  '/dev',
] as const

/** System/toolchain roots bound read-only for bash and Node in strict Linux mode. */
const LINUX_READ_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/private/etc'] as const

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Strict mode refuses roots that would re-expose the whole host or nothing. */
function assertStrictRoot(root: string, kind: string): void {
  const value = root.trim()
  if (value === '' || value === '/') {
    throw new UserError(`strict read isolation refuses ${kind} "${root}"`)
  }
}

function strictReadRoots(policy: SandboxPolicy): readonly string[] {
  for (const root of policy.writableRoots ?? []) assertStrictRoot(root, 'writable root')
  for (const root of policy.readRoots ?? []) assertStrictRoot(root, 'read root')
  return policy.readRoots ?? []
}

/**
 * Canonicalize a path that is expected to exist. Roots that do not exist keep
 * their lexical form, matching the runtime's "fall back to lexical" rule.
 */
function canonicalRoot(root: string): string {
  try { return fs.realpathSync(root) } catch { return path.resolve(root) }
}

/**
 * Canonicalize a candidate that may not exist yet (e.g. a vault file): resolve
 * its nearest existing parent and re-append the missing suffix so a canonical
 * root still covers it.
 */
function canonicalCandidate(candidate: string): string {
  const absolute = path.resolve(candidate)
  try { return fs.realpathSync(absolute) } catch { /* resolve the parent below */ }
  let parent = path.dirname(absolute)
  const suffix: string[] = [path.basename(absolute)]
  while (true) {
    try {
      const canonicalParent = fs.realpathSync(parent)
      return path.join(canonicalParent, ...suffix.reverse())
    } catch {
      const next = path.dirname(parent)
      if (next === parent) return absolute
      suffix.push(path.basename(parent))
      parent = next
    }
  }
}

/** True when `target` is inside `root`, comparing lexical and canonical forms. */
function containsPath(root: string, target: string): boolean {
  const within = (base: string): boolean => {
    const relative = path.relative(path.resolve(base), target)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }
  if (within(root)) return true
  const canonical = canonicalRoot(root)
  // A root whose canonical form is the filesystem root would match everything,
  // re-creating the whole-host exposure strict mode is meant to prevent. Keep
  // only the lexical check for such aliases.
  if (path.resolve(canonical) === path.parse(canonical).root) return false
  return within(canonical)
}

/** True when a path falls under a root intentionally exposed by strict mode. */
export function strictReadIsolationIncludesPath(
  candidate: string,
  policy: SandboxPolicy,
  system: SandboxSystem = {
    platform: platform(),
    available: () => false,
    exists: existsSync,
  },
): boolean {
  const roots = system.platform === 'linux'
    ? [
      ...LINUX_READ_PATHS.filter(root => (system.exists ?? existsSync)(root)),
      ...(policy.writableRoots ?? []),
      ...strictReadRoots(policy),
    ]
    : system.platform === 'darwin'
      ? darwinReadPaths(policy, system.execPath ?? process.execPath)
      : []
  const target = path.resolve(candidate)
  const canonicalTarget = canonicalCandidate(candidate)
  return roots.some(root => containsPath(root, target) || containsPath(root, canonicalTarget))
}

function darwinReadPaths(policy: SandboxPolicy, execPath: string): string[] {
  return [
    ...new Set([
      ...DARWIN_READ_PATHS,
      // Node itself may live outside the system paths (e.g. a version manager).
      dirname(execPath),
      ...(policy.writableRoots ?? []),
      ...strictReadRoots(policy),
    ]),
  ]
}

function darwinProfile(policy: SandboxPolicy, execPath: string): string {
  const writes = policy.readIsolation
    ? [...(policy.writableRoots ?? [])]
    : ['/private/tmp', '/tmp', '/var/folders', '/private/var/folders', ...(policy.writableRoots ?? [])]
  // Host credentials must be unreadable in BOTH modes. macOS matches SBPL
  // filters against canonical paths, so normalize symlinked prefixes such as
  // /tmp -> /private/tmp. Directories use `subpath` (hides current and future
  // contents); files use `literal`. Place the denies after the allow rules so
  // the more specific filter wins (SBPL prefers the most specific match).
  const hideDenies = (policy.hidePaths ?? []).map(p => {
    let canonical = p
    let isDir = false
    try {
      canonical = realpathSync(p)
      isDir = lstatSync(canonical).isDirectory()
    } catch {
      try {
        isDir = lstatSync(p).isDirectory()
      } catch {
        // Absent candidate: a literal deny still hides it if created later.
      }
    }
    const kind = isDir ? 'subpath' : 'literal'
    return `(deny file-read* (${kind} ${sbplString(canonical)}))`
  })
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
  ]
  if (policy.readIsolation) {
    // Path resolution starts at the filesystem root; without this literal rule
    // macOS aborts even `/bin/echo` under the strict subpath allowlist.
    lines.push('(allow file-read* (literal "/"))')
    for (const dir of darwinReadPaths(policy, execPath)) {
      lines.push(`(allow file-read* (subpath ${sbplString(dir)}))`)
    }
  } else {
    // Compatibility default: today's sandbox allows all host reads.
    lines.push('(allow file-read*)')
  }
  lines.push(...hideDenies)
  for (const dir of new Set(writes)) lines.push(`(allow file-write* (subpath ${sbplString(dir)}))`)
  lines.push('(allow file-write* (literal "/dev/null"))')
  lines.push(policy.allowNetwork ? '(allow network*)' : '(deny network*)')
  return `${lines.join('\n')}\n`
}

/** Directory: `--tmpfs`; file: hide with `--ro-bind /dev/null`. */
export function bwrapHidePathArgs(
  hidePaths: readonly string[],
  exists: (path: string) => boolean,
  lstatIsDirectory: (path: string) => boolean,
): string[] {
  const out: string[] = []
  for (const p of hidePaths) {
    if (!exists(p)) continue
    if (lstatIsDirectory(p)) {
      out.push('--tmpfs', p)
    } else {
      out.push('--ro-bind', '/dev/null', p)
    }
  }
  return out
}

function linuxStrictArgv(policy: SandboxPolicy, exists: (path: string) => boolean): string[] {
  strictReadRoots(policy)
  const writable = (policy.writableRoots ?? []).flatMap(root => ['--bind', root, root])
  const reads = [
    ...LINUX_READ_PATHS
      .filter(path => exists(path))
      .flatMap(path => ['--ro-bind', path, path]),
    ...(policy.readRoots ?? []).flatMap(path => ['--ro-bind', path, path]),
  ]
  return [
    'bwrap',
    // Isolate PIDs as well as the filesystem: with --proc /proc but a shared
    // PID namespace, a same-user sandboxed process can enter /proc/<host-pid>/root
    // and read host paths outside the bind list (including the fill vault).
    '--unshare-pid',
    ...(policy.allowNetwork ? [] : ['--unshare-net']),
    ...(policy.unsharePid === true ? ['--unshare-pid'] : []),
    ...reads,
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    ...writable,
    '--',
  ]
}

/**
 * Parse `DS_AGENT_SANDBOX_READ_ISOLATION`. Unset/empty/`0`/`false` keep today's
 * host-wide reads; `1`/`true`/`strict` opt in. Any other value fails closed.
 */
export function readIsolationFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DS_AGENT_SANDBOX_READ_ISOLATION
  if (raw === undefined) return false
  const value = raw.trim()
  if (value === '' || value === '0' || value === 'false') return false
  if (value === '1' || value === 'true' || value === 'strict') return true
  throw new UserError(`invalid DS_AGENT_SANDBOX_READ_ISOLATION: "${raw}" (expected 0, 1, false, true, or strict)`)
}

/**
 * Wrap worker bash in an OS filesystem sandbox. An explicit `enabled: false`
 * opts out for tests/embedding; otherwise a missing sandbox wrapper is an error,
 * never a silent fallback to unsandboxed bash.
 */
export function wrapBashCommand(
  command: string,
  policy: SandboxPolicy,
  system: SandboxSystem = {
    platform: platform(),
    available: bin => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0,
  },
): { argv: string[]; wrapped: boolean } {
  if (!policy.enabled) return { argv: ['bash', '-c', command], wrapped: false }
  if (system.platform === 'darwin') {
    if (!system.available('sandbox-exec')) {
      throw new UserError('worker bash requires sandbox-exec on Darwin')
    }
    const execPath = system.execPath ?? process.execPath
    return {
      argv: ['sandbox-exec', '-p', darwinProfile(policy, execPath), 'bash', '--noprofile', '--norc', '-c', command],
      wrapped: true,
    }
  }
  if (system.platform === 'linux') {
    if (!system.available('bwrap')) {
      throw new UserError('worker bash requires bubblewrap (bwrap) on Linux')
    }
    const exists = system.exists ?? existsSync
    const hideArgs = bwrapHidePathArgs(
      policy.hidePaths ?? [],
      exists,
      p => {
        try {
          return lstatSync(p).isDirectory()
        } catch {
          return false
        }
      },
    )
    const argv = policy.readIsolation
      ? linuxStrictArgv(policy, exists)
      : [
        'bwrap',
        ...(policy.allowNetwork ? [] : ['--unshare-net']),
        ...(policy.unsharePid === true ? ['--unshare-pid'] : []),
        '--ro-bind', '/', '/',
        ...hideArgs,
        '--dev', '/dev',
        '--proc', '/proc',
        ...(policy.writableRoots ?? []).flatMap(root => ['--bind', root, root]),
        '--',
      ]
    return {
      argv: [...argv, 'bash', '--noprofile', '--norc', '-c', command],
      wrapped: true,
    }
  }
  throw new UserError(`worker bash has no filesystem sandbox on ${system.platform}`)
}

/** Sandboxing is the default; explicit LocalEnv options can still opt out. */
export function sandboxEnabledFromEnv(_env: NodeJS.ProcessEnv = process.env): boolean {
  return true
}

/** Worker bash sandbox wrapper on PATH — not proof of kernel confinement. */
export type SandboxWrapperAvailability = 'available' | 'unavailable' | 'unsupported'

/**
 * Secret-free host diagnostic for ops. Separate from `capabilities.*.enforced`,
 * which stays `unknown` because health never runs worker bash.
 */
export interface SandboxAvailabilityDiagnostic {
  /** `bwrap` on Linux or `sandbox-exec` on Darwin; missing wrapper is unavailable, not "isolation off". */
  workerSandboxWrapper: SandboxWrapperAvailability
  /**
   * Env/policy signal: strict read argv or profile would be selected when wrapping.
   * `unknown` when `DS_AGENT_SANDBOX_READ_ISOLATION` is invalid.
   */
  strictReadIsolationPolicy: 'on' | 'off' | 'unknown'
}

function sandboxWrapperPresent(system: SandboxSystem): boolean {
  if (system.platform === 'darwin') return system.available('sandbox-exec')
  if (system.platform === 'linux') return system.available('bwrap')
  return false
}

/**
 * Wrapper availability + policy flags for health/ops. Does not execute worker bash
 * or read vault secrets; presence of bwrap must not be reported as enforcement.
 */
export function probeSandboxAvailability(
  env: NodeJS.ProcessEnv = process.env,
  system: SandboxSystem = {
    platform: platform(),
    available: bin => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0,
  },
): SandboxAvailabilityDiagnostic {
  let strictReadIsolationPolicy: 'on' | 'off' | 'unknown'
  try {
    strictReadIsolationPolicy = readIsolationFromEnv(env) ? 'on' : 'off'
  } catch {
    strictReadIsolationPolicy = 'unknown'
  }

  if (system.platform !== 'darwin' && system.platform !== 'linux') {
    return { workerSandboxWrapper: 'unsupported', strictReadIsolationPolicy }
  }

  if (!sandboxWrapperPresent(system)) {
    return { workerSandboxWrapper: 'unavailable', strictReadIsolationPolicy }
  }

  return { workerSandboxWrapper: 'available', strictReadIsolationPolicy }
}
