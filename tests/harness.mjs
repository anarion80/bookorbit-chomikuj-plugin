/**
 * Offline test harness shared by every `tests/*.test.mjs` file.
 *
 * `createHarness()` returns a small assertion recorder plus the fixture and
 * host utilities the later plugin modules need. It uses only Node built-ins.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect, isDeepStrictEqual } from 'node:util'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(MODULE_DIR, '..')
export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures')

function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  return inspect(value, {
    depth: 6,
    breakLength: 100,
    sorted: true,
    compact: false,
    maxArrayLength: 50
  })
}

function formatExtra(extra) {
  return typeof extra === 'string' ? extra : formatValue(extra)
}

function indent(text, prefix = '  ') {
  return String(text)
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function describeDiff(actual, expected) {
  const lines = [`actual:   ${formatValue(actual)}`, `expected: ${formatValue(expected)}`]

  if (isPlainObject(actual) && isPlainObject(expected)) {
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort()
    const differing = keys.filter((key) => !isDeepStrictEqual(actual[key], expected[key]))
    if (differing.length > 0) lines.push(`differing keys: ${differing.join(', ')}`)
  } else if (Array.isArray(actual) && Array.isArray(expected) && actual.length !== expected.length) {
    lines.push(`lengths differ: actual ${actual.length}, expected ${expected.length}`)
  }

  return lines.join('\n')
}

function defaultBuildSearchText(query = {}) {
  const rawTitle = typeof query.title === 'string' ? query.title : ''
  const title = rawTitle.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const author = typeof query.author === 'string' ? query.author.replace(/\s+/g, ' ').trim() : ''
  return [title, author].filter(Boolean).join(' ')
}

function resolveFixturePath(fixturesDir, name) {
  const requested = String(name)
  const fullPath = path.resolve(fixturesDir, requested)
  const relative = path.relative(fixturesDir, fullPath)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Fixture name must stay inside fixtures/: ${requested}`)
  }

  return fullPath
}

function readFixtureRaw(fixturesDir, name) {
  const fullPath = resolveFixturePath(fixturesDir, name)

  try {
    return { fullPath, text: readFileSync(fullPath, 'utf8') }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Fixture not found: fixtures/${name} (looked in ${fullPath})`)
    }
    throw new Error(`Cannot read fixture fixtures/${name}: ${error.message}`)
  }
}

/**
 * @param {{ silent?: boolean, fixturesDir?: string }} [options]
 */
export function createHarness(options = {}) {
  const silent = options.silent === true
  const fixturesDir = options.fixturesDir ?? FIXTURES_DIR
  const results = []
  let passed = 0
  let failed = 0

  function emit(line) {
    if (!silent) console.log(line)
  }

  function record(name, condition, extra) {
    const pass = Boolean(condition)
    if (pass) passed += 1
    else failed += 1

    const result = { name: String(name), pass }
    if (extra !== undefined) result.extra = extra
    results.push(result)

    emit(`${pass ? 'PASS' : 'FAIL'} ${result.name}`)
    if (!pass && extra !== undefined) emit(indent(formatExtra(extra)))

    return pass
  }

  function ok(name, condition, extra) {
    return record(name, condition, extra)
  }

  function expectEqual(actual, expected, label = 'expectEqual') {
    if (isDeepStrictEqual(actual, expected)) return record(label, true)
    return record(label, false, describeDiff(actual, expected))
  }

  function readFixtureText(name) {
    return readFixtureRaw(fixturesDir, name).text
  }

  function loadFixture(name) {
    const { text } = readFixtureRaw(fixturesDir, name)

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`Fixture fixtures/${name} is not valid JSON: ${error.message}`)
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `Fixture fixtures/${name} must be a JSON object envelope { source, capturedAt, body }`
      )
    }

    if (!Object.hasOwn(parsed, 'body')) {
      throw new Error(
        `Fixture fixtures/${name} is missing the "body" field of its { source, capturedAt, body } envelope`
      )
    }

    return parsed.body
  }

  function createMockHost({ fetchImpl, logger, buildSearchText } = {}) {
    const fetchCalls = []
    const logs = []
    const savedCredentials = []

    function recordLog(level, message) {
      const entry = { level, message: String(message) }
      logs.push(entry)
      const target = logger?.[level]
      if (typeof target === 'function') target.call(logger, entry.message)
    }

    const mockLogger = {
      log: (message) => recordLog('log', message),
      warn: (message) => recordLog('warn', message),
      info: (message) => recordLog('info', message),
      debug: (message) => recordLog('debug', message),
      error: (message) => recordLog('error', message)
    }

    async function hostFetch(url, init) {
      fetchCalls.push({ url: String(url), init })
      if (typeof fetchImpl !== 'function') {
        throw new Error('createMockHost: pass { fetchImpl } before calling host.fetch()')
      }
      return fetchImpl(url, init)
    }

    async function saveCredential(credential) {
      savedCredentials.push(credential)
    }

    function fail(failure, message) {
      const error = new Error(message)
      error.failure = failure
      return error
    }

    return {
      fetch: hostFetch,
      logger: mockLogger,
      buildSearchText:
        typeof buildSearchText === 'function' ? buildSearchText : defaultBuildSearchText,
      saveCredential,
      fail,
      // Introspection helpers for assertions in later test files.
      fetchCalls,
      logs,
      savedCredentials
    }
  }

  function finish() {
    emit('')
    emit(`PASS ${passed}`)
    emit(`FAIL ${failed}`)
    return failed === 0 ? 0 : 1
  }

  return {
    ok,
    expectEqual,
    loadFixture,
    readFixtureText,
    createMockHost,
    finish,
    results,
    get passed() {
      return passed
    },
    get failed() {
      return failed
    }
  }
}
