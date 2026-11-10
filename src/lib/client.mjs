/**
 * Chomikuj mobile API client.
 *
 * Every request carries the static mobile User-Agent and an MD5 request token
 * signed over the exact path, query string, and body that go on the wire.
 * `login` posts the credentials and returns the ApiKey payload; every later
 * call sends that key as `Api-Key`.
 *
 * Failures are plain `Error` objects decorated with `failure` (a BookOrbit
 * `PluginSearchFailure`), `retryable`, and, when known, `status` and `code`.
 * The plugin boundary maps them with `host.fail`; this module never touches
 * the host and never logs credentials or keys.
 *
 * Retries are deliberately narrow: `accountInfo` and `searchPage` may retry
 * once on HTTP 429/5xx after a short delay, honouring `Retry-After` up to two
 * seconds. `login` and `downloadUrl` are never retried, and a Cloudflare
 * challenge is never retried.
 */

import { classifyBusiness, classifyHttp, classifyLogin } from './failures.mjs'
import { signToken } from './token.mjs'

export const DEFAULT_BASE_URL = 'https://mobile.chomikuj.pl/api/v3'
export const DEFAULT_USER_AGENT = 'android/3.8.4 (python; python)'

const RETRY_DELAY_MS = 500
const MAX_RETRY_AFTER_MS = 2000
const LOGIN_PATH = 'account/login'
const ACCOUNT_PATH = 'account/info'
const SEARCH_PATH = 'files/search'
const DOWNLOAD_PATH = 'files/download'

function clientError(classification, { status, code, cause } = {}) {
  const error = new Error(classification.message)
  error.failure = classification.failure
  error.retryable = classification.retryable

  const numericStatus = Number(status)
  if (status !== undefined && status !== null && Number.isFinite(numericStatus)) {
    error.status = numericStatus
  }
  if (code !== undefined) error.code = code
  if (cause !== undefined) error.cause = cause

  return error
}

function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function parseJson(text, status) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw clientError(
      { failure: 'error', message: 'invalid JSON response', retryable: false },
      { status, cause: error }
    )
  }
}

function readCode(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  const value = payload.Code
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : String(value)
}

function messageOf(payload) {
  if (payload === null || typeof payload !== 'object') return ''
  return payload.Message ?? payload.message ?? ''
}

function headerValue(response, name) {
  const headers = response?.headers
  if (headers === undefined || headers === null) return null
  if (typeof headers.get === 'function') return headers.get(name)

  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = headers[key]
      return typeof value === 'string' ? value : null
    }
  }
  return null
}

/** Parse `Retry-After` as delay-seconds or an HTTP-date. */
function parseRetryAfter(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000

  const timestamp = Date.parse(trimmed)
  if (!Number.isFinite(timestamp)) return null
  return Math.max(0, timestamp - Date.now())
}

/**
 * Return the delay before the one allowed retry, or null when the response
 * must be thrown instead.
 */
function retryDelayFor(response, signal, classification) {
  if (classification.failure === null) return null
  // A challenge page is a wall, not a transient failure: never retry it.
  if (classification.message === 'cloudflare challenge') return null

  const status = Number(response.status)
  const retryableStatus = status === 429 || (status >= 500 && status < 600)
  if (!retryableStatus) return null
  if (signal?.aborted) return null

  const retryAfter = parseRetryAfter(headerValue(response, 'retry-after'))
  if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) return null

  return retryAfter === null ? RETRY_DELAY_MS : Math.max(RETRY_DELAY_MS, retryAfter)
}

/** Sleep for `ms`, resolving false if the signal aborts first. */
function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false)
      return
    }

    let timer
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(false)
    }

    timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve(true)
    }, ms)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function requestInit(method, headers, { body, signal } = {}) {
  const init = { method, headers }
  if (body !== undefined) init.body = body
  if (signal !== undefined) init.signal = signal
  return init
}

/** Accept either the host root or the full `/api/v3` base URL. */
function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (trimmed === '') return DEFAULT_BASE_URL
  return /\/api\/v3$/.test(trimmed) ? trimmed : `${trimmed}/api/v3`
}

/**
 * Build the client.
 *
 * @param {{
 *   baseUrl?: string,
 *   fetchImpl?: typeof fetch,
 *   userAgent?: string
 * }} [options]
 */
export function createClient({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  userAgent = DEFAULT_USER_AGENT
} = {}) {
  const root = normalizeBaseUrl(baseUrl)

  async function send(url, init) {
    try {
      return await fetchImpl(url, init)
    } catch (error) {
      const detail = typeof error?.message === 'string' ? error.message : ''
      throw clientError(classifyHttp(0, detail), { cause: error })
    }
  }

  async function readText(response, status) {
    try {
      return await response.text()
    } catch (error) {
      throw clientError(classifyHttp(0, ''), { status, cause: error })
    }
  }

  function apiHeaders(pathValue, queryString, apiKey, body) {
    const headers = {
      'User-Agent': userAgent,
      Token: signToken(pathValue, queryString, body ?? ''),
      'Api-Key': apiKey
    }
    return headers
  }

  /**
   * GET a JSON endpoint, retrying at most once on 429/5xx. The retry reuses the
   * exact same URL and headers, so the token still matches the wire request.
   */
  async function getJson(url, headers, signal, retry) {
    let response = await send(url, requestInit('GET', headers, { signal }))
    let status = Number(response.status)
    let text = await readText(response, status)
    let classification = classifyHttp(status, text)

    if (retry) {
      const delay = retryDelayFor(response, signal, classification)
      if (delay !== null) {
        const proceed = await wait(delay, signal)
        if (!proceed) {
          throw clientError(classification, {
            status,
            code: readCode(tryParseJson(text))
          })
        }

        response = await send(url, requestInit('GET', headers, { signal }))
        status = Number(response.status)
        text = await readText(response, status)
        classification = classifyHttp(status, text)
      }
    }

    if (classification.failure !== null) {
      throw clientError(classification, {
        status,
        code: readCode(tryParseJson(text))
      })
    }

    return { status, payload: parseJson(text, status) }
  }

  /**
   * POST the credentials and return the parsed login payload.
   * The login request never sends `Api-Key` and is never retried.
   */
  async function login(username, password) {
    const body = JSON.stringify({ AccountName: username, Password: password })
    const headers = {
      'User-Agent': userAgent,
      'Content-Type': 'application/json; charset=utf-8',
      Token: signToken(LOGIN_PATH, '', body)
    }

    const response = await send(
      `${root}/${LOGIN_PATH}`,
      requestInit('POST', headers, { body })
    )
    const status = Number(response.status)
    const text = await readText(response, status)
    const classification = classifyLogin(status, text)
    const payload = tryParseJson(text)

    if (classification.failure !== null) {
      throw clientError(classification, { status, code: readCode(payload) })
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw clientError(
        { failure: 'error', message: 'invalid JSON response', retryable: false },
        { status }
      )
    }

    return payload
  }

  /**
   * GET `/account/info` with the ApiKey, retrying once on 429/5xx. A non-success
   * business `Code` is thrown so a failed account payload cannot be read as a
   * free account by the quota layer.
   */
  async function accountInfo(apiKey, { signal } = {}) {
    const headers = apiHeaders(ACCOUNT_PATH, '', apiKey)
    const { status, payload } = await getJson(
      `${root}/${ACCOUNT_PATH}`,
      headers,
      signal,
      true
    )

    const classification = classifyBusiness(readCode(payload), messageOf(payload))
    if (classification.failure !== null) {
      throw clientError(classification, {
        status,
        code: readCode(payload)
      })
    }

    return payload
  }

  /**
   * GET `/files/search` with Documents-only results. The query string is built
   * once, sent verbatim, and signed verbatim.
   */
  async function searchPage(apiKey, { query = '', page = 1, extension, signal } = {}) {
    const params = new URLSearchParams()
    params.set('Query', String(query ?? ''))
    params.set('PageNumber', String(page ?? 1))
    params.set('MediaType', 'Documents')
    if (typeof extension === 'string' && extension.trim() !== '') {
      params.set('Extension', extension.trim())
    }

    const queryString = params.toString()
    const headers = apiHeaders(SEARCH_PATH, queryString, apiKey)
    const { status, payload } = await getJson(
      `${root}/${SEARCH_PATH}?${queryString}`,
      headers,
      signal,
      true
    )

    const classification = classifyBusiness(readCode(payload), messageOf(payload))
    if (classification.failure !== null) {
      throw clientError(classification, {
        status,
        code: readCode(payload)
      })
    }

    return payload
  }

  /**
   * GET `/files/download?FileId=...` exactly once. A 605 quota error is a
   * permanent `error`; success requires a non-empty `FileUrl`.
   */
  async function downloadUrl(apiKey, fileId, { signal } = {}) {
    const queryString = `FileId=${encodeURIComponent(String(fileId))}`
    const headers = apiHeaders(DOWNLOAD_PATH, queryString, apiKey)

    const response = await send(
      `${root}/${DOWNLOAD_PATH}?${queryString}`,
      requestInit('GET', headers, { signal })
    )
    const status = Number(response.status)
    const text = await readText(response, status)
    const payload = tryParseJson(text)

    const httpClassification = classifyHttp(status, text)
    if (httpClassification.failure !== null) {
      throw clientError(httpClassification, {
        status,
        code: readCode(payload)
      })
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw clientError(
        { failure: 'error', message: 'invalid JSON response', retryable: false },
        { status }
      )
    }

    const classification = classifyBusiness(readCode(payload), messageOf(payload))
    if (classification.failure !== null) {
      throw clientError(classification, {
        status,
        code: readCode(payload)
      })
    }

    const fileUrl = typeof payload.FileUrl === 'string' ? payload.FileUrl.trim() : ''
    if (fileUrl === '') {
      throw clientError(
        { failure: 'error', message: 'missing FileUrl', retryable: false },
        { status, code: readCode(payload) }
      )
    }

    return payload
  }

  return { login, accountInfo, searchPage, downloadUrl }
}
