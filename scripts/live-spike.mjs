#!/usr/bin/env node
/**
 * BookOrbit Chomikuj plugin - Wave 0 live feasibility spike (owner-run).
 *
 * Purpose: prove that a FileUrl resolved from Chomikuj's mobile API can be
 * fetched by BookOrbit's fixed downloader headers:
 *   User-Agent: BookOrbit
 *   Range: bytes=0-1023
 *
 * This script is deliberately standalone (Node 24, ESM, no npm packages).
 * It is NOT part of the plugin; Todo 1 only.
 *
 * Usage:
 *   CHOMIKUJ_USERNAME=... CHOMIKUJ_PASSWORD=... node scripts/live-spike.mjs
 *   CHOMIKUJ_USERNAME=... CHOMIKUJ_PASSWORD=... \
 *     CHOMIKUJ_TEST_FILE_ID=123456 node scripts/live-spike.mjs
 *   node scripts/live-spike.mjs --self-test
 *
 * Exit codes:
 *   0  UA_GATE=PASS
 *   1  UA_GATE=FAIL or a network/API error
 *   2  CHOMIKUJ_USERNAME / CHOMIKUJ_PASSWORD missing (no network calls)
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const BASE_URL = 'https://mobile.chomikuj.pl/api/v3'
const API_USER_AGENT = 'android/3.8.4 (python; python)'
const BOOKORBIT_USER_AGENT = 'BookOrbit'
const SECRET = "wzrwYua$.DSe8suk!`'2"
const SEARCH_QUERY = 'Query=test&PageNumber=1&MediaType=Documents&Extension=pdf'

const EVIDENCE_DIR = join(ROOT, '.omo', 'evidence', 'bookorbit-chomikuj-plugin')
const EVIDENCE_FILE = join(EVIDENCE_DIR, 'live-spike.txt')
const FIXTURE_DIR = join(ROOT, 'fixtures', 'live')

const REDACTED = '<redacted>'
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

/**
 * Token = md5(PATH_WITHOUT_LEADING_SLASH + ('?' + query if query) + body + SECRET)
 * The caller must sign the exact query string that is put on the wire.
 */
function signToken(pathValue, query = '', body = '') {
  const normalizedPath = String(pathValue).replace(/^\/+/, '')
  const pathQuery = normalizedPath + (query ? `?${query}` : '')
  return createHash('md5').update(pathQuery + body + SECRET, 'utf8').digest('hex')
}

function expect(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function expectEqual(actual, expected, label = 'value') {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function expectMatch(text, regex, label = 'text') {
  if (!regex.test(String(text))) throw new Error(`${label}: did not match ${regex}`)
}

function checkEnvironment(env = process.env) {
  const username = typeof env.CHOMIKUJ_USERNAME === 'string' ? env.CHOMIKUJ_USERNAME.trim() : ''
  const password = typeof env.CHOMIKUJ_PASSWORD === 'string' ? env.CHOMIKUJ_PASSWORD : ''
  const testFileId = typeof env.CHOMIKUJ_TEST_FILE_ID === 'string' ? env.CHOMIKUJ_TEST_FILE_ID.trim() : ''

  const missing = []
  if (!username) missing.push('CHOMIKUJ_USERNAME')
  if (!password) missing.push('CHOMIKUJ_PASSWORD')

  if (missing.length > 0) {
    return {
      ok: false,
      exitCode: 2,
      message: [
        `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
        '',
        'This is the owner-run Wave 0 feasibility gate and needs a real Chomikuj account.',
        'It logs in, reads /account/info, resolves a free PDF, and checks that the',
        'returned FileUrl downloads with the fixed BookOrbit User-Agent.',
        '',
        'Run:',
        "  CHOMIKUJ_USERNAME='your-account' CHOMIKUJ_PASSWORD='your-password' node scripts/live-spike.mjs",
        '',
        'Optional: CHOMIKUJ_TEST_FILE_ID=<numeric file id> skips search and uses that file.',
        'Exit code 2 means no credentials were provided; no network requests were made.'
      ].join('\n')
    }
  }

  return { ok: true, username, password, testFileId }
}

const SENSITIVE_KEYS = new Set([
  'apikey',
  'accountid',
  'accountname',
  'password',
  'passwd',
  'cookie',
  'setcookie',
  'authorization',
  'email',
  'mail',
  'token',
  'session',
  'sessionid',
  'avatarurl',
  'fileurl',
  'url',
  'thumbnailimg',
  'smallthumbnailimg',
  'ownerid',
  'owneraccountid',
  'userid'
])

function isSensitiveKey(key, parentKey) {
  const normalized = String(key).toLowerCase().replace(/[-_]/g, '')
  if (SENSITIVE_KEYS.has(normalized)) return true
  if (String(parentKey).toLowerCase() === 'owner' && (normalized === 'id' || normalized === 'name')) {
    return true
  }
  return false
}

/** Replace known credential strings and any email addresses in free text. */
function sanitizeText(value, secrets = []) {
  let text = String(value)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      text = text.split(secret).join(REDACTED)
    }
  }
  return text.replace(EMAIL_RE, '<redacted-email>')
}

/** Recursively redact response bodies before they become fixtures. */
function redactValue(value, parentKey = '', secrets = []) {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, parentKey, secrets))
  }
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key, parentKey)) {
        out[key] = REDACTED
      } else {
        out[key] = redactValue(child, key, secrets)
      }
    }
    return out
  }
  if (typeof value === 'string') {
    return sanitizeText(value, secrets)
  }
  return value
}

function writeFixture(name, body, secrets = []) {
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const payload = {
    source: 'live',
    capturedAt: new Date().toISOString(),
    body: redactValue(body, '', secrets)
  }
  writeFileSync(join(FIXTURE_DIR, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function isSuccessCode(code) {
  return code === undefined || code === null || [0, 200, 201, '0', '200', '201'].includes(code)
}

function isCode(code, expected) {
  return String(code) === String(expected)
}

async function apiFetch(method, pathValue, query, bodyText, apiKey) {
  const normalizedPath = String(pathValue).replace(/^\/+/, '')
  const tokenPath = `api/v3/${normalizedPath}`
  const pathQuery = normalizedPath + (query ? `?${query}` : '')
  const url = `${BASE_URL}/${pathQuery}`

  const headers = {
    'User-Agent': API_USER_AGENT,
    Token: signToken(tokenPath, query, bodyText ?? '')
  }
  if (bodyText !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
  }
  if (apiKey) {
    headers['Api-Key'] = apiKey
  }

  return fetch(url, {
    method,
    headers,
    ...(bodyText !== undefined ? { body: bodyText } : {}),
    signal: AbortSignal.timeout(30_000)
  })
}

async function readJsonResponse(response, label) {
  const text = await response.text()
  const contentType = response.headers.get('content-type') ?? 'unknown'
  let payload
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${label}: HTTP ${response.status}, non-JSON response (${contentType})`)
  }

  if (!response.ok) {
    const code = payload?.Code !== undefined ? ` Code ${payload.Code}` : ''
    const message = payload?.Message ? `: ${payload.Message}` : ''
    throw new Error(`${label}: HTTP ${response.status}${code}${message}`)
  }

  return payload
}

function extractSearchResults(payload) {
  for (const key of ['Results', 'Files', 'FilesFolders', 'Items']) {
    if (Array.isArray(payload?.[key])) return payload[key]
  }
  return null
}

async function probeFileUrl(fileUrl) {
  let response
  try {
    response = await fetch(fileUrl, {
      headers: {
        'User-Agent': BOOKORBIT_USER_AGENT,
        Range: 'bytes=0-1023'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000)
    })
  } catch (error) {
    throw new Error(`request error: ${error.message}`)
  }

  const status = response.status
  const contentType = response.headers.get('content-type') ?? ''

  if (status !== 200 && status !== 206) {
    try {
      await response.body?.cancel()
    } catch {
      // ignore cleanup errors
    }
    throw new Error(`HTTP ${status}`)
  }

  if (contentType.toLowerCase().includes('html')) {
    try {
      await response.body?.cancel()
    } catch {
      // ignore cleanup errors
    }
    throw new Error(`HTML content-type "${contentType}"`)
  }

  let bytes = 0
  try {
    if (response.body) {
      const reader = response.body.getReader()
      const { value, done } = await reader.read()
      if (!done && value) bytes = value.byteLength
      try {
        await reader.cancel()
      } catch {
        // ignore cleanup errors
      }
    } else {
      const buffer = await response.arrayBuffer()
      bytes = buffer.byteLength
    }
  } catch (error) {
    throw new Error(`body read error: ${error.message}`)
  }

  if (bytes <= 0) {
    throw new Error('empty response body')
  }

  return { status, contentType: contentType || '(none)', bytes }
}

function renderStep(step, secrets) {
  const detail = step.detail ? `: ${sanitizeText(step.detail, secrets)}` : ''
  return `STEP ${step.name}: ${step.status}${detail}`
}

function emitResult({ steps, meta, secrets, gate, reason }) {
  const lines = [
    'BookOrbit Chomikuj live feasibility spike',
    `Captured: ${new Date().toISOString()}`,
    `Node: ${process.version}`,
    `Base URL: ${BASE_URL}`,
    `FileId: ${meta.fileId ?? '(none)'}`,
    `IsFileFreeForUser: ${meta.free === undefined ? '(unknown)' : meta.free}`,
    ''
  ]

  for (const step of steps) {
    lines.push(renderStep(step, secrets))
  }

  lines.push('')
  lines.push(gate === 'PASS' ? 'UA_GATE=PASS' : `UA_GATE=FAIL: ${sanitizeText(reason, secrets)}`)

  const text = `${lines.join('\n')}\n`
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(EVIDENCE_FILE, text, 'utf8')
  process.stdout.write(text)

  return gate === 'PASS' ? 0 : 1
}

async function runLive(input) {
  const steps = []
  const meta = { fileId: null, free: undefined }
  const secrets = [input.username, input.password]

  const fail = (stepName, detail, reason) => {
    steps.push({ name: stepName, status: 'FAIL', detail })
    return emitResult({ steps, meta, secrets, gate: 'FAIL', reason })
  }

  // Step 1: login. POST /account/login with a compact JSON body and no Api-Key.
  let loginPayload
  try {
    const body = JSON.stringify({ AccountName: input.username, Password: input.password })
    const response = await apiFetch('POST', 'account/login', '', body, null)
    loginPayload = await readJsonResponse(response, 'account/login')

    if (typeof loginPayload.ApiKey !== 'string' || loginPayload.ApiKey.length === 0) {
      const code = loginPayload.Code !== undefined ? ` (Code ${loginPayload.Code})` : ''
      const message = loginPayload.Message ? `: ${loginPayload.Message}` : ''
      throw new Error(`no ApiKey in response${code}${message}`)
    }

    // Register the session key as a secret before any fixture write or error
    // path can render server-provided free text such as Message.
    secrets.push(loginPayload.ApiKey)

    if (loginPayload.AccountId !== undefined && loginPayload.AccountId !== null) {
      secrets.push(String(loginPayload.AccountId))
    }
    if (loginPayload.AccountName) {
      secrets.push(String(loginPayload.AccountName))
    }

    writeFixture('login.json', loginPayload, secrets)
    steps.push({ name: 'login', status: 'PASS', detail: 'Api-Key received' })
  } catch (error) {
    return fail('login', error.message, `login failed: ${error.message}`)
  }

  const apiKey = loginPayload.ApiKey

  // Step 2: account info. GET /account/info with Api-Key.
  let accountPayload
  try {
    const response = await apiFetch('GET', 'account/info', '', undefined, apiKey)
    accountPayload = await readJsonResponse(response, 'account/info')

    if (!isSuccessCode(accountPayload.Code)) {
      const message = accountPayload.Message ? `: ${accountPayload.Message}` : ''
      throw new Error(`business Code ${accountPayload.Code}${message}`)
    }

    writeFixture('account-info.json', accountPayload, secrets)
  } catch (error) {
    return fail('account-info', error.message, `account/info failed: ${error.message}`)
  }

  const tier = accountPayload.HasUnlimitedTransfer === true ? 'unlimited' : 'free'
  const transfer = accountPayload.Transfer === undefined ? '?' : String(accountPayload.Transfer)
  steps.push({
    name: 'account-info',
    status: 'PASS',
    detail: `${tier}; HasUnlimitedTransfer=${String(accountPayload.HasUnlimitedTransfer)}; Transfer=${transfer}`
  })

  // Step 3: resolve a file. Either the owner-supplied id, or page 1 of the
  // exact Documents/PDF search, choosing an IsFileFreeForUser file.
  if (input.testFileId) {
    if (!/^\d+$/.test(input.testFileId)) {
      return fail(
        'search',
        'CHOMIKUJ_TEST_FILE_ID is not numeric',
        'CHOMIKUJ_TEST_FILE_ID must be a numeric file id'
      )
    }
    meta.fileId = input.testFileId
    steps.push({
      name: 'search',
      status: 'PASS',
      detail: `skipped; using CHOMIKUJ_TEST_FILE_ID=${input.testFileId}`
    })
  } else {
    let searchPayload
    try {
      const response = await apiFetch('GET', 'files/search', SEARCH_QUERY, undefined, apiKey)
      searchPayload = await readJsonResponse(response, 'files/search')

      if (!isSuccessCode(searchPayload.Code)) {
        const message = searchPayload.Message ? `: ${searchPayload.Message}` : ''
        throw new Error(`business Code ${searchPayload.Code}${message}`)
      }

      writeFixture('search-page1.json', searchPayload, secrets)
    } catch (error) {
      return fail('search', error.message, `files/search failed: ${error.message}`)
    }

    const results = extractSearchResults(searchPayload)
    if (!results) {
      return fail('search', 'response has no Results array', 'search response has no Results array')
    }

    const freeFile = results.find(
      (file) =>
        file &&
        file.IsFileFreeForUser === true &&
        /^\d+$/.test(String(file.FileId ?? ''))
    )

    if (!freeFile) {
      return fail(
        'search',
        `no file with IsFileFreeForUser === true among ${results.length} results`,
        'search found no free PDF'
      )
    }

    meta.fileId = String(freeFile.FileId)
    meta.free = true
    steps.push({
      name: 'search',
      status: 'PASS',
      detail: `selected FileId=${meta.fileId} with IsFileFreeForUser=true`
    })
  }

  // Step 4: files/download exactly once. Never retry this request.
  let downloadPayload
  try {
    const query = `FileId=${meta.fileId}`
    const response = await apiFetch('GET', 'files/download', query, undefined, apiKey)
    downloadPayload = await readJsonResponse(response, 'files/download')
  } catch (error) {
    return fail('download', error.message, `files/download failed: ${error.message}`)
  }

  if (isCode(downloadPayload.Code, 605)) {
    try {
      writeFixture('download-605.json', downloadPayload, secrets)
    } catch {
      // The gate reason is still the observed 605.
    }
    return fail('download', 'Code 605 (not enough transfer)', 'not enough transfer')
  }

  if (!isSuccessCode(downloadPayload.Code)) {
    const message = downloadPayload.Message ? `: ${downloadPayload.Message}` : ''
    const detail = `Code ${downloadPayload.Code}${message}`
    return fail('download', detail, `files/download failed: ${detail}`)
  }

  const fileUrl = typeof downloadPayload.FileUrl === 'string' ? downloadPayload.FileUrl.trim() : ''
  if (!fileUrl) {
    return fail('download', 'response has no FileUrl', 'files/download returned no FileUrl')
  }

  try {
    writeFixture('download-ok.json', downloadPayload, secrets)
  } catch (error) {
    return fail('download', `fixture write failed: ${error.message}`, `could not write download fixture: ${error.message}`)
  }

  steps.push({
    name: 'download',
    status: 'PASS',
    detail: `Code=${downloadPayload.Code ?? 0}; FileUrl received`
  })

  // Step 5: the actual gate. Fetch the pre-signed FileUrl with BookOrbit's
  // fixed headers. One GET, range limited to 1 KiB, no retry.
  try {
    const result = await probeFileUrl(fileUrl)
    steps.push({
      name: 'ua-gate',
      status: 'PASS',
      detail: `HTTP ${result.status}; content-type=${result.contentType}; bytes=${result.bytes}`
    })
  } catch (error) {
    return fail('ua-gate', error.message, `BookOrbit UA fetch failed: ${error.message}`)
  }

  return emitResult({ steps, meta, secrets, gate: 'PASS' })
}

const TOKEN_VECTORS = [
  {
    name: 'account/info (no query, no body)',
    path: 'api/v3/account/info',
    query: '',
    body: '',
    expected: '22dbb80e516477793934fa0add1b8929'
  },
  {
    name: 'files/search exact query string',
    path: 'api/v3/files/search',
    query: SEARCH_QUERY,
    body: '',
    expected: '83b420ec92a611e58b884b89e68ac530'
  },
  {
    name: 'files/download FileId query',
    path: 'api/v3/files/download',
    query: 'FileId=123456',
    body: '',
    expected: 'bfdebdece4cef4a17ebe44808ab4cda4'
  },
  {
    name: 'account/login compact JSON body',
    path: 'api/v3/account/login',
    query: '',
    body: '{"AccountName":"alice","Password":"p@ss"}',
    expected: '9f78082445ecf973cb41180065a0fc50'
  },
  {
    name: 'account/login Unicode body',
    path: 'api/v3/account/login',
    query: '',
    body: '{"AccountName":"żółć","Password":"päss"}',
    expected: '801e16c63c58dede556adfa87c78476e'
  }
]

function runSelfTest() {
  const results = []

  const check = (name, fn) => {
    try {
      fn()
      results.push({ name, ok: true })
      console.log(`SELF-TEST ${name}: PASS`)
    } catch (error) {
      results.push({ name, ok: false })
      console.log(`SELF-TEST ${name}: FAIL (${error.message})`)
    }
  }

  check('secret is the exact 20-character app constant', () => {
    expectEqual(SECRET.length, 20, 'secret length')
  })

  for (const vector of TOKEN_VECTORS) {
    check(`token ${vector.name}`, () => {
      expectEqual(signToken(vector.path, vector.query, vector.body), vector.expected, 'token')
    })
  }

  check('token strips one leading slash', () => {
    expectEqual(signToken('/api/v3/account/info'), TOKEN_VECTORS[0].expected, 'token')
  })

  check('redaction removes credentials and identifying account fields', () => {
    const fake = {
      ApiKey: 'FAKE_API_KEY_123',
      AccountId: 424242,
      AccountName: 'real-owner',
      Password: 'hunter2-secret',
      Cookie: 'session=abc',
      Authorization: 'Bearer zzz',
      Owner: { Id: 777, Name: 'owner-name' },
      User: { Email: 'someone@example.com' },
      FileUrl: 'https://example.test/file?sig=secret',
      Nested: { ApiKey: 'nested-key' }
    }

    const serialized = JSON.stringify(redactValue(fake))
    for (const leak of [
      'FAKE_API_KEY_123',
      '424242',
      'real-owner',
      'hunter2-secret',
      'session=abc',
      'Bearer zzz',
      '777',
      'owner-name',
      'someone@example.com',
      'https://example.test/file?sig=secret',
      'nested-key'
    ]) {
      expect(serialized.includes(leak) === false, `leaked ${leak}`)
    }
    expect(serialized.includes(REDACTED), 'redaction marker missing')
  })

  check('sanitizeText redacts an API key inside free text', () => {
    const key = 'FAKE_API_KEY_123'
    const text = sanitizeText(`boom ${key}`, [key])
    expect(text.includes(REDACTED), 'redaction marker missing')
    expect(text.includes(key) === false, 'API key leaked in free text')
  })

  check('no-env path returns exit code 2 without echoing values', () => {
    const missingBoth = checkEnvironment({})
    expectEqual(missingBoth.ok, false, 'missingBoth.ok')
    expectEqual(missingBoth.exitCode, 2, 'missingBoth.exitCode')
    expectMatch(missingBoth.message, /CHOMIKUJ_USERNAME/, 'missingBoth.message')
    expectMatch(missingBoth.message, /CHOMIKUJ_PASSWORD/, 'missingBoth.message')

    const missingPassword = checkEnvironment({ CHOMIKUJ_USERNAME: 'someone' })
    expectEqual(missingPassword.ok, false, 'missingPassword.ok')
    expectEqual(missingPassword.exitCode, 2, 'missingPassword.exitCode')
    expect(missingPassword.message.includes('someone') === false, 'no-env message echoed a value')
  })

  const failed = results.filter((result) => !result.ok).length
  const passed = results.length - failed
  console.log(`SELF-TEST: ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${results.length})`)
  return failed === 0 ? 0 : 1
}

async function main() {
  if (process.argv.includes('--self-test')) {
    process.exitCode = runSelfTest()
    return
  }

  const input = checkEnvironment(process.env)
  if (!input.ok) {
    console.error(input.message)
    process.exitCode = input.exitCode
    return
  }

  process.exitCode = await runLive(input)
}

await main()
