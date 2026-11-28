import { createHash } from 'node:crypto'
import { UserError } from '../shared/errors.ts'
import type { Store } from '../store/sqlite.ts'

const ROOT = '/memories'
export const CONSOLIDATED_MEMORY_PATH = '/memories/wiki/runtime.md'
const INDEX_PATH = ROOT + '/MEMORY.md'
const DOCUMENT_KIND = 'memory_notes'
const MAX_PATH_CHARS = 240
const MAX_FILES = 128
const MAX_SCOPE_BYTES = 512 * 1024
const MAX_FILE_BYTES = 64 * 1024
const MAX_LINE_BYTES = 4 * 1024
const MAX_VIEW_CHARS = 16_000
const MAX_INDEX_CHARS = 2_000

export interface Note {
  path: string
  text: string
}

interface NotesDocument {
  files: Note[]
}

/** Host-owned scopes expose virtual text paths only. No command touches host filesystem paths. */
export class MemoryNotes {
  constructor(private readonly store: Store, private readonly redact: (text: string) => string) {}

  readIndex(scope: string): string | undefined {
    const files = this.load(scopeId(scope))
    const index = files.find(file => file.path === INDEX_PATH)
    const consolidated = files.find(file => file.path === CONSOLIDATED_MEMORY_PATH)?.text
    const pointer = consolidated ? `Background-consolidated knowledge: ${CONSOLIDATED_MEMORY_PATH}` : ''
    if (!index && !pointer) return undefined
    const text = this.redact([pointer, index?.text].filter(Boolean).join('\n')).slice(0, MAX_INDEX_CHARS)
    return text.replace(/[\uD800-\uDBFF]$/, '')
  }

  readConsolidated(scope: string): string | undefined {
    return this.load(scopeId(scope)).find(file => file.path === CONSOLIDATED_MEMORY_PATH)?.text
  }

  readEditableNotes(scope: string): Note[] {
    return this.load(scopeId(scope)).filter(file => file.path !== CONSOLIDATED_MEMORY_PATH
      && file.path.endsWith('.md') && file.text.length <= 1_200)
      .slice(0, 6)
      .map(file => ({ path: file.path, text: this.redact(file.text) }))
  }

  /** Caller owns a transaction including scope, cursor and snapshot checks. */
  applyConsolidation(scope: string, page: string | undefined, edits: Note[]): void {
    const id = scopeId(scope)
    const files = this.load(id)
    if (page !== undefined) {
      const note = files.find(file => file.path === CONSOLIDATED_MEMORY_PATH)
      const safePage = this.redact(inputText(page, 'consolidated memory'))
      if (note) note.text = safePage
      else {
        assertAvailable(files, CONSOLIDATED_MEMORY_PATH)
        files.push({ path: CONSOLIDATED_MEMORY_PATH, text: safePage })
      }
    }
    for (const { path, text } of edits) getFile(files, path).text = this.redact(inputText(text, 'consolidated note'))
    validateLimits(files)
    this.store.putDoc(DOCUMENT_KIND, id, { files })
  }

  execute(scope: string, args: Record<string, unknown>): string {
    const id = scopeId(scope)
    if (args.command === 'view') {
      const path = this.path(args.path)
      return view(this.load(id), path, args.view_range, this.redact)
    }

    return this.store.atomic(() => {
      const files = this.load(id)
      const result = this.mutate(files, args)
      validateLimits(files)
      if (files.length === 0) this.store.deleteDoc(DOCUMENT_KIND, id)
      else this.store.putDoc(DOCUMENT_KIND, id, { files })
      return result
    })
  }

  private load(id: string): Note[] {
    return this.store.getDoc<NotesDocument>(DOCUMENT_KIND, id)?.files ?? []
  }

  private path(value: unknown): string {
    if (typeof value !== 'string' || value.length > MAX_PATH_CHARS || this.redact(value) !== value) {
      throw new UserError('Invalid memory path')
    }
    if (value === ROOT) return value
    if (!value.startsWith(ROOT + '/')) throw new UserError('Memory path must be under /memories')
    for (const name of value.slice(ROOT.length + 1).split('/')) {
      if (name.length === 0 || name.startsWith('.') || name === 'node_modules'
        || name.trim() !== name || /[^\p{L}\p{M}\p{N}._+ -]/u.test(name)) {
        throw new UserError('Invalid memory path component')
      }
    }
    return value
  }

  private mutate(files: Note[], args: Record<string, unknown>): string {
    if (args.command === 'rename') {
      const source = this.path(args.old_path)
      const target = this.path(args.new_path)
      assertNonRoot(source)
      assertNonRoot(target)
      const moving = files.filter(file => atOrBelow(file.path, source))
      if (!moving.length) throw missing(source)
      if (target.startsWith(source + '/')) throw new UserError('Cannot move a memory directory into its descendant')
      assertAvailable(files, target)
      for (const file of moving) file.path = this.path(target + file.path.slice(source.length))
      return `Renamed ${source} to ${target}`
    }

    const path = this.path(args.path)
    assertNonRoot(path)
    switch (args.command) {
      case 'create': {
        assertAvailable(files, path)
        const text = inputText(args.file_text, 'file_text')
        files.push({ path, text: this.redact(text) })
        return `Created ${path}`
      }
      case 'delete': {
        const remaining = files.filter(file => !atOrBelow(file.path, path))
        if (remaining.length === files.length) throw missing(path)
        files.splice(0, files.length, ...remaining)
        return `Deleted ${path}`
      }
      case 'str_replace': {
        const file = getFile(files, path)
        const oldText = this.redact(inputText(args.old_str, 'old_str'))
        const newText = args.new_str === undefined ? '' : inputText(args.new_str, 'new_str')
        if (oldText.length === 0) throw new UserError('old_str must be non-empty')
        const offset = file.text.indexOf(oldText)
        if (offset < 0) throw new UserError('old_str does not appear in the memory file')
        if (file.text.indexOf(oldText, offset + 1) >= 0) {
          throw new UserError('Multiple occurrences of old_str in the memory file')
        }
        file.text = this.redact(file.text.slice(0, offset) + newText + file.text.slice(offset + oldText.length))
        const changedLine = file.text.slice(0, offset).split('\n').length
        return viewText(file, [Math.max(1, changedLine - 2), changedLine + 2], 'Edited memory file')
      }
      case 'insert': {
        const file = getFile(files, path)
        const insertLine = args.insert_line
        const lines = fileLines(file.text)
        if (typeof insertLine !== 'number' || !Number.isInteger(insertLine)
          || insertLine < 0 || insertLine > lines.length) {
          throw new UserError(`insert_line must be between 0 and ${lines.length}`)
        }
        const text = inputText(args.insert_text, 'insert_text')
        if (text.length) {
          const withFinalNewline = file.text.endsWith('\n')
            || (insertLine === lines.length && text.endsWith('\n'))
          const joined = [...lines.slice(0, insertLine), ...fileLines(text), ...lines.slice(insertLine)]
          file.text = this.redact(joined.join('\n') + (withFinalNewline ? '\n' : ''))
        }
        return `Edited ${path}`
      }
      default:
        throw new UserError('Unsupported memory command')
    }
  }
}

function scopeId(scope: string): string {
  if (!scope) throw new UserError('memory scope is unavailable')
  return createHash('sha256').update(scope).digest('hex')
}

function missing(path: string): UserError {
  return new UserError(`Memory path ${path} does not exist`)
}

function atOrBelow(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent + '/')
}

function assertNonRoot(path: string): void {
  if (path === ROOT) throw new UserError('Cannot modify the memory root')
}

function assertAvailable(files: Note[], path: string): void {
  if (files.some(file => atOrBelow(file.path, path))) throw new UserError(`Memory path ${path} already exists`)
  if (files.some(file => path.startsWith(file.path + '/'))) {
    throw new UserError('The destination parent is a file, so it cannot be used as a directory')
  }
}

function getFile(files: Note[], path: string): Note {
  const file = files.find(file => file.path === path)
  if (!file) throw missing(path)
  return file
}

function inputText(value: unknown, name: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_FILE_BYTES || value.includes('\0')) {
    throw new UserError(`${name} must be text up to ${MAX_FILE_BYTES} bytes without NUL characters`)
  }
  return value.replace(/\r\n?/g, '\n')
}

function fileLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

function validateLimits(files: Note[]): void {
  if (files.length > MAX_FILES) throw new UserError(`Memory may contain up to ${MAX_FILES} files`)
  let total = 0
  for (const { text } of files) {
    const size = Buffer.byteLength(text)
    if (size > MAX_FILE_BYTES) throw new UserError(`A memory file may contain up to ${MAX_FILE_BYTES} bytes`)
    if (fileLines(text).some(line => Buffer.byteLength(line) > MAX_LINE_BYTES)) {
      throw new UserError(`A memory file line may contain up to ${MAX_LINE_BYTES} bytes`)
    }
    total += size
  }
  if (total > MAX_SCOPE_BYTES) throw new UserError(`Memory may contain up to ${MAX_SCOPE_BYTES} bytes per scope`)
}

function view(files: Note[], path: string, range: unknown, redact: (text: string) => string): string {
  const file = files.find(entry => entry.path === path)
  if (file) return viewText({ ...file, text: redact(file.text) }, range)
  const descendants = files.filter(entry => entry.path.startsWith(path + '/'))
  if (path !== ROOT && !descendants.length) throw missing(path)

  const sizes = new Map<string, number>([[path, 0]])
  for (const entry of descendants) {
    const bytes = Buffer.byteLength(entry.text)
    const segments = entry.path.slice(path.length + 1).split('/').slice(0, 2)
    let ancestor = path
    for (const segment of segments) {
      ancestor += '/' + segment
      sizes.set(ancestor, (sizes.get(ancestor) ?? 0) + bytes)
    }
    sizes.set(path, sizes.get(path)! + bytes)
  }
  const rows = [...sizes.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, size]) => `${sizeLabel(size)}\t${redact(name)}`)
  return boundedRows(`Memory directory ${path} (up to two levels deep)`, rows, () =>
    'Listing truncated. View a subdirectory for more entries.')
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  return `${Math.round(bytes / 102.4) / 10}K`
}

function viewText(file: Note, range: unknown, label = 'Memory file'): string {
  return viewRows(`${label} ${file.path}`, fileLines(file.text), range)
}

function viewRows(header: string, lines: string[], range: unknown): string {
  let start = 1
  let end = lines.length
  if (range !== undefined) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger)
      || range[0] < 1 || (range[1] !== -1 && range[1] < range[0])) {
      throw new UserError('view_range must be [start, end] using 1-based lines, or [start, -1]')
    }
    start = range[0]
    end = range[1] === -1 ? lines.length : Math.min(range[1], lines.length)
  }

  const rows = lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(6)}\t${line}`)
  return boundedRows(header, rows, shown =>
    `View truncated. Continue with view_range starting at line ${start + shown}.`)
}

function boundedRows(header: string, rows: string[], truncated: (shown: number) => string): string {
  const result = [header]
  let remaining = MAX_VIEW_CHARS - header.length - 128
  for (const row of rows) {
    if (row.length + 1 > remaining) {
      result.push(truncated(result.length - 1))
      break
    }
    result.push(row)
    remaining -= row.length + 1
  }
  return result.join('\n')
}
