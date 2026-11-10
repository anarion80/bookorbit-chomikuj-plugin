#!/usr/bin/env node
/**
 * BookOrbit Chomikuj plugin - owner-run end-to-end live QA (plan Todo 23).
 *
 * Exercises the built plugin the way BookOrbit does:
 *   1. test         - login and account tier
 *   2. search       - a real query, up to 10 candidates
 *   3. free-preview - resolveFile on a file the owner marked free
 *   4. ua-gate      - fetch the resolved URL with BookOrbit's fixed headers
 *   5. no-spend     - allowTransferSpend=false must refuse a paid file before
 *                     any /files/download call
 *
 * Standalone Node 24 ESM with no npm dependencies. It imports dist/index.mjs
 * when the bundle exists and falls back to src/index.mjs for development.
 *
 * Usage:
 *   CHOMIKUJ_USERNAME=... CHOMIKUJ_PASSWORD=... node scripts/live-qa.mjs
 *   CHOMIKUJ_USERNAME=... CHOMIKUJ_PASSWORD=... \
 *     CHOMIKUJ_QUERY='some book' node scripts/live-qa.mjs
 *
 * Exit codes:
 *   0  LIVE_QA=PASS
 *   1  LIVE_QA=FAIL or an unexpected error
 *   2  CHOMIKUJ_USERNAME / CHOMIKUJ_PASSWORD missing (no network calls)
 *
 * The password is never printed or persisted. Console output and the evidence
 * file are redacted, and the live run writes only step results - never request
 * headers, response bodies, session keys, account ids, or URLs.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST_ENTRY = path.join(ROOT, 'dist', 'index.mjs')
const SRC_ENTRY = path.join(ROOT, 'src', 'index.mjs')
const EVIDENCE_DIR = path.join(ROOT, '.omo', 'evidence', 'bookorbit-chomikuj-plugin')
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, 'live-qa.txt')
const BASE_URL = 'https://mobile.chomikuj.pl'
const TIMEOUT_MS = 20_000
const DOWNLOAD_MARKER = '/files/download'
const REDACTED = '<redacted>'
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

/**
 * Read the owner-supplied credentials without ever echoing a supplied value.
 *
 * @param {Record<string, string|undefined>} [env]
 */
function checkEnvironment(env = process.env) {
  const username = typeof env.CHOMIKUJ_USERNAME === 'string' ? env.CHOMIKUJ_USERNAME.trim() : ''
  const password = typeof env.CHOMIKUJ_PASSWORD === 'string' ? env.CHOMIKUJ_PASSWORD : ''
  const rawQuery = typeof env.CHOMIKUJ_QUERY === 'string' ? env.CHOMIKUJ_QUERY.trim() : ''
  const query = rawQuery === '' ? 'test' : rawQuery
  const rawPaidFileId =
    typeof env.CHOMIKUJ_PAID_FILE_ID === 'string' ? env.CHOMIKUJ_PAID_FILE_ID.trim() : ''
  const paidFileId = rawPaidFileId === '' ? '' : rawPaidFileId

  if (paidFileId !== '' && !/^\d+$/.test(paidFileId)) {
    return {
      ok: false,
      exitCode: 1,
      message: [
        'CHOMIKUJ_PAID_FILE_ID must be a numeric Chomikuj FileId (digits only).',
        '',
        'It is optional. When set, the no-spend step probes that paid FileId so',
        'the refusal is deterministic even if the search returns no paid result.',
        'When unset, the script falls back to a synthetic id that is never sent to',
        '/files/download when the allowTransferSpend=false guard works.'
      ].join('\n')
    }
  }

  const missing = []
  if (username === '') missing.push('CHOMIKUJ_USERNAME')
  if (password === '') missing.push('CHOMIKUJ_PASSWORD')

  if (missing.length > 0) {
    return {
      ok: false,
      exitCode: 2,
      message: [
        `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
        '',
        'The live QA logs in to Chomikuj with a real account and performs the',
        'owner-run end-to-end check. It is not part of the offline suite.',
        '',
        'Run:',
        "  CHOMIKUJ_USERNAME='your-account' CHOMIKUJ_PASSWORD='your-password' node scripts/live-qa.mjs",
        '',
        'Optional: CHOMIKUJ_QUERY=<search text> (default: test). Choose a query',
        'whose results include both a free and a paid ebook.',
        'Optional: CHOMIKUJ_PAID_FILE_ID=<numeric FileId>. When set, the no-spend',
        'step probes this paid file, so the refusal is deterministic even when the',
        'search returns no paid result. When unset, a synthetic id is used instead;',
        'that id is never sent to /files/download when the spend guard works.',
        'Exit code 2 means no credentials were provided; no network calls were made.'
      ].join('\n')
    }
  }

  return { ok: true, username, password, query, paidFileId }
}

/**
 * Replace known credential strings and email addresses in free text.
 *
 * @param {Array<string|undefined|null>} secrets
 * @returns {(value: unknown) => string}
 */
function createRedactor(secrets) {
  const values = secrets
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length)

  return (value) => {
    let text = String(value ?? '')
    for (const secret of values) text = text.split(secret).join(REDACTED)
    return text.replace(EMAIL_RE, REDACTED)
  }
}

/**
 * Build the host BookOrbit would provide. The fetch wrapper counts every
 * `/files/download` request so the no-spend step can prove zero chargeable
 * calls, and `fail` returns a plain Error with `.failure` like the real host.
 *
 * @param {(value: unknown) => string} redact
 */
function createHost(redact) {
  const counters = { requests: 0, downloads: 0 }

  async function fetchImpl(url, init) {
    counters.requests += 1
    if (String(url).includes(DOWNLOAD_MARKER)) counters.downloads += 1
    return globalThis.fetch(url, init)
  }

  function fail(failure, message) {
    const error = new Error(redact(message ?? 'Chomikuj request failed'))
    error.failure = failure
    return error
  }

  return { fetch: fetchImpl, fail, counters }
}

/** Import the built bundle when present, otherwise the source entry point. */
async function loadPlugin() {
  const entry = existsSync(DIST_ENTRY) ? DIST_ENTRY : SRC_ENTRY
  const imported = await import(pathToFileURL(entry).href)
  const plugin = imported?.default

  for (const method of ['test', 'search', 'resolveFile']) {
    if (plugin === null || typeof plugin !== 'object' || typeof plugin[method] !== 'function') {
      throw new Error(`${path.relative(ROOT, entry)} does not export a plugin with ${method}()`)
    }
  }

  return { plugin, entry: path.relative(ROOT, entry) }
}

function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  const message =
    typeof error.message === 'string' && error.message.trim() !== ''
      ? error.message.trim()
      : String(error)
  return typeof error.failure === 'string' && error.failure !== ''
    ? `${error.failure}: ${message}`
    : message
}

function oneLine(text) {
  return String(text ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

/** Bound a promise that does not accept an AbortSignal of its own. */
function withTimeout(promise, ms, label) {
  const signal = AbortSignal.timeout(ms)
  const timeout = new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(signal.reason ?? new Error(`${label} timed out after ${ms} ms`)),
      { once: true }
    )
  })
  return Promise.race([promise, timeout])
}

async function cancelBody(response) {
  try {
    await response.body?.cancel()
  } catch {
    // Ignore cleanup errors; the step result is already decided.
  }
}

const PROBE_BYTES = 1024
const FILE_MAGICS = [
  { name: '%PDF', bytes: [0x25, 0x50, 0x44, 0x46] },
  { name: 'PK', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'BOOKMOBI', bytes: [0x42, 0x4f, 0x4f, 0x4b, 0x4d, 0x4f, 0x42, 0x49] },
  { name: 'OLE2', bytes: [0xd0, 0xcf, 0x11, 0xe0] }
]

/** Does the leading chunk start with a known ebook file magic? */
function hasFileMagic(chunk) {
  return FILE_MAGICS.some((magic) => {
    if (chunk.length < magic.bytes.length) return false
    return magic.bytes.every((byte, index) => chunk[index] === byte)
  })
}

/** Short, credential-free body excerpt for an HTML failure message. */
function htmlExcerpt(chunk) {
  const text = new TextDecoder('utf-8', { fatal: false })
    .decode(chunk)
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 200 ? `${text.slice(0, 200)}...` : text
}

/** Extract `<title>` text from an HTML body when present. */
function htmlTitle(chunk) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(chunk)
  const match = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return ''
  return match[1].replace(/\s+/g, ' ').trim().slice(0, 120)
}

/**
 * Fetch the resolved file with the real BookOrbit initial download shape: a
 * plain GET with the `User-Agent: BookOrbit` and any-content-type `Accept`
 * headers, and no Range header. The Range probe is intentionally not used
 * because Chomikuj mislabels 206 responses as `text/html` even when the body
 * is the ebook file.
 *
 * Only the first chunk (up to 1024 bytes) is read. The probe passes when bytes
 * were read and either the content-type is not HTML or the body begins with a
 * known ebook magic number.
 */
async function probeFileUrl(url) {
  let response
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'BookOrbit',
        Accept: '*/*'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (error) {
    throw new Error(`request error: ${error?.message ?? String(error)}`)
  }

  const status = response.status
  const contentType = response.headers.get('content-type') ?? ''

  if (status !== 200 && status !== 206) {
    await cancelBody(response)
    throw new Error(`HTTP ${status}`)
  }

  let chunk
  try {
    if (response.body) {
      const reader = response.body.getReader()
      const { value, done } = await reader.read()
      chunk = !done && value ? value.subarray(0, PROBE_BYTES) : new Uint8Array(0)
      try {
        await reader.cancel()
      } catch {
        // Ignore cleanup errors.
      }
    } else {
      const buffer = new Uint8Array(await response.arrayBuffer())
      chunk = buffer.subarray(0, PROBE_BYTES)
    }
  } catch (error) {
    throw new Error(`body read error: ${error?.message ?? String(error)}`)
  }

  const bytes = chunk.byteLength
  if (bytes <= 0) throw new Error('empty response body')

  const isHtml = contentType.toLowerCase().includes('html')
  const magic = hasFileMagic(chunk)
  if (isHtml && !magic) {
    const title = htmlTitle(chunk)
    const excerpt = htmlExcerpt(chunk)
    throw new Error(
      [
        `HTML response: HTTP ${status}`,
        `content-type="${contentType || '(none)'}"`,
        title === '' ? '' : `title="${title}"`,
        excerpt === '' ? '' : `body="${excerpt}"`
      ]
        .filter((part) => part !== '')
        .join('; ')
    )
  }

  return { status, contentType: contentType || '(none)', bytes }
}

/** Assert the BookOrbit download descriptor has the fields BookOrbit needs. */
function assertDescriptor(descriptor) {
  const url = typeof descriptor?.url === 'string' ? descriptor.url.trim() : ''
  const fileName = typeof descriptor?.fileName === 'string' ? descriptor.fileName.trim() : ''
  const format = typeof descriptor?.format === 'string' ? descriptor.format.trim() : ''

  if (url === '') throw new Error('descriptor.url is empty')
  if (fileName === '') throw new Error('descriptor.fileName is empty')
  if (format === '') throw new Error('descriptor.format is empty')

  return { url, fileName, format }
}

function candidatePreview(candidates) {
  return candidates.slice(0, 3).map((candidate) => ({
    title: candidate?.title,
    format: candidate?.format,
    sizeBytes: candidate?.sizeBytes
  }))
}

/**
 * Pick the smallest paid candidate so a regression in the no-spend guard has
 * the least possible transfer cost. Returns undefined when no paid row exists.
 */
function pickPaidCandidate(candidates) {
  const paid = candidates.filter((candidate) => candidate?.freeleech !== true)
  if (paid.length === 0) return undefined

  return paid.reduce((smallest, candidate) => {
    const size = Number(candidate?.sizeBytes)
    const smallestSize = Number(smallest?.sizeBytes)
    if (!Number.isFinite(size) || size <= 0) return smallest
    if (!Number.isFinite(smallestSize) || smallestSize <= 0) return candidate
    return size < smallestSize ? candidate : smallest
  })
}

async function runLive(input) {
  const redact = createRedactor([input.password, input.username])
  const steps = []
  let failureReason = null
  let plugin = null
  let entry = '(not loaded)'

  function record(name, status, detail = '') {
    const text = oneLine(detail)
    steps.push({ name, status, detail: text })
    const suffix = text === '' ? '' : `: ${redact(text)}`
    console.log(`STEP ${name}: ${status}${suffix}`)
  }

  function pass(name, detail) {
    record(name, 'PASS', detail)
  }

  function fail(name, detail) {
    record(name, 'FAIL', detail)
    failureReason = oneLine(detail)
    return false
  }

  function finish() {
    const passed = failureReason === null
    const lines = [
      'BookOrbit Chomikuj live QA',
      `Captured: ${new Date().toISOString()}`,
      `Node: ${process.version}`,
      `Plugin: ${entry}`,
      `Query: ${redact(input.query)}`,
      ''
    ]

    for (const step of steps) {
      const suffix = step.detail === '' ? '' : `: ${redact(step.detail)}`
      lines.push(`STEP ${step.name}: ${step.status}${suffix}`)
    }

    lines.push('')
    lines.push(passed ? 'LIVE_QA=PASS' : `LIVE_QA=FAIL: ${redact(failureReason)}`)
    lines.push('')

    const text = lines.join('\n')
    try {
      mkdirSync(EVIDENCE_DIR, { recursive: true })
      writeFileSync(EVIDENCE_FILE, text, 'utf8')
    } catch (error) {
      console.error(
        `live-qa: could not write ${EVIDENCE_FILE}: ${redact(error?.message ?? error)}`
      )
      return 1
    }

    console.log('')
    console.log(passed ? 'LIVE_QA=PASS' : `LIVE_QA=FAIL: ${redact(failureReason)}`)
    return passed ? 0 : 1
  }

  // The bundle is the artifact BookOrbit installs; src is a dev fallback.
  try {
    const loaded = await loadPlugin()
    plugin = loaded.plugin
    entry = loaded.entry
  } catch (error) {
    fail('load', describeError(error))
    return finish()
  }

  const host = createHost(redact)
  const config = {
    id: 'live-qa',
    baseUrl: BASE_URL,
    credential: input.password,
    settings: {
      username: input.username,
      allowTransferSpend: true,
      formats: 'epub,mobi,pdf'
    }
  }

  // --- test ---------------------------------------------------------------
  let indexerName = ''
  try {
    const result = await withTimeout(plugin.test(config, host), TIMEOUT_MS, 'test')
    if (result?.success !== true) {
      fail('test', `success was not true: ${result?.error ?? 'no error message'}`)
      return finish()
    }
    indexerName = typeof result.indexerName === 'string' ? result.indexerName : '(none)'
    pass('test', `success=true; indexerName=${indexerName}`)
  } catch (error) {
    fail('test', describeError(error))
    return finish()
  }

  // --- search -------------------------------------------------------------
  let candidates
  try {
    candidates = await plugin.search(
      { title: input.query, limit: 10 },
      config,
      host,
      AbortSignal.timeout(TIMEOUT_MS)
    )
  } catch (error) {
    fail('search', describeError(error))
    return finish()
  }

  if (!Array.isArray(candidates)) {
    fail('search', 'search did not return an array')
    return finish()
  }

  if (candidates.length === 0) {
    fail(
      'search',
      `no candidates for query ${JSON.stringify(input.query)}; set CHOMIKUJ_QUERY to a query whose results include free and paid ebooks`
    )
    return finish()
  }

  pass(
    'search',
    `${candidates.length} candidate(s); first=${JSON.stringify(candidatePreview(candidates))}`
  )

  // --- free preview -------------------------------------------------------
  const freeCandidate = candidates.find((candidate) => candidate?.freeleech === true)
  if (freeCandidate === undefined) {
    fail(
      'free-preview',
      `no free candidate (freeleech === true) among ${candidates.length}; set CHOMIKUJ_QUERY to a query whose results include a free ebook`
    )
    return finish()
  }

  let freeDescriptor
  try {
    const resolved = await plugin.resolveFile(
      freeCandidate,
      config,
      host,
      AbortSignal.timeout(TIMEOUT_MS)
    )
    freeDescriptor = assertDescriptor(resolved)
  } catch (error) {
    fail('free-preview', describeError(error))
    return finish()
  }

  pass(
    'free-preview',
    `url=present; fileName=${freeDescriptor.fileName}; format=${freeDescriptor.format}; downloadCalls=${host.counters.downloads}`
  )

  // --- BookOrbit UA gate --------------------------------------------------
  try {
    const probe = await probeFileUrl(freeDescriptor.url)
    pass('ua-gate', `HTTP ${probe.status}; content-type=${probe.contentType}; bytes=${probe.bytes}`)
  } catch (error) {
    fail('ua-gate', describeError(error))
    return finish()
  }

  // --- no-spend refusal ---------------------------------------------------
  // An unlimited account legitimately allows paid files even with spend off,
  // so running the refusal probe would issue a chargeable request. Stop before
  // touching /files/download and tell the owner to use a free/test account.
  if (/unlimited/i.test(indexerName)) {
    fail(
      'no-spend',
      'account reports unlimited transfer, so paid files are allowed; re-run the paid-spend check with a free/test account'
    )
    return finish()
  }

  let paidCandidate = pickPaidCandidate(candidates)
  let paidSource = 'search'
  if (paidCandidate !== undefined) {
    paidSource = 'search'
  } else if (typeof input.paidFileId === 'string' && input.paidFileId !== '') {
    paidCandidate = {
      guid: input.paidFileId,
      title: 'chomikuj paid probe',
      bookTitle: 'chomikuj paid probe',
      format: 'pdf',
      sizeBytes: null,
      freeleech: false
    }
    paidSource = 'env'
  } else {
    paidCandidate = {
      guid: '1',
      title: 'chomikuj paid probe',
      bookTitle: 'chomikuj paid probe',
      format: 'pdf',
      sizeBytes: null,
      freeleech: false
    }
    paidSource = 'synthetic'
  }

  config.settings.allowTransferSpend = false
  host.counters.downloads = 0

  let refusal = null
  try {
    await plugin.resolveFile(paidCandidate, config, host, AbortSignal.timeout(TIMEOUT_MS))
  } catch (error) {
    refusal = error
  }

  if (refusal === null) {
    fail(
      'no-spend',
      `resolveFile resolved a paid file (paidSource=${paidSource}) with allowTransferSpend=false; expected a refusal before /files/download`
    )
    return finish()
  }

  if (refusal.failure !== 'error') {
    fail(
      'no-spend',
      `paidSource=${paidSource}; refusal.failure was ${JSON.stringify(refusal.failure)}, expected "error": ${describeError(refusal)}`
    )
    return finish()
  }

  if (!/disabled|spending|spend|transfer/i.test(describeError(refusal))) {
    fail(
      'no-spend',
      `paidSource=${paidSource}; refusal message does not mention disabled spending or transfer: ${describeError(refusal)}`
    )
    return finish()
  }

  if (host.counters.downloads !== 0) {
    fail(
      'no-spend',
      `paidSource=${paidSource}; expected zero /files/download calls, observed ${host.counters.downloads}`
    )
    return finish()
  }

  pass(
    'no-spend',
    `paidSource=${paidSource}; failure=error; message mentions disabled spending; /files/download calls=0`
  )

  return finish()
}

async function main() {
  const input = checkEnvironment(process.env)
  if (!input.ok) {
    console.error(input.message)
    process.exitCode = input.exitCode
    return
  }

  process.exitCode = await runLive(input)
}

await main()
