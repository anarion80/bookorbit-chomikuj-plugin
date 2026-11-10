#!/usr/bin/env node
/**
 * Build the BookOrbit Chomikuj plugin bundle.
 *
 * Bundles src/index.mjs into dist/index.mjs with the local esbuild
 * devDependency. The output is a single ESM file that imports only Node
 * builtins such as node:crypto. Stale output is removed first so a failed
 * build cannot leave an old bundle behind for scripts/check-plugin.mjs to
 * accept.
 *
 * Usage:
 *   npm run build
 *   node scripts/build.mjs
 */

import { rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const MAX_BYTES = 524288
const ROOT = path.resolve(import.meta.dirname, '..')
const ENTRY = path.join(ROOT, 'src', 'index.mjs')
const OUTDIR = path.join(ROOT, 'dist')
const OUTFILE = path.join(OUTDIR, 'index.mjs')
const DISPLAY = 'dist/index.mjs'

async function main() {
  rmSync(OUTDIR, { recursive: true, force: true })

  await build({
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    logLevel: 'info'
  })

  let size
  try {
    size = statSync(OUTFILE).size
  } catch (error) {
    console.error(
      `build: ${DISPLAY} was not produced: ${error?.message ?? String(error)}`
    )
    process.exitCode = 1
    return
  }

  if (size >= MAX_BYTES) {
    console.error(
      `build: ${DISPLAY} is ${size} bytes; BookOrbit rejects installs at or above ${MAX_BYTES} bytes (512 KiB)`
    )
    process.exitCode = 1
    return
  }

  console.log(`${DISPLAY} ${size} bytes`)
}

main().catch((error) => {
  console.error(error?.stack ?? String(error))
  process.exitCode = 1
})
