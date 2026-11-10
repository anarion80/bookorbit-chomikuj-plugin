#!/usr/bin/env node
/**
 * Built-plugin shape and safety check for BookOrbit indexers.
 *
 * Usage:
 *   node scripts/check-plugin.mjs [path]   (default: dist/index.mjs)
 *
 * The target is read once, imported through `pathToFileURL`, and checked
 * against the BookOrbit plugin contract plus the v0.1.0 safety rules. Every
 * violation is collected and reported in one run; the exit code is 1 when any
 * exist. Only Node built-ins are used, so the check itself adds no dependency
 * to the plugin bundle.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_BYTES = 524288
const TYPE_RE = /^[a-z0-9][a-z0-9-]{0,29}$/
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/
const FIELD_TYPES = new Set(['string', 'boolean', 'number'])
const RESERVED_TYPES = new Set(['torznab', 'newznab'])
const FORBIDDEN_FORMATS = new Set([
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'cbz',
  'cbr',
  'cb7',
  'cbt',
  'txt',
  'doc',
  'docx'
])
const IMPORT_PATTERNS = [
  /^[ \t]*import\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/gm,
  /^[ \t]*export\s+[^'"]*?\sfrom\s*['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
]

function isAllowedSpecifier(specifier) {
  return (
    specifier.startsWith('node:') ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('file:')
  )
}

function checkSourcePatterns(source, violations) {
  if (/globalThis\s*\.\s*fetch\s*\(/.test(source)) {
    violations.push(
      'source calls globalThis.fetch(); the plugin must use the host-provided fetch instead'
    )
  }

  if (/class\s+[A-Za-z_$][\w$]*\s+extends\s+Error\b/.test(source)) {
    violations.push(
      'source declares a custom class extending Error; use host.fail(...) errors instead'
    )
  }

  const specifiers = new Set()

  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }

  const bare = [...specifiers].filter((specifier) => !isAllowedSpecifier(specifier)).sort()

  for (const specifier of bare) {
    violations.push(
      `source has a bare dependency import ${JSON.stringify(specifier)}; only node: builtins and relative/absolute paths are allowed`
    )
  }
}

function checkSettingsFields(fields, violations) {
  if (!Array.isArray(fields)) {
    violations.push('settingsFields must be an array when present')
    return
  }

  fields.forEach((field, index) => {
    const label = `settingsFields[${index}]`

    if (field === null || typeof field !== 'object' || Array.isArray(field)) {
      violations.push(`${label} must be an object`)
      return
    }

    if (typeof field.key !== 'string' || !KEY_RE.test(field.key)) {
      violations.push(
        `${label}.key ${JSON.stringify(field.key)} must match ${KEY_RE} (a letter, then letters, digits, or underscores)`
      )
    }

    if (!FIELD_TYPES.has(field.type)) {
      violations.push(
        `${label}.type ${JSON.stringify(field.type)} must be one of "string", "boolean", or "number"`
      )
    }

    if (typeof field.label !== 'string' || field.label.trim() === '') {
      violations.push(`${label}.label must be a non-empty string`)
    }

    if (field.format === 'list' && field.type !== 'string') {
      violations.push(`${label}: format "list" is only allowed on a string field`)
    }

    if (field.options !== undefined) {
      if (field.format !== 'list') {
        violations.push(`${label}.options is only allowed when format is "list"`)
      } else if (
        !Array.isArray(field.options) ||
        field.options.length === 0 ||
        field.options.some((option) => typeof option !== 'string' || option.trim() === '')
      ) {
        violations.push(`${label}.options must be a non-empty array of strings`)
      }
    }

    if (field.minItems !== undefined) {
      if (field.options === undefined) {
        violations.push(`${label}.minItems requires options`)
      } else if (!Number.isInteger(field.minItems) || field.minItems < 1) {
        violations.push(`${label}.minItems must be a positive integer`)
      }
    }

    if (field.format === 'list' && field.default !== undefined && typeof field.default !== 'string') {
      violations.push(`${label}.default must be a string for a list field`)
    }

    if (field.format === 'list' && typeof field.default === 'string' && Array.isArray(field.options)) {
      const defaults = field.default
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      const unknown = defaults.filter((value) => !field.options.includes(value))

      if (unknown.length > 0) {
        violations.push(
          `${label}.default contains value(s) not present in options: ${unknown.join(', ')}`
        )
      }

      if (
        Number.isInteger(field.minItems) &&
        field.minItems > 0 &&
        defaults.length < field.minItems
      ) {
        violations.push(`${label}.default has fewer values than minItems`)
      }
    }

    if (Array.isArray(field.options)) {
      const forbidden = field.options
        .filter((option) => typeof option === 'string')
        .map((option) => option.trim().toLowerCase().replace(/^\./, ''))
        .filter((option) => FORBIDDEN_FORMATS.has(option))

      if (forbidden.length > 0) {
        violations.push(
          `${label} (${String(field.key)}) offers forbidden archive or unsupported format option(s): ${forbidden.join(', ')}`
        )
      }
    }
  })
}

function checkShape(plugin, violations) {
  if (plugin === null || typeof plugin !== 'object' || Array.isArray(plugin)) {
    violations.push('default export must be a plugin object')
    return
  }

  if (plugin.apiVersion !== 1) {
    violations.push(`apiVersion must be 1 (got ${JSON.stringify(plugin.apiVersion)})`)
  }

  if (typeof plugin.type !== 'string') {
    violations.push(`type must be a string (got ${JSON.stringify(plugin.type)})`)
  } else if (!TYPE_RE.test(plugin.type)) {
    violations.push(`type ${JSON.stringify(plugin.type)} must match ${TYPE_RE}`)
  } else if (RESERVED_TYPES.has(plugin.type)) {
    violations.push(`type must not be the reserved value ${JSON.stringify(plugin.type)}`)
  }

  if (typeof plugin.version !== 'string') {
    violations.push(`version must be a semver string (got ${JSON.stringify(plugin.version)})`)
  } else if (plugin.version.startsWith('v') || plugin.version.startsWith('V')) {
    violations.push(`version ${JSON.stringify(plugin.version)} must not have a leading "v"`)
  } else if (!SEMVER_RE.test(plugin.version)) {
    violations.push(`version ${JSON.stringify(plugin.version)} is not valid semver`)
  }

  if (typeof plugin.label !== 'string' || plugin.label.trim() === '') {
    violations.push('label must be a non-empty string')
  }

  for (const key of ['requiresCredential', 'usesCategories', 'seedsBack']) {
    if (typeof plugin[key] !== 'boolean') {
      violations.push(`${key} must be a boolean (got ${JSON.stringify(plugin[key])})`)
    }
  }

  if (!Array.isArray(plugin.mediaKinds) || plugin.mediaKinds.length === 0) {
    violations.push('mediaKinds must be a non-empty array')
  }

  if (typeof plugin.search !== 'function') {
    violations.push('search must be a function')
  }

  if (typeof plugin.test !== 'function') {
    violations.push('test must be a function')
  }

  const hasResolveFile = typeof plugin.resolveFile === 'function'
  const hasFetchTorrentFile = typeof plugin.fetchTorrentFile === 'function'

  if (hasResolveFile === hasFetchTorrentFile) {
    violations.push('exactly one of resolveFile or fetchTorrentFile must be a function')
  }

  if (plugin.settingsFields !== undefined) {
    checkSettingsFields(plugin.settingsFields, violations)
  }

  if (Object.hasOwn(plugin, 'update')) {
    violations.push('update block must be omitted in v0.1.0')
  }
}

function report(violations, display, size) {
  if (violations.length > 0) {
    for (const violation of violations) console.error(`check-plugin: ${violation}`)
    const count = violations.length
    console.error(`check-plugin: FAIL ${display} (${count} violation${count === 1 ? '' : 's'})`)
    return 1
  }

  console.log(`check-plugin: OK ${display} (${size} bytes)`)
  return 0
}

async function main() {
  const target = path.resolve(
    process.argv[2] ?? path.join(import.meta.dirname, '..', 'dist', 'index.mjs')
  )
  const display = path.relative(process.cwd(), target) || target
  const violations = []

  if (!existsSync(target)) {
    console.error(`check-plugin: ${display} does not exist; run "npm run build" first`)
    return 1
  }

  let source
  let size

  try {
    source = readFileSync(target, 'utf8')
    size = statSync(target).size
  } catch (error) {
    console.error(`check-plugin: cannot read ${display}: ${error?.message ?? String(error)}`)
    return 1
  }

  if (size >= MAX_BYTES) {
    violations.push(
      `${display} is ${size} bytes; BookOrbit rejects installs at or above ${MAX_BYTES} bytes (512 KiB)`
    )
  }

  checkSourcePatterns(source, violations)

  let module
  try {
    module = await import(pathToFileURL(target).href)
  } catch (error) {
    violations.push(`${display} failed to import: ${error?.message ?? String(error)}`)
    return report(violations, display, size)
  }

  checkShape(module.default, violations)

  return report(violations, display, size)
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error) => {
    console.error(error?.stack ?? String(error))
    process.exitCode = 1
  })
