import fs from 'node:fs'

/** Publish a test marker atomically: write to a temp file, then rename. */
export function publishMarker(file: string, value: Record<string, unknown>): void {
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`)
  fs.renameSync(temp, file)
}

/**
 * Read a marker only when it holds a complete JSON record. A transient partial
 * write is treated as "not yet published" so a cross-process reader can retry.
 * Malformed records that remain after the caller's deadline are still visible
 * as a missing marker, which the caller reports as a timeout.
 */
export function readCompleteMarker(file: string): Record<string, unknown> | undefined {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    const value = JSON.parse(text) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // Incomplete or malformed: not a completed record.
  }
  return undefined
}

/** Temp-file suffix used by publishMarker, exported for cleanup in tests. */
export function markerTempPath(file: string): string {
  return `${file}.${process.pid}.tmp`
}

export function removeMarker(file: string): void {
  fs.rmSync(file, { force: true })
  fs.rmSync(markerTempPath(file), { force: true })
}
