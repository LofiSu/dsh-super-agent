/**
 * Copy runtime assets that tsc does not emit into dist.
 *
 * Keep this list in sync with the non-.ts files the runtime loads; the
 * packaging smoke script asserts each emitted asset is in the tarball. The
 * evaluator child ships under dist/scripts so a published package can run it
 * with plain node (no tsx, no src/).
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Assets under `src/` that the published package needs at runtime.
 * The evaluator child is sourced from scripts/ and is handled separately below.
 */
export const RUNTIME_ASSETS = [
  'watchdog/rules.json',
  'env/fixtures/sandbox-loopback-server.mjs',
  'env/fixtures/sandbox-external-pid-fixture.mjs',
] as const

export function copyRuntimeAssets(repoRoot: string = root): void {
  for (const asset of RUNTIME_ASSETS) {
    const from = path.join(repoRoot, 'src', asset)
    const to = path.join(repoRoot, 'dist', asset)
    mkdirSync(path.dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
}

function main(): void {
  copyRuntimeAssets()
  const from = path.join(root, 'scripts', 'evolution-eval-child.mjs')
  const to = path.join(root, 'dist', 'scripts', 'evolution-eval-child.mjs')
  mkdirSync(path.dirname(to), { recursive: true })
  copyFileSync(from, to)
  console.log(
    `copied ${RUNTIME_ASSETS.length + 1} asset(s) to dist: ${[...RUNTIME_ASSETS, 'scripts/evolution-eval-child.mjs'].join(', ')}`,
  )
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === entry) main()
