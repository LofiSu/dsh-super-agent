import fs from 'node:fs'
import path from 'node:path'

/** External secret store. Values must never appear in tool results or prompts. */
export interface Vault {
  has(name: string): boolean
  /** Names only — never returns values to callers that build model context. */
  names(): string[]
  describe(): { name: string; present: boolean }[]
  set(name: string, value: string): void
  /** Inject selected secrets into a child process env. Do not log the result. */
  resolveForChild(names: readonly string[]): NodeJS.ProcessEnv
}

export class MemoryVault implements Vault {
  readonly #secrets = new Map<string, string>()

  has(name: string): boolean {
    return this.#secrets.has(name)
  }

  names(): string[] {
    return [...this.#secrets.keys()].sort()
  }

  describe(): { name: string; present: boolean }[] {
    return this.names().map(name => ({ name, present: true }))
  }

  set(name: string, value: string): void {
    if (!name.trim()) throw new Error('vault name required')
    this.#secrets.set(name, value)
  }

  resolveForChild(names: readonly string[]): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {}
    for (const name of names) {
      const value = this.#secrets.get(name)
      if (value !== undefined) out[name] = value
    }
    return out
  }
}

export class FileVault implements Vault {
  readonly #mem = new MemoryVault()
  /**
   * The fill-vault section shares `vault.json` but is owned by `fill-vault.ts`.
   * Keep it verbatim when this class rewrites the env-injection entries.
   */
  #fillSection: unknown

  constructor(private readonly filePath: string) {
    this.load()
  }

  /** Structured fill configuration owns the `fill` key; a string is a legacy env entry. */
  static #isFillSection(value: unknown): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, unknown>
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        // Only structured fill configuration is reserved. A string-valued
        // `fill` is a normal env entry and stays writable via set().
        this.#fillSection = FileVault.#isFillSection(raw.fill) ? raw.fill : undefined
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === 'string') this.#mem.set(k, v)
        }
      }
    } catch {
      // empty vault
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const obj: Record<string, unknown> = {}
    for (const name of this.#mem.names()) {
      const child = this.#mem.resolveForChild([name])
      if (child[name] !== undefined) obj[name] = child[name]!
    }
    // Re-read the current fill section so a concurrent owner edit is not
    // silently restored to the value cached when this instance was created.
    // If the file was removed or is unreadable/malformed, keep the last known
    // structured value rather than dropping owner configuration entirely.
    let fillSection = this.#fillSection
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, unknown>
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        fillSection = FileVault.#isFillSection(raw.fill) ? raw.fill : undefined
        this.#fillSection = fillSection
      }
    } catch {
      // Keep the last known section as a fallback.
    }
    if (fillSection !== undefined) obj.fill = fillSection
    fs.writeFileSync(this.filePath, `${JSON.stringify(obj)}\n`, { mode: 0o600 })
    fs.chmodSync(this.filePath, 0o600)
  }

  has(name: string): boolean {
    return this.#mem.has(name)
  }

  names(): string[] {
    return this.#mem.names()
  }

  describe(): { name: string; present: boolean }[] {
    return this.#mem.describe()
  }

  set(name: string, value: string): void {
    // A structured fill section reserves the `fill` key; writing an env entry
    // with that name would either be overwritten on persist or overwrite the
    // section. Reject before changing memory.
    if (name === 'fill' && this.#fillSection !== undefined) {
      throw new Error('cannot set a string env entry named fill while a structured fill section exists')
    }
    this.#mem.set(name, value)
    this.persist()
  }

  resolveForChild(names: readonly string[]): NodeJS.ProcessEnv {
    return this.#mem.resolveForChild(names)
  }
}
