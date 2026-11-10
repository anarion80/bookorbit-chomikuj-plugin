#!/usr/bin/env node
/**
 * Offline test runner for the BookOrbit Chomikuj plugin.
 *
 * Usage:
 *   npm test
 *   node verify.mjs --only <substring>
 *
 * Every `tests/*.test.mjs` file is discovered dynamically and must default-export
 * an async `run(h)` function. The runner awaits it with the shared harness from
 * `tests/harness.mjs`, so adding a test file needs no edit to this file.
 *
 * `--only` matches a substring against the test filename, an optional `testName`
 * export, or the default export's function name. Exit code is 0 when every
 * assertion passes, 1 when any assertion fails or a test file throws.
 */

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHarness } from './tests/harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TESTS_DIR = path.join(HERE, 'tests')

function usage(message) {
  if (message) console.error(`verify: ${message}`)
  console.error('Usage: node verify.mjs [--only <substring>]')
}

function parseArgs(argv) {
  let only = null

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (argument === '--only') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        usage('--only requires a value')
        process.exit(1)
      }
      only = value
      index += 1
    } else if (argument.startsWith('--only=')) {
      only = argument.slice('--only='.length)
      if (only.length === 0) {
        usage('--only requires a value')
        process.exit(1)
      }
    } else {
      usage(`unknown argument: ${argument}`)
      process.exit(1)
    }
  }

  return { only }
}

async function discoverTestFiles() {
  let entries
  try {
    entries = await readdir(TESTS_DIR, { withFileTypes: true })
  } catch (error) {
    throw new Error(`cannot read the tests directory ${TESTS_DIR}: ${error.message}`)
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => entry.name)
    .sort()
}

function filenameMatches(only, filename) {
  const needle = only.toLowerCase()
  const base = filename.replace(/\.test\.mjs$/, '')
  return filename.toLowerCase().includes(needle) || base.toLowerCase().includes(needle)
}

function exportedNameMatches(only, module) {
  const needle = only.toLowerCase()
  const names = [module.testName, module.name, module.default?.name].filter(
    (value) => typeof value === 'string' && value.length > 0
  )
  return names.some((value) => value.toLowerCase().includes(needle))
}

async function main() {
  const { only } = parseArgs(process.argv.slice(2))
  const files = await discoverTestFiles()

  if (files.length === 0) {
    console.error('verify: no tests/*.test.mjs files found')
    return 1
  }

  const harness = createHarness()
  let ran = 0

  for (const filename of files) {
    const fileMatches = only === null || filenameMatches(only, filename)
    const filePath = path.join(TESTS_DIR, filename)

    let module
    try {
      module = await import(pathToFileURL(filePath).href)
    } catch (error) {
      if (!fileMatches) continue
      harness.ok(`${filename}: imports without throwing`, false, error?.stack ?? String(error))
      ran += 1
      continue
    }

    if (!fileMatches && !exportedNameMatches(only, module)) continue
    ran += 1

    console.log(`\n# ${filename}`)

    if (typeof module.default !== 'function') {
      harness.ok(
        `${filename}: default-exports run(h)`,
        false,
        'Expected `export default async function run(h) { ... }`; the default export is not a function.'
      )
      continue
    }

    try {
      await module.default(harness)
    } catch (error) {
      harness.ok(`${filename}: run(h) resolves`, false, error?.stack ?? String(error))
    }
  }

  if (only !== null && ran === 0) {
    console.error(`verify: no test files matched --only ${JSON.stringify(only)}`)
    return 1
  }

  return harness.finish()
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error) => {
    console.error(error?.stack ?? String(error))
    process.exitCode = 1
  })
