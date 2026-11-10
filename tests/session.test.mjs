/**
 * Tests for the per-indexer Chomikuj session cache.
 *
 * A scripted fake client counts login calls and returns a distinct synthetic
 * key per login, so the assertions pin cache reuse, in-flight dedupe, cache
 * invalidation on a changed username or password, retry after a rejected
 * login, explicit clearing, and the absence of any password in returned
 * sessions or console output.
 */

import { createHash } from 'node:crypto'
import { clearSession, forgetSession, getSession } from '../src/lib/session.mjs'

// Optional; `verify.mjs --only` matches this as well as the filename.
export const testName = 'session'

const USERNAME = 'alice@example.invalid'
const PASSWORD = 's3cret-p@ssword'
const OTHER_PASSWORD = 'an0ther-p@ssword'
const OTHER_USERNAME = 'bob@example.invalid'

function fingerprint(username, credential) {
  return createHash('sha256').update(`${username}\0${credential}`, 'utf8').digest('hex')
}

function createFakeClient({ failFirst = null } = {}) {
  const calls = []
  let logins = 0

  async function login(username, password, options) {
    calls.push({ username, password, options })
    logins += 1
    if (failFirst !== null && logins === 1) throw failFirst

    return {
      ApiKey: `synthetic-api-key-${String(logins).padStart(4, '0')}`,
      AccountId: 90000000 + logins,
      AccountName: username
    }
  }

  return { client: { login }, calls }
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
  const usedIds = []

  function id(value) {
    usedIds.push(value)
    return value
  }

  // --- sequential calls reuse one login ------------------------------------
  {
    const key = id('session-sequential')
    const { client, calls } = createFakeClient()
    const first = await getSession({
      id: key,
      username: USERNAME,
      credential: PASSWORD,
      client
    })
    const second = await getSession({
      id: key,
      username: USERNAME,
      credential: PASSWORD,
      client
    })

    h.expectEqual(calls.length, 1, 'session: sequential calls log in once')
    h.ok('session: sequential calls return the cached session', first === second)
    h.expectEqual(second.apiKey, first.apiKey, 'session: sequential calls share the ApiKey')
    h.expectEqual(
      Object.keys(first).sort(),
      ['accountId', 'accountName', 'apiKey', 'fingerprint'],
      'session: returns exactly the four session fields'
    )
    h.expectEqual(
      first.fingerprint,
      fingerprint(USERNAME, PASSWORD),
      'session: fingerprint is SHA-256 over username NUL credential'
    )
    h.expectEqual(first.apiKey, 'synthetic-api-key-0001', 'session: returns the login ApiKey')
    h.expectEqual(first.accountId, 90000001, 'session: returns the login AccountId')
    h.expectEqual(first.accountName, USERNAME, 'session: returns the login AccountName')
    h.expectEqual(calls[0].username, USERNAME, 'session: passes the username to login')
    h.expectEqual(calls[0].password, PASSWORD, 'session: passes the credential to login')
  }

  // --- concurrent calls share one login and one promise --------------------
  {
    const key = id('session-concurrent')
    const { client, calls } = createFakeClient()
    const firstPromise = getSession({
      id: key,
      username: USERNAME,
      credential: PASSWORD,
      client
    })
    const secondPromise = getSession({
      id: key,
      username: USERNAME,
      credential: PASSWORD,
      client
    })

    h.ok(
      'session: concurrent calls share the exact in-flight promise',
      firstPromise === secondPromise
    )

    const [first, second] = await Promise.all([firstPromise, secondPromise])
    h.expectEqual(calls.length, 1, 'session: concurrent calls log in once')
    h.expectEqual(second.apiKey, first.apiKey, 'session: concurrent calls share the ApiKey')
  }

  // --- a changed password is a cache miss ----------------------------------
  {
    const key = id('session-password-change')
    const { client, calls } = createFakeClient()
    const first = await getSession({
      id: key,
      username: USERNAME,
      credential: PASSWORD,
      client
    })
    const second = await getSession({
      id: key,
      username: USERNAME,
      credential: OTHER_PASSWORD,
      client
    })

    h.expectEqual(calls.length, 2, 'session: a changed password logs in again')
    h.expectEqual(
      calls[1].password,
      OTHER_PASSWORD,
      'session: the new password reaches login'
    )
    h.ok('session: a changed password gets a new ApiKey', first.apiKey !== second.apiKey)
    h.expectEqual(
      second.fingerprint,
      fingerprint(USERNAME, OTHER_PASSWORD),
      'session: the fingerprint tracks the new password'
    )
  }

  // --- a changed username is a cache miss ----------------------------------
  {
    const key = id('session-username-change')
    const { client, calls } = createFakeClient()
    const first = await getSession({
      id: key,
      username: USERNAME,
      credential: PASSWORD,
      client
    })
    const second = await getSession({
      id: key,
      username: OTHER_USERNAME,
      credential: PASSWORD,
      client
    })

    h.expectEqual(calls.length, 2, 'session: a changed username logs in again')
    h.expectEqual(calls[1].username, OTHER_USERNAME, 'session: the new username reaches login')
    h.ok('session: a changed username gets a new ApiKey', first.apiKey !== second.apiKey)
    h.expectEqual(second.accountName, OTHER_USERNAME, 'session: the new session names the account')
  }

  // --- forgetSession clears the entry --------------------------------------
  {
    const key = id('session-forget')
    const { client, calls } = createFakeClient()
    const first = await getSession({
      id: key,
      username: USERNAME,
      credential: PASSWORD,
      client
    })

    h.expectEqual(
      forgetSession,
      clearSession,
      'session: forgetSession is an alias of clearSession'
    )

    forgetSession(key)
    const second = await getSession({
      id: key,
      username: USERNAME,
      credential: PASSWORD,
      client
    })

    h.expectEqual(calls.length, 2, 'session: forgetSession forces a new login')
    h.ok('session: forgetSession produces a new ApiKey', first.apiKey !== second.apiKey)
  }

  // --- clearSession clears the entry; number and string ids share a slot ---
  {
    const key = id(4242)
    const { client, calls } = createFakeClient()
    const first = await getSession({
      id: key,
      username: USERNAME,
      credential: PASSWORD,
      client
    })
    const cached = await getSession({
      id: '4242',
      username: USERNAME,
      credential: PASSWORD,
      client
    })

    h.expectEqual(calls.length, 1, 'session: number and string ids share one cache entry')
    h.expectEqual(cached.apiKey, first.apiKey, 'session: the string-id lookup reuses the session')

    clearSession('4242')
    const second = await getSession({
      id: key,
      username: USERNAME,
      credential: PASSWORD,
      client
    })

    h.expectEqual(calls.length, 2, 'session: clearSession forces a new login')
    h.ok('session: clearSession produces a new ApiKey', first.apiKey !== second.apiKey)
  }

  // --- a rejected login does not poison the cache --------------------------
  {
    const key = id('session-retry')
    const failure = new Error('unauthorized')
    failure.failure = 'unauthorized'
    failure.retryable = false
    const { client, calls } = createFakeClient({ failFirst: failure })

    const firstError = await capture(
      getSession({ id: key, username: USERNAME, credential: PASSWORD, client })
    )

    h.ok('session: the first login rejection reaches the caller', firstError === failure)
    h.expectEqual(calls.length, 1, 'session: the rejected login made one attempt')

    const second = await getSession({
      id: key,
      username: USERNAME,
      credential: PASSWORD,
      client
    })

    h.expectEqual(calls.length, 2, 'session: the next call retries after a rejection')
    h.expectEqual(second.apiKey, 'synthetic-api-key-0002', 'session: the retry succeeds')
    h.expectEqual(second.accountName, USERNAME, 'session: the retry returns a usable session')

    const third = await getSession({
      id: key,
      username: USERNAME,
      credential: PASSWORD,
      client
    })

    h.expectEqual(calls.length, 2, 'session: the retried session is cached')
    h.expectEqual(third.apiKey, second.apiKey, 'session: the retried session is reused')
  }

  // --- the signal, when present, is forwarded to the client ----------------
  {
    const key = id('session-signal')
    const controller = new AbortController()
    const { client, calls } = createFakeClient()

    await getSession({
      id: key,
      username: USERNAME,
      credential: PASSWORD,
      client,
      signal: controller.signal
    })

    h.ok(
      'session: forwards the caller signal to login',
      calls[0].options?.signal === controller.signal
    )
  }

  // --- missing or empty credentials never reach login ----------------------
  {
    const { client, calls } = createFakeClient()
    const invalid = [
      ['missing username', { credential: PASSWORD }],
      ['empty username', { username: '', credential: PASSWORD }],
      ['whitespace username', { username: '   ', credential: PASSWORD }],
      ['missing credential', { username: USERNAME }],
      ['empty credential', { username: USERNAME, credential: '' }]
    ]

    for (const [label, input] of invalid) {
      const error = await capture(getSession({ id: 'session-invalid', client, ...input }))

      h.ok(
        `session: ${label} rejects with a plain Error`,
        error instanceof Error && error.constructor === Error
      )
      h.expectEqual(error?.failure, 'unauthorized', `session: ${label} is unauthorized`)
      h.ok(
        `session: ${label} has a clear message`,
        typeof error?.message === 'string' &&
          error.message.length > 0 &&
          /username|credential/.test(error.message),
        error?.message
      )
    }

    h.expectEqual(calls.length, 0, 'session: invalid credentials never call login')
  }

  // --- no password in the returned session and no log lines ----------------
  {
    const key = id('session-secret')
    const { client, calls } = createFakeClient()
    const messages = []
    const original = {}

    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      original[level] = console[level]
      console[level] = (...args) => messages.push(args.map(String).join(' '))
    }

    let session
    try {
      session = await getSession({
        id: key,
        username: USERNAME,
        credential: PASSWORD,
        client
      })
    } finally {
      for (const level of Object.keys(original)) console[level] = original[level]
    }

    h.expectEqual(messages, [], 'session: adds no log lines')
    h.expectEqual(calls[0].password, PASSWORD, 'session: the fake client did record the password')
    h.ok(
      'session: the password is absent from the returned session',
      !JSON.stringify(session).includes(PASSWORD)
    )
    h.ok(
      'session: no returned field exposes the password',
      Object.values(session).every((value) => !String(value).includes(PASSWORD))
    )
    h.ok(
      'session: the ApiKey is intentionally returned',
      JSON.stringify(session).includes(session.apiKey)
    )
  }

  for (const key of usedIds) clearSession(key)
}
