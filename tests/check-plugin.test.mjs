/**
 * Tests for `scripts/check-plugin.mjs`, the built-plugin shape and safety gate.
 *
 * Each case writes a complete temporary plugin bundle or a mutated variant,
 * runs the real check script with `spawnSync`, and asserts the exit code and
 * the specific violation text. The temp directory is removed in `finally`.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const testName = 'built-plugin check'

const CHECK_SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts', 'check-plugin.mjs')
const MAX_BYTES = 524288

const DEFAULT_SETTINGS = `  settingsFields: [
    {
      key: 'username',
      type: 'string',
      label: 'Username'
    }
  ],`

const ARCHIVE_SETTINGS = `  settingsFields: [
    {
      key: 'formats',
      type: 'string',
      label: 'Ebook formats',
      format: 'list',
      default: 'epub',
      options: ['epub', 'cbz'],
      minItems: 1
    }
  ],`

function pluginSource({
  imports = "import { createHash } from 'node:crypto'",
  topLevel = '',
  extraEntry = '',
  settingsFields = DEFAULT_SETTINGS
} = {}) {
  return `${imports}

const _hash = createHash('md5').update('temp').digest('hex')

${topLevel}

export default {
  apiVersion: 1,
  version: '0.1.0',
  type: 'temp-plugin',
  label: 'Temp plugin',
  requiresCredential: true,
  credentialKind: 'apiKey',
  mediaKinds: ['ebook'],
  usesCategories: false,
  seedsBack: false,
${settingsFields}
  search: async () => [],
  test: async () => ({ success: true }),
  resolveFile: async () => ({ url: 'https://example.test/file' }),
  forget: () => {},
${extraEntry}
}
`
}

function runCheck(tempDir, name, source) {
  const filePath = path.join(tempDir, name)
  writeFileSync(filePath, source, 'utf8')
  return spawnSync(process.execPath, [CHECK_SCRIPT, filePath], { encoding: 'utf8' })
}

function output(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

export default async function run(h) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'bookorbit-check-plugin-'))

  try {
    const valid = runCheck(tempDir, 'valid.mjs', pluginSource())
    h.ok('valid plugin (with node:crypto) exits 0', valid.status === 0, output(valid))
    h.ok('valid plugin prints the success line', valid.stdout.includes('check-plugin: OK'), valid.stdout)

    const missing = spawnSync(process.execPath, [CHECK_SCRIPT, path.join(tempDir, 'missing.mjs')], {
      encoding: 'utf8'
    })
    h.ok('missing target exits 1', missing.status === 1, output(missing))
    h.ok('missing target says the file does not exist', /does not exist/.test(missing.stderr), missing.stderr)

    const fetchResult = runCheck(
      tempDir,
      'global-fetch.mjs',
      pluginSource({
        topLevel: "function probe() {\n  return globalThis.fetch('https://example.test')\n}"
      })
    )
    h.ok('globalThis.fetch exits 1', fetchResult.status === 1, output(fetchResult))
    h.ok('globalThis.fetch violation names fetch', /fetch/.test(output(fetchResult)), output(fetchResult))

    const errorResult = runCheck(
      tempDir,
      'error-subclass.mjs',
      pluginSource({ topLevel: 'class CustomError extends Error {}' })
    )
    h.ok('custom Error subclass exits 1', errorResult.status === 1, output(errorResult))
    h.ok(
      'custom Error subclass is reported',
      /custom class extending Error/.test(output(errorResult)),
      output(errorResult)
    )

    const updateResult = runCheck(
      tempDir,
      'update.mjs',
      pluginSource({ extraEntry: '  update: { enabled: false },' })
    )
    h.ok('update block exits 1', updateResult.status === 1, output(updateResult))
    h.ok('update block is reported', /update/.test(output(updateResult)), output(updateResult))

    const archiveResult = runCheck(
      tempDir,
      'archive-format.mjs',
      pluginSource({ settingsFields: ARCHIVE_SETTINGS })
    )
    h.ok('archive formats option exits 1', archiveResult.status === 1, output(archiveResult))
    h.ok(
      'archive formats option is named',
      /cbz/.test(output(archiveResult)),
      output(archiveResult)
    )

    const bareImportResult = runCheck(
      tempDir,
      'bare-import.mjs',
      pluginSource({
        imports: "import { createHash } from 'node:crypto'\nimport x from 'left-pad'"
      })
    )
    h.ok('bare npm import exits 1', bareImportResult.status === 1, output(bareImportResult))
    h.ok(
      'bare npm import is named',
      /left-pad/.test(output(bareImportResult)),
      output(bareImportResult)
    )

    const oversized = pluginSource() + `\n// ${'x'.repeat(MAX_BYTES)}\n`
    const oversizedResult = runCheck(tempDir, 'oversized.mjs', oversized)
    h.ok('bundle at or over 512 KiB exits 1', oversizedResult.status === 1, output(oversizedResult))
    h.ok(
      'bundle size violation names the 524288-byte limit',
      /524288/.test(output(oversizedResult)),
      output(oversizedResult)
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
