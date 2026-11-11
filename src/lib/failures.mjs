/**
 * Chomikuj failure classification.
 *
 * Maps transport statuses and Chomikuj business codes to BookOrbit's
 * `PluginSearchFailure` values. Every function is pure: nothing here performs
 * I/O, throws, retries, or logs. Callers turn the returned object into a host
 * failure and decide whether a retry is allowed.
 */

const SUCCESS_CODES = new Set([0, 200, 201])

// Lowercase on purpose; the body is lowercased before matching.
const CLOUDFLARE_MARKERS = [
  'cf-mitigated: challenge',
  '/cdn-cgi/challenge-platform/',
  'just a moment',
  'challenges.cloudflare.com',
  'cf-chl-'
]

const BUSINESS_RESULTS = new Map([
  [601, { failure: 'error', message: 'file not found', retryable: false }],
  [602, { failure: 'unauthorized', message: 'access denied', retryable: false }],
  [603, { failure: 'error', message: 'account blocked', retryable: false }],
  [604, { failure: 'error', message: 'file invalid', retryable: false }],
  // 605 is a permanent quota error in the official app; never treat it as a
  // throttling signal that a retry could clear.
  [605, { failure: 'error', message: 'not enough transfer', retryable: false }],
  [606, { failure: 'error', message: 'download error', retryable: false }],
  [610, { failure: 'error', message: 'directory invalid', retryable: false }],
  [401, { failure: 'unauthorized', message: 'unauthorized', retryable: false }],
  [402, { failure: 'unauthorized', message: 'unauthorized', retryable: false }]
])

function result(failure, message, retryable) {
  return { failure, message, retryable }
}

function success() {
  return result(null, 'ok', false)
}

function normalizeStatus(status) {
  const value = Number(status)
  return Number.isFinite(value) ? value : null
}

function is2xx(status) {
  return status !== null && status >= 200 && status < 300
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Append server detail only when it says something the fallback does not. */
function withDetail(message, detail) {
  const extra = normalizeText(detail)
  if (!extra) return message
  if (extra.toLowerCase() === message.toLowerCase()) return message
  return `${message}: ${extra}`
}

function messageFromText(bodyText) {
  const text = normalizeText(bodyText)
  if (!text) return ''

  try {
    const payload = JSON.parse(text)
    if (payload !== null && typeof payload === 'object') {
      return (
        normalizeText(payload.Message) ||
        normalizeText(payload.message) ||
        normalizeText(payload.error) ||
        ''
      )
    }
  } catch {
    // Not JSON; fall through to a short plain-text excerpt.
  }

  // Never paste raw HTML into an error message.
  if (text.length <= 160 && !text.includes('<')) return text
  return ''
}

function hasCloudflareChallenge(bodyText) {
  const text = normalizeText(bodyText).toLowerCase()
  if (!text) return false
  return CLOUDFLARE_MARKERS.some((marker) => text.includes(marker))
}

/** A parsed JSON body is an API reply, not a Cloudflare challenge page. */
function isJsonDocument(bodyText) {
  const text = typeof bodyText === 'string' ? bodyText : toBodyText(bodyText)
  if (!text) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function toBodyText(body) {
  if (typeof body === 'string') return body
  if (body === null || body === undefined) return ''
  try {
    return JSON.stringify(body)
  } catch {
    return ''
  }
}

function toBodyObject(body) {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body
  if (typeof body !== 'string') return null
  try {
    const payload = JSON.parse(body)
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) return payload
  } catch {
    // Not JSON.
  }
  return null
}

function bodyMessage(body) {
  const payload = toBodyObject(body)
  if (payload) {
    return (
      normalizeText(payload.Message) ||
      normalizeText(payload.message) ||
      normalizeText(payload.error) ||
      ''
    )
  }
  return messageFromText(typeof body === 'string' ? body : '')
}

function normalizeCode(code) {
  if (typeof code === 'number' && Number.isFinite(code)) return code
  if (typeof code === 'string' && /^\s*-?\d+\s*$/.test(code)) return Number(code)
  return null
}

/**
 * Classify an HTTP status plus an optional response body.
 *
 * Cloudflare interception wins over the status mapping: a challenge page is an
 * unreachable transport, not an auth or quota verdict, even if it arrives with
 * a 2xx status.
 *
 * @param {number|string} status
 * @param {string} [bodyText]
 * @returns {{ failure: string|null, message: string, retryable: boolean }}
 */
export function classifyHttp(status, bodyText = '') {
  const code = normalizeStatus(status)
  const text = typeof bodyText === 'string' ? bodyText : toBodyText(bodyText)

  // A parsed JSON body is an API reply; user-visible values inside it can
  // contain marker phrases.
  if (!isJsonDocument(text) && hasCloudflareChallenge(text)) {
    return result('unreachable', 'cloudflare challenge', true)
  }

  const detail = messageFromText(text)

  // Status 0 or a non-numeric status means the request never produced an HTTP
  // response (DNS, socket, TLS, or timeout): a retryable transport failure.
  if (code === 0 || code === null) {
    return result('unreachable', withDetail('network error', detail), true)
  }

  if (is2xx(code)) return success()

  if (code === 401) return result('unauthorized', withDetail('unauthorized', detail), false)
  if (code === 403) return result('unauthorized', withDetail('forbidden', detail), false)
  if (code === 429) return result('throttled', withDetail('throttled', detail), true)
  if (code !== null && code >= 500 && code < 600) {
    return result('unreachable', withDetail(`server error (HTTP ${code})`, detail), true)
  }
  if (code !== null && code >= 400 && code < 500) {
    return result('error', withDetail(`client error (HTTP ${code})`, detail), false)
  }

  return result('error', withDetail(`unexpected HTTP ${status}`, detail), false)
}

/**
 * Classify a Chomikuj business code.
 *
 * A missing code is success because several successful payloads omit `Code`.
 * Unknown codes stay `error` and keep the numeric code in the message so logs
 * remain actionable.
 *
 * @param {number|string|null|undefined} code
 * @param {string} [message]
 * @returns {{ failure: string|null, message: string, retryable: boolean }}
 */
export function classifyBusiness(code, message = '') {
  if (code === undefined || code === null) return success()

  const normalized = normalizeCode(code)
  if (normalized !== null && SUCCESS_CODES.has(normalized)) return success()

  const mapped = normalized !== null ? BUSINESS_RESULTS.get(normalized) : undefined
  if (mapped) {
    return result(mapped.failure, withDetail(mapped.message, message), mapped.retryable)
  }

  const label = normalized !== null ? normalized : String(code)
  return result('error', withDetail(`unknown business code ${label}`, message), false)
}

/**
 * Classify a POST /account/login result.
 *
 * The caller decides whether to retry; this module only reports whether the
 * failure class makes a retry plausible. Login itself must never be retried by
 * the client.
 *
 * @param {number|string} status
 * @param {object|string|null} [body] parsed JSON body or raw body text
 * @returns {{ failure: string|null, message: string, retryable: boolean }}
 */
export function classifyLogin(status, body) {
  const code = normalizeStatus(status)
  const payload = toBodyObject(body)
  const text = toBodyText(body)
  const detail = bodyMessage(body)
  const apiKey =
    payload && payload.ApiKey !== undefined && payload.ApiKey !== null
      ? String(payload.ApiKey).trim()
      : ''
  const invalidSecretKey = /invalid\s+secret\s+key/i.test(text)

  if (is2xx(code) && apiKey) return success()

  // A parsed JSON body is an API reply; user-visible values inside it can
  // contain marker phrases.
  if (!isJsonDocument(text) && hasCloudflareChallenge(text)) {
    return result('unreachable', 'cloudflare challenge', true)
  }

  // Status 0 or a non-numeric status means no HTTP response was received.
  if (code === 0 || code === null) {
    return result('unreachable', withDetail('network error', detail), true)
  }

  if (code === 401 || code === 403) {
    return result('unauthorized', withDetail('unauthorized', detail), false)
  }
  if (code === 429) {
    return result('throttled', withDetail('throttled', detail), true)
  }
  if (code !== null && code >= 500 && code < 600) {
    return result('unreachable', withDetail(`server error (HTTP ${code})`, detail), true)
  }
  if (is2xx(code) || invalidSecretKey) {
    const reason = detail || (invalidSecretKey ? 'invalid secret key' : 'missing ApiKey')
    return result('unauthorized', withDetail('unauthorized', reason), false)
  }
  if (code !== null && code >= 400 && code < 500) {
    return result('error', withDetail(`client error (HTTP ${code})`, detail), false)
  }

  return result('error', withDetail(`unexpected HTTP ${status}`, detail), false)
}
