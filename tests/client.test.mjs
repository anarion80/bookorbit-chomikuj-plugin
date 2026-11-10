/**
 * Tests for the Chomikuj mobile API client.
 *
 * Every request is served by a scripted fake `fetchImpl`, so the assertions
 * pin the exact wire URL, method, body, headers, and request token. The retry
 * cases use the real 500 ms delay to prove the client retries exactly once and
 * never turns a permanent failure into a retry storm.
 */

import { createClient } from '../src/lib/client.mjs'
import { signToken } from '../src/lib/token.mjs'

// Optional; `verify.mjs --only` matches this as well as the filename.
export const testName = 'client'

const BASE_URL = 'https://mobile.chomikuj.pl/api/v3'
const USER_AGENT = 'android/3.8.4 (python; python)'
const API_KEY = 'synthetic-api-key-0000-0000-0000-000000000000'

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  })
}

function htmlResponse(text, { status = 200, headers = {} } = {}) {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers }
  })
}

function createFakeFetch(responses) {
  const queue = [...responses]
  const calls = []

  async function fetchImpl(url, init) {
    calls.push({ url: String(url), init })
    if (queue.length === 0) {
      throw new Error(`unexpected fetch call #${calls.length} to ${url}`)
    }
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next
  }

  return { fetchImpl, calls }
}

async function capture(promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

export default async function run(h) {
  // --- login: exact URL, body, headers, and no Api-Key --------------------
  {
    const body = h.loadFixture('login-ok.json')
    const { fetchImpl, calls } = createFakeFetch([jsonResponse(body)])
    const client = createClient({ fetchImpl })
    const payload = await client.login('alice', 'p@ss')

    h.expectEqual(calls.length, 1, 'login: exactly one fetch call')
    h.expectEqual(calls[0].url, `${BASE_URL}/account/login`, 'login: exact URL')
    h.expectEqual(calls[0].init.method, 'POST', 'login: method is POST')

    const expectedBody = JSON.stringify({ AccountName: 'alice', Password: 'p@ss' })
    h.expectEqual(calls[0].init.body, expectedBody, 'login: exact compact JSON body')

    const headers = calls[0].init.headers
    h.expectEqual(
      headers['Content-Type'],
      'application/json; charset=utf-8',
      'login: JSON content type with charset'
    )
    h.expectEqual(headers['User-Agent'], USER_AGENT, 'login: static mobile User-Agent')
    h.expectEqual(
      headers.Token,
      signToken('account/login', '', expectedBody),
      'login: token signs the request body'
    )
    h.ok(!Object.hasOwn(headers, 'Api-Key'), 'login: no Api-Key header')
    h.expectEqual(payload, body, 'login: returns the parsed payload')
  }

  // --- accountInfo: exact URL, token, and Api-Key -------------------------
  {
    const body = h.loadFixture('account-free.json')
    const { fetchImpl, calls } = createFakeFetch([jsonResponse(body)])
    const client = createClient({ fetchImpl })
    const payload = await client.accountInfo(API_KEY)

    h.expectEqual(calls.length, 1, 'accountInfo: exactly one fetch call')
    h.expectEqual(calls[0].url, `${BASE_URL}/account/info`, 'accountInfo: exact URL')
    h.expectEqual(calls[0].init.method, 'GET', 'accountInfo: method is GET')
    h.expectEqual(calls[0].init.body, undefined, 'accountInfo: no request body')

    const headers = calls[0].init.headers
    h.expectEqual(headers['User-Agent'], USER_AGENT, 'accountInfo: static mobile User-Agent')
    h.expectEqual(
      headers.Token,
      signToken('account/info', '', ''),
      'accountInfo: token for the empty query and body'
    )
    h.expectEqual(headers['Api-Key'], API_KEY, 'accountInfo: sends Api-Key')
    h.expectEqual(payload, body, 'accountInfo: returns the parsed payload')
  }

  // --- baseUrl accepts the manifest host or the full /api/v3 base ---------
  {
    const body = h.loadFixture('account-free.json')
    const baseUrls = [
      'https://mobile.chomikuj.pl',
      'https://mobile.chomikuj.pl/api/v3'
    ]

    for (const baseUrl of baseUrls) {
      const { fetchImpl, calls } = createFakeFetch([jsonResponse(body)])
      const client = createClient({ baseUrl, fetchImpl })
      const payload = await client.accountInfo(API_KEY)

      h.expectEqual(
        calls[0].url,
        `${BASE_URL}/account/info`,
        `baseUrl normalization: ${baseUrl}`
      )
      h.expectEqual(payload, body, `baseUrl normalization payload: ${baseUrl}`)
    }
  }

  // --- accountInfo rejects a non-success business Code --------------------
  {
    const { fetchImpl, calls } = createFakeFetch([
      jsonResponse({ Code: 605, Message: 'Not enough transfer' })
    ])
    const client = createClient({ fetchImpl })
    const error = await capture(client.accountInfo(API_KEY))

    h.expectEqual(calls.length, 1, 'accountInfo: 605 business error makes one fetch call')
    h.expectEqual(error?.failure, 'error', 'accountInfo: 605 throws error')
    h.expectEqual(error?.retryable, false, 'accountInfo: 605 is non-retryable')
    h.expectEqual(error?.status, 200, 'accountInfo: 605 keeps the HTTP status')
    h.expectEqual(error?.code, 605, 'accountInfo: 605 keeps the business code')
  }

  // --- searchPage: query-string order, signing, and Extension ellipsis -----
  {
    const body = h.loadFixture('search-page1.json')
    const { fetchImpl, calls } = createFakeFetch([jsonResponse(body), jsonResponse(body)])
    const client = createClient({ fetchImpl })

    const first = await client.searchPage(API_KEY, {
      query: 'test',
      page: 1,
      extension: 'pdf'
    })
    const second = await client.searchPage(API_KEY, {
      query: 'test',
      page: 2,
      extension: ''
    })

    h.expectEqual(calls.length, 2, 'searchPage: one fetch call per page')

    const firstUrl = `${BASE_URL}/files/search?Query=test&PageNumber=1&MediaType=Documents&Extension=pdf`
    const secondUrl = `${BASE_URL}/files/search?Query=test&PageNumber=2&MediaType=Documents`

    h.expectEqual(calls[0].url, firstUrl, 'searchPage: exact URL with Extension')
    h.expectEqual(calls[1].url, secondUrl, 'searchPage: omits an empty Extension')

    const firstQuery = new URL(calls[0].url).search.slice(1)
    const secondQuery = new URL(calls[1].url).search.slice(1)

    h.expectEqual(
      calls[0].init.headers.Token,
      signToken('files/search', firstQuery, ''),
      'searchPage: token signs the observed wire query string'
    )
    h.expectEqual(
      calls[0].init.headers.Token,
      '7d6a667a66f8a2666afe58dc8db6fcc4',
      'searchPage: token matches the known-answer vector'
    )
    h.expectEqual(
      calls[1].init.headers.Token,
      signToken('files/search', secondQuery, ''),
      'searchPage: token tracks the Extension-less query string'
    )
    h.expectEqual(calls[0].init.headers['Api-Key'], API_KEY, 'searchPage: sends Api-Key')
    h.expectEqual(
      calls[0].init.headers['User-Agent'],
      USER_AGENT,
      'searchPage: static mobile User-Agent'
    )
    h.expectEqual(first, body, 'searchPage: returns the parsed payload')
    h.expectEqual(second, body, 'searchPage: returns the second parsed payload')
  }

  // --- retry once on 429 for accountInfo ----------------------------------
  {
    const account = h.loadFixture('account-free.json')
    const { fetchImpl, calls } = createFakeFetch([
      jsonResponse(h.loadFixture('error-429.json'), { status: 429 }),
      jsonResponse(account)
    ])
    const client = createClient({ fetchImpl })
    const payload = await client.accountInfo(API_KEY)

    h.expectEqual(calls.length, 2, 'accountInfo: retries exactly once on 429')
    h.expectEqual(calls[0].url, calls[1].url, 'accountInfo: retry reuses the exact URL')
    h.expectEqual(
      calls[0].init.headers.Token,
      calls[1].init.headers.Token,
      'accountInfo: retry reuses the exact token'
    )
    h.expectEqual(payload, account, 'accountInfo: retry returns the successful payload')
  }

  // --- retry once on 5xx for searchPage ------------------------------------
  {
    const search = h.loadFixture('search-page1.json')
    const { fetchImpl, calls } = createFakeFetch([
      jsonResponse({ Message: 'unavailable' }, { status: 503 }),
      jsonResponse(search)
    ])
    const client = createClient({ fetchImpl })
    const payload = await client.searchPage(API_KEY, { query: 'test', page: 1 })

    h.expectEqual(calls.length, 2, 'searchPage: retries exactly once on 503')
    h.expectEqual(
      calls[0].url,
      calls[1].url,
      'searchPage: retry reuses the exact URL and query string'
    )
    h.expectEqual(payload, search, 'searchPage: retry returns the successful payload')
  }

  // --- Retry-After over the two-second budget blocks the retry ------------
  {
    const { fetchImpl, calls } = createFakeFetch([
      jsonResponse(h.loadFixture('error-429.json'), {
        status: 429,
        headers: { 'retry-after': '5' }
      })
    ])
    const client = createClient({ fetchImpl })
    const error = await capture(client.accountInfo(API_KEY))

    h.expectEqual(calls.length, 1, 'accountInfo: Retry-After over 2s blocks the retry')
    h.expectEqual(error?.failure, 'throttled', 'accountInfo: 429 throws throttled')
    h.expectEqual(error?.retryable, true, 'accountInfo: throttled is retryable')
    h.expectEqual(error?.status, 429, 'accountInfo: error carries the HTTP status')
    h.ok(
      error instanceof Error && error.constructor === Error,
      'accountInfo: throws a plain Error, not a custom subclass'
    )
  }

  // --- an aborted signal blocks the retry ---------------------------------
  {
    const controller = new AbortController()
    controller.abort()

    const { fetchImpl, calls } = createFakeFetch([
      jsonResponse(h.loadFixture('error-429.json'), { status: 429 })
    ])
    const client = createClient({ fetchImpl })
    const error = await capture(
      client.searchPage(API_KEY, { query: 'test', page: 1, signal: controller.signal })
    )

    h.expectEqual(calls.length, 1, 'searchPage: an aborted signal blocks the retry')
    h.expectEqual(error?.failure, 'throttled', 'searchPage: abort keeps the 429 classification')
  }

  // --- 401 is unauthorized and is never retried ---------------------------
  {
    const { fetchImpl, calls } = createFakeFetch([
      jsonResponse(h.loadFixture('download-401.json'), { status: 401 })
    ])
    const client = createClient({ fetchImpl })
    const error = await capture(client.accountInfo(API_KEY))

    h.expectEqual(calls.length, 1, 'accountInfo: 401 is never retried')
    h.expectEqual(error?.failure, 'unauthorized', 'accountInfo: 401 throws unauthorized')
    h.expectEqual(error?.retryable, false, 'accountInfo: unauthorized is not retryable')
    h.expectEqual(error?.status, 401, 'accountInfo: 401 error carries the status')
    h.expectEqual(error?.code, 0, 'accountInfo: 401 error keeps the business Code')
  }

  // --- Cloudflare challenge is unreachable and is not retried -------------
  {
    const challenge = h.readFixtureText('cf-challenge.html')

    const account = createFakeFetch([htmlResponse(challenge)])
    const accountClient = createClient({ fetchImpl: account.fetchImpl })
    const accountError = await capture(accountClient.accountInfo(API_KEY))

    h.expectEqual(account.calls.length, 1, 'accountInfo: Cloudflare is not retried')
    h.expectEqual(
      accountError?.failure,
      'unreachable',
      'accountInfo: Cloudflare throws unreachable'
    )
    h.ok(
      accountError?.message.toLowerCase().includes('cloudflare'),
      'accountInfo: Cloudflare message names the challenge',
      accountError?.message
    )

    const login = createFakeFetch([htmlResponse(challenge)])
    const loginClient = createClient({ fetchImpl: login.fetchImpl })
    const loginError = await capture(loginClient.login('alice', 'secret'))

    h.expectEqual(login.calls.length, 1, 'login: Cloudflare is not retried')
    h.expectEqual(loginError?.failure, 'unreachable', 'login: Cloudflare throws unreachable')
  }

  // --- login never retries on 429 -----------------------------------------
  {
    const { fetchImpl, calls } = createFakeFetch([
      jsonResponse(h.loadFixture('error-429.json'), { status: 429 })
    ])
    const client = createClient({ fetchImpl })
    const error = await capture(client.login('alice', 'secret'))

    h.expectEqual(calls.length, 1, 'login: 429 is never retried')
    h.expectEqual(error?.failure, 'throttled', 'login: 429 throws throttled')
    h.expectEqual(error?.retryable, true, 'login: 429 is marked retryable for the caller')
    h.expectEqual(error?.status, 429, 'login: 429 error carries the status')
  }

  // --- downloadUrl never retries on 429 -----------------------------------
  {
    const { fetchImpl, calls } = createFakeFetch([
      jsonResponse(h.loadFixture('error-429.json'), {
        status: 429,
        headers: { 'retry-after': '0' }
      })
    ])
    const client = createClient({ fetchImpl })
    const error = await capture(client.downloadUrl(API_KEY, 200000001))

    h.expectEqual(calls.length, 1, 'downloadUrl: 429 is never retried')
    h.expectEqual(error?.failure, 'throttled', 'downloadUrl: 429 throws throttled')
  }

  // --- download 605: permanent quota error, one request only --------------
  {
    const { fetchImpl, calls } = createFakeFetch([
      jsonResponse(h.loadFixture('download-605.json'))
    ])
    const client = createClient({ fetchImpl })
    const error = await capture(client.downloadUrl(API_KEY, 200000001))

    h.expectEqual(calls.length, 1, 'downloadUrl: 605 makes exactly one fetch call')
    h.expectEqual(error?.failure, 'error', 'downloadUrl: 605 throws error')
    h.expectEqual(error?.retryable, false, 'downloadUrl: 605 is non-retryable')
    h.ok(
      error?.message.toLowerCase().includes('not enough transfer'),
      'downloadUrl: 605 message mentions not enough transfer',
      error?.message
    )
    h.expectEqual(error?.status, 200, 'downloadUrl: 605 keeps the HTTP status')
    h.expectEqual(error?.code, 605, 'downloadUrl: 605 keeps the business code')
    h.expectEqual(
      calls[0].url,
      `${BASE_URL}/files/download?FileId=200000001`,
      'downloadUrl: 605 request URL'
    )
    h.expectEqual(
      calls[0].init.headers.Token,
      signToken('files/download', 'FileId=200000001', ''),
      'downloadUrl: token signs the FileId query'
    )
    h.ok(
      error instanceof Error && error.constructor === Error,
      'downloadUrl: 605 throws a plain Error'
    )
  }

  // --- download success returns the parsed payload with FileUrl -----------
  {
    const body = h.loadFixture('download-ok.json')
    const { fetchImpl, calls } = createFakeFetch([jsonResponse(body)])
    const client = createClient({ fetchImpl })
    const payload = await client.downloadUrl(API_KEY, 200000001)

    h.expectEqual(calls.length, 1, 'downloadUrl: success makes exactly one fetch call')
    h.expectEqual(
      calls[0].url,
      `${BASE_URL}/files/download?FileId=200000001`,
      'downloadUrl: success request URL'
    )
    h.expectEqual(calls[0].init.headers['Api-Key'], API_KEY, 'downloadUrl: sends Api-Key')
    h.expectEqual(
      calls[0].init.headers['User-Agent'],
      USER_AGENT,
      'downloadUrl: static mobile User-Agent'
    )
    h.expectEqual(payload, body, 'downloadUrl: returns the parsed payload')
    h.ok(
      typeof payload.FileUrl === 'string' && payload.FileUrl.length > 0,
      'downloadUrl: success payload has a non-empty FileUrl'
    )
  }

  // --- download success without FileUrl is an error -----------------------
  {
    const { fetchImpl, calls } = createFakeFetch([
      jsonResponse({ Code: 0, Message: 'ok' })
    ])
    const client = createClient({ fetchImpl })
    const error = await capture(client.downloadUrl(API_KEY, 1))

    h.expectEqual(calls.length, 1, 'downloadUrl: missing FileUrl makes one fetch call')
    h.expectEqual(error?.failure, 'error', 'downloadUrl: missing FileUrl throws error')
    h.expectEqual(error?.retryable, false, 'downloadUrl: missing FileUrl is non-retryable')
    h.ok(
      error?.message.toLowerCase().includes('fileurl'),
      'downloadUrl: missing FileUrl message names the field',
      error?.message
    )
  }

  // --- a non-success business Code on search is classified ---------------
  {
    const { fetchImpl, calls } = createFakeFetch([
      jsonResponse({ Code: 602, Message: 'Access denied' })
    ])
    const client = createClient({ fetchImpl })
    const error = await capture(client.searchPage(API_KEY, { query: 'test', page: 1 }))

    h.expectEqual(calls.length, 1, 'searchPage: a business failure is not retried')
    h.expectEqual(error?.failure, 'unauthorized', 'searchPage: Code 602 throws unauthorized')
    h.expectEqual(error?.retryable, false, 'searchPage: Code 602 is non-retryable')
    h.expectEqual(error?.status, 200, 'searchPage: business error keeps the HTTP status')
    h.expectEqual(error?.code, 602, 'searchPage: business error keeps the business code')
  }
}
