import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UserError } from '../shared/errors.ts'

/**
 * Bundled and owner-authored playbooks the agent can load when a
 * task matches. The index (id plus one-line description) is injected into the
 * system prompt; the body is read on demand with `read_skill`.
 *
 * A skill is documentation, not a capability. It cannot grant a tool, widen a
 * role, or authorize an outward action. The registry resolves only exact catalog entries for regular files. Owner
 * skills use `<home>/skills/<id>/SKILL.md`; bundled references use IDs
 * discovered in the package. An ID is never interpreted as a filesystem path.
 */
export interface SkillInfo {
  id: string
  description: string
  bundled?: true
}

export interface SkillRecord extends SkillInfo {
  /** Absolute path resolved at load time. Never exposed to the model. */
  file: string
  bytes: number
  markdown?: true
}

export interface SkillDocument extends SkillInfo {
  body: string
  truncated: boolean
}

export const SKILLS_DIR = 'skills'
export const SKILL_FILE = 'SKILL.md'
export const MAX_SKILLS = 64
/** Skip a skill file larger than this many bytes before reading it. */
export const MAX_SKILL_FILE_BYTES = 256_000
export const MAX_SKILL_BODY_CHARS = 16_000
export const MAX_SKILL_DESCRIPTION_CHARS = 200
/** Budget for the index lines in the prompt; extra skills stay on disk. */
export const MAX_SKILL_INDEX_CHARS = 2_000

const PSTACK_ROOT = fileURLToPath(new URL(
  import.meta.url.endsWith('.ts') ? '../../vendor/pstack/' : '../pstack/',
  import.meta.url,
))

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Read the owner's skills directory. Missing or empty means no skills, not an
 * error. A malformed skill is skipped with a warning so one bad file cannot
 * take down the agent.
 */
export function loadSkills(
  home: string,
  warn: (line: string) => void = () => {},
): SkillRecord[] {
  const root = path.join(home, SKILLS_DIR)
  let names: string[]
  try {
    names = fs.readdirSync(root).sort()
  } catch {
    return []
  }
  const skills: SkillRecord[] = []
  for (const name of names) {
    if (skills.length >= MAX_SKILLS) {
      warn(`[skill] stopping at ${MAX_SKILLS} skills; later entries are ignored`)
      break
    }
    if (!ID.test(name)) {
      warn(`[skill] skipping ${JSON.stringify(name)}: directory name must match ${ID}`)
      continue
    }
    const record = readSkillRecord(root, name, warn)
    if (record) skills.push(record)
  }
  return skills
}

/** Package-owned workflow documents. IDs are generated from files in fixed directories. */
function loadPstackSkills(): SkillRecord[] {
  const root = path.join(PSTACK_ROOT, 'skills')
  const records: SkillRecord[] = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && ID.test(entry.name))
    .flatMap(entry => {
      const file = path.join(root, entry.name, SKILL_FILE)
      const stat = fs.lstatSync(file, { throwIfNoEntry: false })
      if (!stat?.isFile() || stat.size > MAX_SKILL_FILE_BYTES) return []
      const text = fs.readFileSync(file, 'utf8')
      const description = parseSkill(text, Infinity)?.description.slice(0, MAX_SKILL_DESCRIPTION_CHARS)
      return description ? [{ id: entry.name, description, file, bytes: stat.size, bundled: true as const }] : []
    })

  for (const entry of fs.readdirSync(PSTACK_ROOT, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const file = path.join(entry.parentPath, entry.name)
    const relative = path.relative(PSTACK_ROOT, file).split(path.sep).join('/')
    if (/^skills\/[^/]+\/SKILL\.md$/.test(relative)) continue
    const id = 'pstack:' + relative
    const bytes = fs.statSync(file).size
    if (bytes > MAX_SKILL_FILE_BYTES) continue
    const record: SkillRecord = { id, description: 'pstack workflow reference', file, bytes, markdown: true, bundled: true }
    records.push(record)
    const alias = relative
      .replace(/^skills\/poteto-mode\/playbooks\//, 'pstack-playbook-')
      .replace(/^skills\/poteto-mode\//, 'pstack-mode-')
      .replace(/^agents\//, 'pstack-agent-')
      .replace(/\.md$/, '')
    if (alias.startsWith('pstack-') && ID.test(alias)) records.push({ ...record, id: alias })
  }
  return records
}

function readSkillRecord(
  root: string,
  id: string,
  warn: (line: string) => void,
): SkillRecord | undefined {
  const dir = path.join(root, id)
  const file = path.join(dir, SKILL_FILE)
  try {
    if (!fs.lstatSync(dir).isDirectory()) {
      warn(`[skill] skipping ${id}: not a directory`)
      return undefined
    }
    // lstat, not stat: a symlink here could point outside the skills root.
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) {
      warn(`[skill] skipping ${id}: ${SKILL_FILE} must be a regular file, not a symlink`)
      return undefined
    }
    if (stat.size > MAX_SKILL_FILE_BYTES) {
      warn(`[skill] skipping ${id}: ${SKILL_FILE} is larger than ${MAX_SKILL_FILE_BYTES} bytes`)
      return undefined
    }
    const parsed = parseSkill(fs.readFileSync(file, 'utf8'))
    if (!parsed) {
      warn(`[skill] skipping ${id}: missing or invalid frontmatter description`)
      return undefined
    }
    return { id, description: parsed.description, file, bytes: stat.size }
  } catch (error) {
    warn(`[skill] skipping ${id}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

interface ParsedSkill {
  description: string
  body: string
}

/** Parse the YAML-ish frontmatter these skills use: one `key: value` per line. */
export function parseSkill(text: string, descriptionLimit = MAX_SKILL_DESCRIPTION_CHARS): ParsedSkill | undefined {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return undefined
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return undefined
  const header = normalized.slice(4, end)
  const body = normalized.slice(end + 4).replace(/^\n+/, '').trimEnd()
  const meta: Record<string, string> = {}
  for (const line of header.split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!
    const value = decodeScalar(match[2]!.trim())
    if (!(key in meta)) meta[key] = value
  }
  const description = meta.description?.trim() ?? ''
  if (!description || description.length > descriptionLimit || /[\r\n]/.test(description)) {
    return undefined
  }
  return { description, body }
}

function decodeScalar(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Read-only view of loaded skills. `list()` is prompt-safe; `read()` returns a
 * bounded body for one skill and re-checks the file before every read.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillRecord>()

  constructor(records: readonly SkillRecord[]) {
    for (const record of records) this.skills.set(record.id, record)
  }

  static fromHome(
    home: string,
    warn: (line: string) => void = () => {},
  ): SkillRegistry {
    return new SkillRegistry([...loadSkills(home, warn), ...loadPstackSkills()])
  }

  list(): SkillInfo[] {
    return [...this.skills.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(skill => ({
        id: skill.id,
        description: skill.description,
        ...(skill.bundled ? { bundled: true as const } : {}),
      }))
  }

  get size(): number {
    return this.skills.size
  }

  read(id: string): SkillDocument {
    const skill = this.skills.get(id)
    if (!skill) {
      const available = this.list().map(item => item.id).join(', ') || 'none'
      throw new UserError(`unknown skill ${JSON.stringify(id)}; available: ${available}`)
    }
    const stat = fs.lstatSync(skill.file)
    if (!stat.isFile()) throw new UserError(`skill ${id} is no longer a regular file`)
    if (stat.size > MAX_SKILL_FILE_BYTES) throw new UserError(`skill ${id} exceeds the file size limit`)
    const text = fs.readFileSync(skill.file, 'utf8')
    const parsed = skill.markdown ? { body: text, description: skill.description } : parseSkill(text, skill.bundled ? Infinity : MAX_SKILL_DESCRIPTION_CHARS)
    if (!parsed) throw new UserError(`skill ${id} changed on disk and is no longer valid`)
    const truncated = parsed.body.length > MAX_SKILL_BODY_CHARS
    return {
      id,
      description: parsed.description.slice(0, MAX_SKILL_DESCRIPTION_CHARS),
      body: truncated ? parsed.body.slice(0, MAX_SKILL_BODY_CHARS) : parsed.body,
      truncated,
    }
  }
}
