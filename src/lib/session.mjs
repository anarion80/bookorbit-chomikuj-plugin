/**
 * Per-indexer Chomikuj session cache.
 *
 * BookOrbit can run `search` for an indexer while `test` is still logging in,
 * so this module stores the in-flight login promise next to the resolved
 * session. Lookups are keyed by the indexer id and guarded by a SHA-256
 * fingerprint over the username and credential (the credential slot holds the
 * Chomikuj password, not the ApiKey). A changed username or credential is a
 * cache miss and starts a new login.
 *
 * A rejected login is never cached: the entry is removed before the rejection
 * reaches the caller, so the next lookup retries. `clearSession` (and its
 * `forgetSession` alias) evicts an entry on demand.
 *
 * This module performs no I/O, never logs, and never touches the host. The
 * caller maps failures and decides whether anything is persisted. The returned
 * session intentionally includes the `apiKey`, which every later API call must
 * send; the password is only ever passed to `client.login`.
 */

import { createHash } from 'node:crypto'

/**
 * @typedef {{
 *   apiKey: string,
 *   accountId: number|string,
 *   accountName: string,
 *   fingerprint: string
 * }} Session
 *
 * @typedef {{
 *   fingerprint: string,
 *   session: Session|null,
 *   pending: Promise<Session>|null
 * }} CacheEntry
 */

/** @type {Map<string, CacheEntry>} */
const sessions = new Map()

/**
 * SHA-256 over the username and credential, separated by a NUL so the two
 * parts cannot run together.
 *
 * @param {string} username
 * @param {string} credential
 * @returns {string} lowercase SHA-256 hex digest
 */
function fingerprintFor(username, credential) {
  return createHash('sha256').update(`${username}\0${credential}`, 'utf8').digest('hex')
}

/**
 * @param {string} message
 * @returns {Error & { failure: string, retryable: boolean }}
 */
function unauthorized(message) {
  const error = new Error(message)
  error.failure = 'unauthorized'
  error.retryable = false
  return error
}

/**
 * @param {unknown} username
 * @param {unknown} credential
 */
function requireCredentials(username, credential) {
  if (typeof username !== 'string' || username.trim() === '') {
    throw unauthorized('Chomikuj session needs a non-empty username')
  }
  if (typeof credential !== 'string' || credential === '') {
    throw unauthorized('Chomikuj session needs a non-empty credential')
  }
}

/**
 * @param {object} payload parsed `account/login` payload
 * @param {string} fingerprint
 * @returns {Session}
 */
function toSession(payload, fingerprint) {
  return {
    apiKey: payload.ApiKey,
    accountId: payload.AccountId,
    accountName: payload.AccountName,
    fingerprint
  }
}

/**
 * Perform the one login behind a cache entry. The signal is handed to the
 * client when supplied; the current client ignores extra arguments.
 *
 * @param {{
 *   client: { login: Function },
 *   username: string,
 *   credential: string,
 *   signal?: AbortSignal,
 *   fingerprint: string
 * }} input
 * @returns {Promise<Session>}
 */
async function loginFor({ client, username, credential, signal, fingerprint }) {
  const payload =
    signal === undefined
      ? await client.login(username, credential)
      : await client.login(username, credential, { signal })

  return toSession(payload, fingerprint)
}

/**
 * Resolve the cached session for `id`, logging in at most once per id and
 * credential fingerprint.
 *
 * Concurrent calls with the same fingerprint share the exact in-flight promise.
 * A resolved session is reused until the credentials change or the cache entry
 * is cleared.
 *
 * @param {{
 *   id: string|number,
 *   username?: string,
 *   credential?: string,
 *   client?: { login: Function },
 *   signal?: AbortSignal
 * }} [input]
 * @returns {Promise<Session>}
 */
export function getSession({ id, username, credential, client, signal } = {}) {
  try {
    requireCredentials(username, credential)
  } catch (error) {
    return Promise.reject(error)
  }

  if (client === null || typeof client !== 'object' || typeof client.login !== 'function') {
    return Promise.reject(new Error('Chomikuj session needs a client with login()'))
  }

  const key = String(id)
  const fingerprint = fingerprintFor(username, credential)
  const cached = sessions.get(key)

  if (cached !== undefined && cached.fingerprint === fingerprint) {
    if (cached.session !== null) return Promise.resolve(cached.session)
    if (cached.pending !== null) return cached.pending
  }

  /** @type {CacheEntry} */
  const entry = { fingerprint, session: null, pending: null }
  const pending = loginFor({ client, username, credential, signal, fingerprint }).then(
    (session) => {
      entry.session = session
      entry.pending = null
      return session
    },
    (error) => {
      // Only drop this entry: a concurrent credential change may already have
      // replaced it, and that newer login must keep its cache slot.
      if (sessions.get(key) === entry) sessions.delete(key)
      throw error
    }
  )

  entry.pending = pending
  sessions.set(key, entry)
  return pending
}

/**
 * Drop the cached session (and any in-flight login) for `id`. The next lookup
 * logs in again.
 *
 * @param {string|number} id
 */
export function clearSession(id) {
  sessions.delete(String(id))
}

/** Alias for {@link clearSession}. */
export const forgetSession = clearSession
