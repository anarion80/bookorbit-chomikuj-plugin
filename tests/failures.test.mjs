/**
 * Failure-classification table tests.
 *
 * Every mapping from the plan is pinned here so a future change cannot silently
 * turn the permanent 605 quota error into a retryable one, or let a Cloudflare
 * challenge page look like a plain authorization failure.
 */

import {
  classifyBusiness,
  classifyHttp,
  classifyLogin
} from '../src/lib/failures.mjs'

// Optional; `verify.mjs --only` matches this as well as the filename.
export const testName = 'failures'

const OK = { failure: null, message: 'ok', retryable: false }
const RESULT_KEYS = ['failure', 'message', 'retryable']
const KNOWN_FAILURES = new Set([
  'unauthorized',
  'throttled',
  'timeout',
  'unreachable',
  'unsupportedMedium',
  'error'
])
const RETRYABLE_FAILURES = new Set(['throttled', 'timeout', 'unreachable'])

// Collected for the contract sweeps at the end of the run.
const OUTCOMES = []

function expectOutcome(h, label, actual, expected) {
  OUTCOMES.push({ label, actual })
  h.expectEqual(actual, expected, label)
  h.expectEqual(Object.keys(actual ?? {}).sort(), RESULT_KEYS, `${label}: result shape`)
  h.ok(
    `${label}: failure is null or a PluginSearchFailure`,
    actual?.failure === null || KNOWN_FAILURES.has(actual?.failure),
    actual?.failure
  )
  h.expectEqual(
    actual?.retryable,
    RETRYABLE_FAILURES.has(actual?.failure),
    `${label}: retryable matches failure`
  )
}

export default async function run(h) {
  // --- HTTP success -------------------------------------------------------
  for (const status of [200, 201, 204, 206, 299, '200']) {
    expectOutcome(h, `classifyHttp(${status}) is success`, classifyHttp(status), OK)
  }
  expectOutcome(
    h,
    'classifyHttp ignores the body on a successful response',
    classifyHttp(200, '{"Message":"ignored"}'),
    OK
  )

  // --- HTTP status mapping ------------------------------------------------
  const HTTP_CASES = [
    [401, { failure: 'unauthorized', message: 'unauthorized', retryable: false }],
    [403, { failure: 'unauthorized', message: 'forbidden', retryable: false }],
    [429, { failure: 'throttled', message: 'throttled', retryable: true }],
    [500, { failure: 'unreachable', message: 'server error (HTTP 500)', retryable: true }],
    [502, { failure: 'unreachable', message: 'server error (HTTP 502)', retryable: true }],
    [503, { failure: 'unreachable', message: 'server error (HTTP 503)', retryable: true }],
    [504, { failure: 'unreachable', message: 'server error (HTTP 504)', retryable: true }],
    [599, { failure: 'unreachable', message: 'server error (HTTP 599)', retryable: true }],
    [400, { failure: 'error', message: 'client error (HTTP 400)', retryable: false }],
    [404, { failure: 'error', message: 'client error (HTTP 404)', retryable: false }],
    [405, { failure: 'error', message: 'client error (HTTP 405)', retryable: false }],
    [418, { failure: 'error', message: 'client error (HTTP 418)', retryable: false }],
    [422, { failure: 'error', message: 'client error (HTTP 422)', retryable: false }],
    [302, { failure: 'error', message: 'unexpected HTTP 302', retryable: false }]
  ]

  for (const [status, expected] of HTTP_CASES) {
    expectOutcome(h, `classifyHttp(${status})`, classifyHttp(status), expected)
  }

  // --- Cloudflare challenge detection -------------------------------------
  const CLOUDFLARE_BODIES = [
    ['cf-mitigated header text', 'cf-mitigated: challenge'],
    [
      'challenge platform path',
      '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>'
    ],
    ['challenge title', '<title>Just a moment...</title>'],
    [
      'turnstile host',
      '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'
    ],
    ['cf-chl marker', '<div id="cf-chl-widget-abc"></div>']
  ]

  for (const [label, body] of CLOUDFLARE_BODIES) {
    const expected = {
      failure: 'unreachable',
      message: 'cloudflare challenge',
      retryable: true
    }
    expectOutcome(h, `classifyHttp(403, ${label})`, classifyHttp(403, body), expected)
    expectOutcome(h, `classifyHttp(503, ${label})`, classifyHttp(503, body), expected)
  }

  expectOutcome(
    h,
    'classifyHttp detects Cloudflare markers case-insensitively',
    classifyHttp(403, 'JUST A MOMENT'),
    { failure: 'unreachable', message: 'cloudflare challenge', retryable: true }
  )
  expectOutcome(
    h,
    'Cloudflare 403 is unreachable, not unauthorized',
    classifyHttp(403, '<title>Just a moment...</title>'),
    { failure: 'unreachable', message: 'cloudflare challenge', retryable: true }
  )
  expectOutcome(
    h,
    'Cloudflare marker on a 2xx response is still unreachable',
    classifyHttp(200, '<title>Just a moment...</title>'),
    { failure: 'unreachable', message: 'cloudflare challenge', retryable: true }
  )

  // A valid JSON API reply is not a challenge page, even when a user-visible
  // value such as a file name contains a marker phrase.
  expectOutcome(
    h,
    'classifyHttp does not flag a JSON search reply with a "Just a Moment" file name',
    classifyHttp(200, '{"Code":0,"Results":[{"FileName":"Just a Moment.pdf"}]}'),
    OK
  )

  // --- HTTP message detail ------------------------------------------------
  expectOutcome(
    h,
    'classifyHttp keeps a JSON server message',
    classifyHttp(429, '{"Message":"Too many requests","Code":0}'),
    { failure: 'throttled', message: 'throttled: Too many requests', retryable: true }
  )
  expectOutcome(
    h,
    'classifyHttp keeps a plain-text server message',
    classifyHttp(503, 'maintenance window'),
    {
      failure: 'unreachable',
      message: 'server error (HTTP 503): maintenance window',
      retryable: true
    }
  )
  expectOutcome(
    h,
    'classifyHttp dedupes a matching 401 message',
    classifyHttp(401, '{"Message":"Unauthorized"}'),
    { failure: 'unauthorized', message: 'unauthorized', retryable: false }
  )
  expectOutcome(
    h,
    'classifyHttp drops an HTML body from the message',
    classifyHttp(500, '<html>boom</html>'),
    { failure: 'unreachable', message: 'server error (HTTP 500)', retryable: true }
  )

  // --- Network failures (no HTTP response) --------------------------------
  for (const status of [0, null, undefined, '']) {
    expectOutcome(
      h,
      `classifyHttp(${String(status)}) is a retryable network failure`,
      classifyHttp(status),
      { failure: 'unreachable', message: 'network error', retryable: true }
    )
  }
  expectOutcome(
    h,
    'classifyHttp network failure keeps a server body detail',
    classifyHttp(0, '{"Message":"connection reset"}'),
    {
      failure: 'unreachable',
      message: 'network error: connection reset',
      retryable: true
    }
  )

  // --- Business success ---------------------------------------------------
  for (const code of [0, 200, 201, '0', '200', '201', undefined, null]) {
    expectOutcome(h, `classifyBusiness(${String(code)}) is success`, classifyBusiness(code), OK)
  }

  // --- Business code mapping ----------------------------------------------
  const BUSINESS_CASES = [
    [601, { failure: 'error', message: 'file not found', retryable: false }],
    [602, { failure: 'unauthorized', message: 'access denied', retryable: false }],
    [603, { failure: 'error', message: 'account blocked', retryable: false }],
    [604, { failure: 'error', message: 'file invalid', retryable: false }],
    [605, { failure: 'error', message: 'not enough transfer', retryable: false }],
    [606, { failure: 'error', message: 'download error', retryable: false }],
    [610, { failure: 'error', message: 'directory invalid', retryable: false }],
    [401, { failure: 'unauthorized', message: 'unauthorized', retryable: false }],
    [402, { failure: 'unauthorized', message: 'unauthorized', retryable: false }]
  ]

  for (const [code, expected] of BUSINESS_CASES) {
    expectOutcome(h, `classifyBusiness(${code})`, classifyBusiness(code), expected)
  }

  // 605 is a permanent quota error, never throttling.
  expectOutcome(
    h,
    'classifyBusiness(605) is a permanent error',
    classifyBusiness(605, 'Not enough transfer'),
    { failure: 'error', message: 'not enough transfer', retryable: false }
  )
  h.ok(
    'classifyBusiness(605) is never throttled',
    classifyBusiness(605).failure !== 'throttled',
    classifyBusiness(605)
  )

  // Unknown codes stay errors but keep the numeric code for logs.
  expectOutcome(
    h,
    'classifyBusiness(699) is an unknown error',
    classifyBusiness(699),
    { failure: 'error', message: 'unknown business code 699', retryable: false }
  )
  expectOutcome(
    h,
    'classifyBusiness(699, message) keeps both parts',
    classifyBusiness(699, 'server says no'),
    {
      failure: 'error',
      message: 'unknown business code 699: server says no',
      retryable: false
    }
  )
  expectOutcome(
    h,
    'classifyBusiness("777") keeps the numeric code',
    classifyBusiness('777'),
    { failure: 'error', message: 'unknown business code 777', retryable: false }
  )

  // Server detail is appended only when it adds information.
  expectOutcome(
    h,
    'classifyBusiness(601) keeps a custom server message',
    classifyBusiness(601, 'Custom detail'),
    { failure: 'error', message: 'file not found: Custom detail', retryable: false }
  )
  expectOutcome(
    h,
    'classifyBusiness(602) dedupes the matching message',
    classifyBusiness(602, 'Access denied'),
    { failure: 'unauthorized', message: 'access denied', retryable: false }
  )
  expectOutcome(
    h,
    'classifyBusiness success ignores the message',
    classifyBusiness(0, 'ignored'),
    OK
  )

  // --- Login --------------------------------------------------------------
  for (const status of [200, 201, 204]) {
    expectOutcome(
      h,
      `classifyLogin(${status}) with ApiKey is success`,
      classifyLogin(status, { ApiKey: 'test-key' }),
      OK
    )
  }
  expectOutcome(
    h,
    'classifyLogin accepts a raw JSON string body',
    classifyLogin(200, '{"ApiKey":"test-key"}'),
    OK
  )

  for (const status of [0, null, undefined]) {
    expectOutcome(
      h,
      `classifyLogin(${String(status)}) is a retryable network failure`,
      classifyLogin(status),
      { failure: 'unreachable', message: 'network error', retryable: true }
    )
  }

  expectOutcome(
    h,
    'classifyLogin(200) without ApiKey is unauthorized',
    classifyLogin(200, {}),
    { failure: 'unauthorized', message: 'unauthorized: missing ApiKey', retryable: false }
  )
  expectOutcome(
    h,
    'classifyLogin(200) with an empty ApiKey is unauthorized',
    classifyLogin(200, { ApiKey: '' }),
    { failure: 'unauthorized', message: 'unauthorized: missing ApiKey', retryable: false }
  )
  expectOutcome(
    h,
    'classifyLogin(200) with "invalid secret key" is unauthorized',
    classifyLogin(200, { Message: 'invalid secret key' }),
    {
      failure: 'unauthorized',
      message: 'unauthorized: invalid secret key',
      retryable: false
    }
  )
  expectOutcome(
    h,
    'classifyLogin(200) with raw "invalid secret key" text is unauthorized',
    classifyLogin(200, 'invalid secret key'),
    {
      failure: 'unauthorized',
      message: 'unauthorized: invalid secret key',
      retryable: false
    }
  )
  expectOutcome(
    h,
    'classifyLogin(401) is unauthorized',
    classifyLogin(401, { Message: 'Bad credentials' }),
    {
      failure: 'unauthorized',
      message: 'unauthorized: Bad credentials',
      retryable: false
    }
  )
  expectOutcome(h, 'classifyLogin(403) is unauthorized', classifyLogin(403), {
    failure: 'unauthorized',
    message: 'unauthorized',
    retryable: false
  })
  expectOutcome(
    h,
    'classifyLogin(429) is throttled',
    classifyLogin(429, { Message: 'slow down' }),
    { failure: 'throttled', message: 'throttled: slow down', retryable: true }
  )
  expectOutcome(h, 'classifyLogin(500) is unreachable', classifyLogin(500), {
    failure: 'unreachable',
    message: 'server error (HTTP 500)',
    retryable: true
  })
  expectOutcome(
    h,
    'classifyLogin(503) is unreachable',
    classifyLogin(503, 'down'),
    {
      failure: 'unreachable',
      message: 'server error (HTTP 503): down',
      retryable: true
    }
  )
  expectOutcome(
    h,
    'classifyLogin Cloudflare 403 is unreachable',
    classifyLogin(403, '<title>Just a moment...</title>'),
    { failure: 'unreachable', message: 'cloudflare challenge', retryable: true }
  )
  expectOutcome(
    h,
    'classifyLogin Cloudflare 200 is unreachable',
    classifyLogin(200, '<script src="/cdn-cgi/challenge-platform/x"></script>'),
    { failure: 'unreachable', message: 'cloudflare challenge', retryable: true }
  )
  expectOutcome(
    h,
    'classifyLogin(403) with a JSON "Just a Moment" message is not a challenge',
    classifyLogin(403, '{"Message":"Just a Moment"}'),
    {
      failure: 'unauthorized',
      message: 'unauthorized: Just a Moment',
      retryable: false
    }
  )
  expectOutcome(
    h,
    'classifyLogin(400) is an error',
    classifyLogin(400, 'bad request'),
    {
      failure: 'error',
      message: 'client error (HTTP 400): bad request',
      retryable: false
    }
  )

  // --- Contract sweeps ----------------------------------------------------
  h.ok(
    'every outcome is a PluginSearchFailure or success',
    OUTCOMES.every(
      ({ actual }) => actual?.failure === null || KNOWN_FAILURES.has(actual?.failure)
    ),
    OUTCOMES.filter(
      ({ actual }) => actual?.failure !== null && !KNOWN_FAILURES.has(actual?.failure)
    )
  )
  h.ok(
    'retryable is true only for throttled/timeout/unreachable',
    OUTCOMES.every(
      ({ actual }) => actual?.retryable === RETRYABLE_FAILURES.has(actual?.failure)
    ),
    OUTCOMES.filter(
      ({ actual }) => actual?.retryable !== RETRYABLE_FAILURES.has(actual?.failure)
    )
  )

  // Acceptance-critical assertions restated by name.
  h.expectEqual(classifyHttp(429).failure, 'throttled', '429 is throttled')
  h.expectEqual(classifyHttp(429).retryable, true, '429 is retryable')
  h.expectEqual(classifyBusiness(605).failure, 'error', '605 is an error, not throttled')
  h.expectEqual(classifyBusiness(605).retryable, false, '605 is not retryable')
  h.expectEqual(classifyLogin(200, { ApiKey: 'k' }).failure, null, 'login with ApiKey succeeds')
}
