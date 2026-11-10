/**
 * Fixture redaction and hygiene scan.
 *
 * Every captured fixture must be safe to commit: no real credentials, account
 * identifiers, cookies, authorization headers, tokens, or live Chomikuj hosts.
 * The scan reads `fixtures/` directly, walks each JSON body recursively, and
 * checks the Cloudflare challenge HTML. It is offline and uses Node built-ins.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const FIXTURES_DIR = path.resolve(import.meta.dirname, '..', 'fixtures')

export const testName = 'fixture redaction'

const REQUIRED_FIXTURES = [
  'login-ok.json',
  'account-free.json',
  'account-unlimited.json',
  'search-page1.json',
  'search-page2.json',
  'download-ok.json',
  'download-605.json',
  'download-604.json',
  'download-401.json',
  'error-429.json',
  'cf-challenge.html'
]

const SYNTHETIC_ACCOUNT_NAME = /^synthetic-/i
const SYNTHETIC_ACCOUNT_ID = /^900000\d+$/
const FORBIDDEN_HOST = /download\.chomikuj\.pl/i
const TOKEN_PARAM = /[?&]token=([^&\s"'<>#]*)/gi

function listJsonFixtures() {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
}

function walkEntries(value, visit, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkEntries(item, visit, [...trail, String(index)])
    })
    return
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childTrail = [...trail, key]
      visit(key, child, childTrail.join('.'))
      walkEntries(child, visit, childTrail)
    }
  }
}

function collectStrings(value, strings) {
  if (typeof value === 'string') {
    strings.push(value)
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectStrings(item, strings)
    })
    return
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      strings.push(key)
      collectStrings(child, strings)
    }
  }
}

function isSyntheticAccountValue(value) {
  if (value === '<redacted>') return true
  if (typeof value === 'number') return SYNTHETIC_ACCOUNT_ID.test(String(value))
  if (typeof value !== 'string') return false
  return SYNTHETIC_ACCOUNT_NAME.test(value) || SYNTHETIC_ACCOUNT_ID.test(value)
}

function tokenViolations(strings) {
  const violations = []

  for (const text of strings) {
    for (const match of text.matchAll(TOKEN_PARAM)) {
      if (match[1] !== 'redacted') violations.push(`${match[0]} in ${JSON.stringify(text)}`)
    }
  }

  return violations
}

function redactionViolations(body) {
  const violations = {
    apiKey: [],
    account: [],
    password: [],
    headers: [],
    fileUrl: []
  }

  walkEntries(body, (key, value, location) => {
    if (key === 'ApiKey') {
      const safe =
        value === '<redacted>' || (typeof value === 'string' && value.startsWith('synthetic-'))
      if (!safe) violations.apiKey.push(`${location}: ${JSON.stringify(value)}`)
    }

    if (key === 'AccountId' || key === 'AccountName') {
      if (!isSyntheticAccountValue(value)) {
        violations.account.push(`${location}: ${JSON.stringify(value)}`)
      }
    }

    if (key === 'Password') {
      if (value !== '<redacted>') violations.password.push(`${location}: ${JSON.stringify(value)}`)
    }

    if (key === 'Cookie' || key === 'Authorization') {
      if (value !== '<redacted>') violations.headers.push(`${location}: ${JSON.stringify(value)}`)
    }

    if (key === 'FileUrl') {
      const safe =
        value === '<redacted>' ||
        (typeof value === 'string' && value.includes('example.invalid'))
      const clean = typeof value !== 'string' || !value.includes('chomikuj.pl')
      if (!safe || !clean) violations.fileUrl.push(`${location}: ${JSON.stringify(value)}`)
    }
  })

  return violations
}

function assertFixture(h, name) {
  let text
  try {
    text = readFileSync(path.join(FIXTURES_DIR, name), 'utf8')
  } catch (error) {
    h.ok(`fixtures/${name} is readable`, false, error.message)
    return
  }

  let fixture
  try {
    fixture = JSON.parse(text)
  } catch (error) {
    h.ok(`fixtures/${name} parses as JSON`, false, error.message)
    return
  }
  h.ok(`fixtures/${name} parses as JSON`, true)

  h.ok(
    `fixtures/${name} source is synthetic or live`,
    fixture?.source === 'synthetic' || fixture?.source === 'live',
    `source: ${JSON.stringify(fixture?.source)}`
  )

  h.ok(
    `fixtures/${name} capturedAt is a valid date`,
    typeof fixture?.capturedAt === 'string' && !Number.isNaN(Date.parse(fixture.capturedAt)),
    `capturedAt: ${JSON.stringify(fixture?.capturedAt)}`
  )

  const body = fixture?.body
  const bodyIsObject = body !== null && typeof body === 'object'
  h.ok(`fixtures/${name} body is an object`, bodyIsObject, `body: ${typeof body}`)

  if (!bodyIsObject) return

  const violations = redactionViolations(body)
  h.ok(
    `fixtures/${name} ApiKey values are redacted or synthetic`,
    violations.apiKey.length === 0,
    violations.apiKey
  )
  h.ok(
    `fixtures/${name} AccountId/AccountName values are redacted or synthetic`,
    violations.account.length === 0,
    violations.account
  )
  h.ok(
    `fixtures/${name} Password values are redacted or absent`,
    violations.password.length === 0,
    violations.password
  )
  h.ok(
    `fixtures/${name} Cookie/Authorization values are redacted or absent`,
    violations.headers.length === 0,
    violations.headers
  )
  h.ok(
    `fixtures/${name} FileUrl values use example.invalid or are redacted`,
    violations.fileUrl.length === 0,
    violations.fileUrl
  )

  const strings = []
  collectStrings(body, strings)

  const hostViolations = strings.filter((value) => FORBIDDEN_HOST.test(value))
  h.ok(
    `fixtures/${name} has no download.chomikuj.pl strings`,
    hostViolations.length === 0,
    hostViolations
  )

  const badTokens = tokenViolations(strings)
  h.ok(
    `fixtures/${name} token query values are redacted`,
    badTokens.length === 0,
    badTokens
  )
}

function assertChallengePage(h) {
  let html
  try {
    html = readFileSync(path.join(FIXTURES_DIR, 'cf-challenge.html'), 'utf8')
  } catch (error) {
    h.ok('fixtures/cf-challenge.html is readable', false, error.message)
    return
  }

  h.ok(
    'fixtures/cf-challenge.html contains "Just a moment"',
    html.includes('Just a moment')
  )
  h.ok('fixtures/cf-challenge.html contains cf-chl-', html.includes('cf-chl-'))
  h.ok(
    'fixtures/cf-challenge.html contains /cdn-cgi/challenge-platform/',
    html.includes('/cdn-cgi/challenge-platform/')
  )
}

export default async function run(h) {
  for (const name of REQUIRED_FIXTURES) {
    let exists = true
    try {
      readFileSync(path.join(FIXTURES_DIR, name))
    } catch {
      exists = false
    }
    h.ok(`fixtures/${name} exists`, exists)
  }

  const jsonFixtures = listJsonFixtures()
  h.ok('fixtures/ contains JSON fixtures to scan', jsonFixtures.length > 0)

  for (const name of jsonFixtures) {
    assertFixture(h, name)
  }

  assertChallengePage(h)
}
