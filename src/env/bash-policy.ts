import { UserError } from '../shared/errors.ts'

/** Protected branch names — no direct push or merge into these via dev shells. */
export const PROTECTED_BRANCHES = new Set(['main', 'master'])

export interface DevShellPolicyOptions {
  /** Current branch (`git rev-parse --abbrev-ref HEAD`) when cwd is a git repo. */
  headBranch?: string
}

/**
 * Returns a rejection reason when a non-isolated dev shell must not run `command`.
 * Pure text analysis; returns `null` when allowed.
 */
export function devShellCommandRejection(
  command: string,
  options?: DevShellPolicyOptions,
): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  // Text-based defense in depth: shells, subshells, and command substitution
  // can hide a protected operation from the statement splitter. Reject these
  // shapes outright when they could wrap a git/gh command; the OS sandbox is
  // the real boundary. This is not a shell parser.
  const wrapperRejection = wrapperBypassRejection(trimmed)
  if (wrapperRejection) return wrapperRejection
  if (checkoutProtectedRefThenPushInCommand(trimmed)) {
    return 'dev shell policy: git push after checking out a protected ref is not allowed'
  }
  const initialHead = options?.headBranch?.trim() || undefined
  const statements = splitShellStatements(trimmed)
  // Branch-dependent checks use the branch active at each statement: a prior
  // `git switch/checkout` changes HEAD for everything that follows.
  const headStates = branchStatesForStatements(statements, initialHead)

  for (let i = 0; i < statements.length; i += 1) {
    const stmt = statements[i]
    const state = headStates[i]
    const onProtectedHead = state ? protectedRefName(state) : false
    if (rejectsGhPrMerge(stmt)) {
      return 'dev shell policy: gh pr merge is not allowed (use a PR and owner/orchestrator merge)'
    }
    if (rejectsGitPushToProtected(stmt, onProtectedHead)) {
      return 'dev shell policy: git push to main/master is not allowed'
    }
    if (onProtectedHead && rejectsMergeRebaseStatement(stmt)) {
      return 'dev shell policy: merge or rebase on main/master is not allowed'
    }
    if (checkoutProtectedRefThenPush(stmt)) {
      return 'dev shell policy: git push after checking out a protected ref is not allowed'
    }
  }
  return null
}

/**
 * `git checkout main -- <path>` checks out files but references a protected
 * ref; following it with a default push is ambiguous under text analysis, so
 * reject conservatively.
 */
function checkoutProtectedRefThenPush(statement: string): boolean {
  const tokens = tokenizeSimple(statement)
  const checkoutIdx = gitSubcommandIndex(tokens, 'checkout')
  if (checkoutIdx < 0) return false
  const args = tokens.slice(checkoutIdx + 1)
  const refsProtected = args.some(t => /^(main|master|origin\/(main|master)|refs\/heads\/(main|master))$/.test(t))
  return refsProtected && hasGitSubcommand(statement, 'push')
}

/**
 * `git checkout main -- <path>` in one statement followed by a default push in
 * a later statement leaves HEAD ambiguous under text analysis. Reject whole
 * commands with that shape conservatively.
 */
function checkoutProtectedRefThenPushInCommand(command: string): boolean {
  const statements = splitShellStatements(command)
  let sawProtectedCheckout = false
  for (const stmt of statements) {
    const tokens = tokenizeSimple(stmt)
    const checkoutIdx = gitSubcommandIndex(tokens, 'checkout')
    if (checkoutIdx >= 0 && tokens.slice(checkoutIdx + 1)
      .some(t => /^(main|master|origin\/(main|master)|refs\/heads\/(main|master))$/.test(t))) {
      sawProtectedCheckout = true
    }
    if (sawProtectedCheckout && hasGitSubcommand(stmt, 'push')) return true
  }
  return false
}

/**
 * Reject nested shells, subshells, and command substitution that could hide a
 * protected git/gh operation. Deliberately conservative: a nested shell with
 * no git/gh content is allowed, and command substitution near a protected ref
 * is rejected without trying to evaluate it.
 */
function wrapperBypassRejection(command: string): string | null {
  if (/\b(?:bash|sh|zsh|dash|ksh)\s+-\w*c\b/.test(command)
    && /\b(?:git|gh)\b/.test(command)) {
    return 'dev shell policy: nested shells running git/gh are not allowed'
  }
  if (/\([^)]*\b(?:git|gh)\b[^)]*\)/.test(command)) {
    return 'dev shell policy: subshells running git/gh are not allowed'
  }
  if (/\$\([^)]*\b(?:git|echo|printf|cat)\b/.test(command)
    || /`[^`]*\b(?:git|echo|printf|cat)\b/.test(command)
    || /\$\{[^}]*(?:main|master)\b/.test(command)) {
    return 'dev shell policy: command substitution in dev shell commands is not allowed'
  }
  return null
}

/** Track explicit branch switches, so later statements see the updated HEAD. */
function branchStatesForStatements(statements: string[], initial: string | undefined): (string | undefined)[] {
  let current = initial
  return statements.map(stmt => {
    const switched = switchedBranch(stmt)
    if (switched !== undefined) current = switched
    return current
  })
}

/**
 * Return the branch a switch/checkout selects, or undefined when it cannot be
 * determined. We only ever *advance* the tracked head on a confident branch
 * switch; an ambiguous checkout leaves the prior (more conservative) state in
 * place so a file checkout can never make a protected HEAD look unprotected.
 */
function switchedBranch(statement: string): string | undefined {
  const tokens = tokenizeSimple(statement)
  const switchIdx = gitSubcommandIndex(tokens, 'switch')
  const checkoutIdx = gitSubcommandIndex(tokens, 'checkout')
  if (switchIdx >= 0) {
    const args = tokens.slice(switchIdx + 1)
    // `git switch --detach` leaves HEAD on no branch; keep the prior state.
    if (args.includes('--detach')) return undefined
    // `git switch` never checks out paths, so the first operand is a branch.
    return args.find(t => !t.startsWith('-'))
  }
  if (checkoutIdx >= 0) {
    const args = tokens.slice(checkoutIdx + 1)
    // `git checkout -- <path>` checks out files, not a branch.
    if (args.includes('--')) return undefined
    const createsBranch = args.some(t => /^-[bBC]$/.test(t))
    const target = args.find(t => !t.startsWith('-'))
    if (!target) return undefined
    if (createsBranch) return target
    // Only branch-like names count; a plain filename (`git checkout README.md`)
    // must not be mistaken for a switch away from a protected HEAD.
    if (protectedRefName(target) || target.includes('/') || target.startsWith('refs/')) return target
  }
  return undefined
}

export function assertDevShellCommandAllowed(
  command: string,
  options?: DevShellPolicyOptions,
): void {
  const reason = devShellCommandRejection(command, options)
  if (reason) throw new UserError(reason)
}

/** Split on `;`, `&&`, `||`, and newlines — enough for common compound commands. */
export function splitShellStatements(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let i = 0
  while (i < command.length) {
    const ch = command[i]
    if (ch === '\n' || ch === ';') {
      parts.push(current)
      current = ''
      i += 1
      continue
    }
    if (ch === '&' && command[i + 1] === '&') {
      parts.push(current)
      current = ''
      i += 2
      continue
    }
    if (ch === '|' && command[i + 1] === '|') {
      parts.push(current)
      current = ''
      i += 2
      continue
    }
    current += ch
    i += 1
  }
  parts.push(current)
  return parts.map(p => p.trim()).filter(Boolean)
}

/**
 * Detect a subcommand after git global options (`-C .`, `-c k=v`, `--no-pager`,
 * etc.). The policy is defense in depth behind the OS sandbox; we deliberately
 * fail closed when the shape is ambiguous.
 */
function gitSubcommandIndex(tokens: string[], sub: string): number {
  const gitIdx = tokens.findIndex(t => t === 'git')
  if (gitIdx < 0) return -1
  let i = gitIdx + 1
  while (i < tokens.length) {
    const t = tokens[i]
    if (t === sub) return i
    if (!isGitGlobalOption(t)) return -1
    // `-C`/`-c`/`--git-dir`/`--work-tree`/`--namespace`/`--exec-path` take a separate value.
    if (/^-(C|c)$/.test(t) || GIT_GLOBAL_VALUE_OPTIONS.has(t)) i += 2
    else i += 1
  }
  return -1
}

const GIT_GLOBAL_VALUE_OPTIONS = new Set([
  '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env',
])

function isGitGlobalOption(token: string): boolean {
  if (/^-[A-Za-z]$/.test(token)) return true
  if (/^--[\w-]+(?:=\S+)?$/.test(token)) return true
  return false
}

function hasGitSubcommand(statement: string, sub: string): boolean {
  return gitSubcommandIndex(tokenizeSimple(statement), sub) >= 0
}

function rejectsGhPrMerge(command: string): boolean {
  // gh global options (`-R owner/repo`) may precede the `pr merge` subcommand.
  return /\bgh(?:\s+--[\w-]+(?:=\S+)?|\s+-[A-Za-z](?:\s+\S+)?)*\s+pr\s+merge\b/.test(command)
}

function rejectsGitPushToProtected(command: string, onProtectedHead: boolean): boolean {
  const stmt = command
  if (!hasGitSubcommand(stmt, 'push')) return false
  if (onProtectedHead && gitPushHasNoNonProtectedDestRefspec(stmt)) return true
  return gitPushStatementTargetsProtected(stmt)
}

/** True when push has no explicit refspec, or only `git push [remote]` (upstream/default push). */
function gitPushHasNoNonProtectedDestRefspec(statement: string): boolean {
  const { refspecs } = parsePushArgs(statement)
  if (refspecs.length === 0) return true
  return !refspecs.some(refspec => !isDefaultHeadRefspec(refspec) && !refspecTargetsProtectedBranch(refspec))
}

function isDefaultHeadRefspec(refspec: string): boolean {
  return /^\+?(?:HEAD|@)$/.test(refspec)
}

function rejectsMergeRebaseStatement(statement: string): boolean {
  return hasGitSubcommand(statement, 'merge') || hasGitSubcommand(statement, 'rebase')
}

interface PushArgs {
  refspecs: string[]
  pushModes: Set<string>
}

/**
 * Parse push arguments by position: options first, then the optional repository
 * (a remote name, local path, or URL), then refspecs. Modes such as `--all` or
 * `--mirror` include protected branches and are reported so callers reject them.
 */
function parsePushArgs(statement: string): PushArgs {
  const tokens = tokenizeSimple(statement)
  const pushIdx = gitSubcommandIndex(tokens, 'push')
  const pushModes = new Set<string>()
  if (pushIdx < 0) return { refspecs: [], pushModes }

  const afterPush = tokens.slice(pushIdx + 1)
  const operands: string[] = []
  for (const arg of afterPush) {
    if (arg.startsWith('-')) {
      if (/^--(all|mirror)$/.test(arg) || /^--repo(?:=|$)/.test(arg)) pushModes.add(arg)
      continue
    }
    operands.push(arg)
  }

  if (pushModes.size > 0) return { refspecs: [], pushModes }
  // Consume the repository argument by position when present. A bare HEAD/@ is
  // a default-push refspec, not a remote, so it must not be mistaken for one.
  let refspecs = operands
  if (operands.length > 0 && !isDefaultHeadRefspec(operands[0]) && isRepositoryArg(operands[0])) {
    refspecs = operands.slice(1)
  }
  return { refspecs, pushModes }
}

function isRepositoryArg(arg: string): boolean {
  // Remote names are simple words; paths and URLs are also valid repositories.
  // A refspec always contains a colon or targets a recognizable branch/root.
  if (arg.includes(':')) return false
  if (isDefaultHeadRefspec(arg)) return false
  return /^[\w.-]+$/.test(arg) || arg.includes('/') || arg === '.' || arg === '..'
}

/**
 * Detect refspecs and branch args that update main/master on a remote.
 * Allows `git push origin feature/foo` and local bare remotes on feature branches.
 */
export function gitPushStatementTargetsProtected(statement: string): boolean {
  const { refspecs, pushModes } = parsePushArgs(statement)
  if (pushModes.size > 0) return true
  return refspecs.some(refspec =>
    !isDefaultHeadRefspec(refspec) && refspecTargetsProtectedBranch(refspec))
}

export function refspecTargetsProtectedBranch(refspec: string): boolean {
  const normalized = refspec.replace(/^\+/, '').trim()
  if (!normalized) return false

  if (normalized.startsWith(':')) {
    return protectedRefName(normalized.slice(1))
  }

  const colon = normalized.indexOf(':')
  if (colon >= 0) {
    const dest = normalized.slice(colon + 1)
    return protectedRefName(dest)
  }

  return protectedRefName(normalized)
}

export function protectedRefName(ref: string): boolean {
  const r = ref.trim()
  if (r === 'HEAD' || r === '@') return false
  const branch = r
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '')
    .split('/')[0]
  return PROTECTED_BRANCHES.has(branch)
}

function tokenizeSimple(statement: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote: "'" | '"' | null = null
  for (let i = 0; i < statement.length; i += 1) {
    const c = statement[i]
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (/\s/.test(c)) {
      if (cur) {
        tokens.push(cur)
        cur = ''
      }
      continue
    }
    cur += c
  }
  if (cur) tokens.push(cur)
  return tokens
}
