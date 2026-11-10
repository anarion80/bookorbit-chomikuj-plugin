/**
 * BookOrbit plugin manifest and contract wiring for Chomikuj.pl.
 *
 * The declarative fields are what BookOrbit reads before it calls the plugin.
 * `search`, `test`, `resolveFile`, and `forget` are the thin boundary between
 * BookOrbit's host and the library modules: this file builds the client from
 * the host's fetch, maps client failures with `host.fail`, and never logs or
 * persists credentials.
 */

import { createClient } from './lib/client.mjs'
import { dedupeByFileId, selectFormats } from './lib/filter.mjs'
import { toCandidate } from './lib/map.mjs'
import { orderByNewest } from './lib/order.mjs'
import { resolveDownload } from './lib/resolve.mjs'
import { searchFiles } from './lib/search.mjs'
import { clearSession, forgetSession, getSession } from './lib/session.mjs'

const DEFAULT_FORMATS = 'epub,mobi,pdf'
const TEST_TIMEOUT_MS = 15000
const DEFAULT_LIMIT = 20

function parseFormats(value) {
  const text = typeof value === 'string' && value.trim() !== '' ? value : DEFAULT_FORMATS
  const formats = text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return formats.length > 0 ? formats : DEFAULT_FORMATS.split(',')
}

function requestedLimit(query) {
  return Math.max(1, Number(query?.limit) || DEFAULT_LIMIT)
}

function accountSummary(account) {
  const balance = account?.BalanceInfo
  if (balance !== undefined && balance !== null && String(balance).trim() !== '') {
    return String(balance).trim()
  }

  const transfer = Number(account?.Transfer)
  if (Number.isFinite(transfer)) return `${transfer} kB`

  return 'unknown balance'
}

function createPluginClient(config, host) {
  return createClient({ baseUrl: config?.baseUrl, fetchImpl: host.fetch })
}

function sessionInput(config, client, signal) {
  return {
    id: config?.id,
    username: config?.settings?.username,
    credential: config?.credential,
    client,
    signal
  }
}

function clearUnauthorized(config, error) {
  if (error?.failure === 'unauthorized') clearSession(config?.id)
}

/**
 * Search Chomikuj and return BookOrbit release candidates, newest first.
 *
 * @param {{ title?: string, author?: string, isbn13?: string, limit?: number }} query
 * @param {{ id: string|number, baseUrl?: string, credential?: string, settings?: object }} config
 * @param {{ fetch: typeof fetch, fail: Function }} host
 * @param {AbortSignal} [signal]
 * @returns {Promise<object[]>}
 */
async function search(query, config, host, signal) {
  try {
    const client = createPluginClient(config, host)
    const session = await getSession(sessionInput(config, client, signal))
    const formats = parseFormats(config?.settings?.formats)
    const limit = requestedLimit(query)

    const rows = await searchFiles({
      client,
      session,
      query,
      formats,
      limit,
      signal,
      host
    })

    const candidates = dedupeByFileId(selectFormats(rows, formats))
      .map((file) => toCandidate(file, { formats }))
      .filter(Boolean)

    return orderByNewest(candidates).slice(0, limit)
  } catch (error) {
    clearUnauthorized(config, error)
    throw host.fail(error?.failure ?? 'error', error?.message ?? 'Chomikuj search failed')
  }
}

/**
 * Validate the stored credentials and report the account tier.
 *
 * BookOrbit calls this without a signal, so the login and account request are
 * bounded here by a fixed timeout.
 *
 * @param {{ id: string|number, baseUrl?: string, credential?: string, settings?: object }} config
 * @param {{ fetch: typeof fetch, fail: Function }} host
 * @returns {Promise<{ success: boolean, indexerName?: string, error?: string }>}
 */
async function test(config, host) {
  const client = createPluginClient(config, host)
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS)

  try {
    const session = await getSession(sessionInput(config, client, signal))
    const account = await client.accountInfo(session.apiKey, { signal })

    const indexerName =
      account?.HasUnlimitedTransfer === true
        ? 'Chomikuj.pl (unlimited transfer)'
        : `Chomikuj.pl (free, ${accountSummary(account)})`

    return { success: true, indexerName }
  } catch (error) {
    clearUnauthorized(config, error)
    return { success: false, error: error?.message ?? 'Chomikuj login failed' }
  }
}

/**
 * Resolve one release to a BookOrbit download descriptor. The account payload
 * is required so the quota preflight can see `HasUnlimitedTransfer`/`Transfer`.
 *
 * @param {object} release
 * @param {{ id: string|number, baseUrl?: string, credential?: string, settings?: object }} config
 * @param {{ fetch: typeof fetch, fail: Function }} host
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ url: string, fileName: string, format: string, sizeBytes: number|null }>}
 */
async function resolveFile(release, config, host, signal) {
  try {
    const client = createPluginClient(config, host)
    const session = await getSession(sessionInput(config, client, signal))
    const account = await client.accountInfo(session.apiKey, { signal })

    return await resolveDownload({
      client,
      session,
      release,
      config,
      account,
      host,
      signal
    })
  } catch (error) {
    clearUnauthorized(config, error)
    throw host.fail(error?.failure ?? 'error', error?.message ?? 'Chomikuj download failed')
  }
}

/** Drop the cached session so the next call logs in again. */
function forget(indexerId) {
  forgetSession(indexerId)
}

export default {
  apiVersion: 1,
  version: '0.1.0',
  type: 'chomikuj',
  label: 'Chomikuj.pl',
  requiresCredential: true,
  credentialKind: 'apiKey',
  mediaKinds: ['ebook'],
  supportsIsbnSearch: true,
  usesCategories: false,
  seedsBack: false,
  defaultBaseUrl: 'https://mobile.chomikuj.pl',
  baseUrlHint: 'Chomikuj mobile API base; normally unchanged.',
  settingsFields: [
    {
      key: 'username',
      type: 'string',
      label: 'Chomikuj username',
      hint: 'Your Chomikuj.pl account name. Put the account password in BookOrbit\'s credential field, which the UI labels "API key".'
    },
    {
      key: 'allowTransferSpend',
      type: 'boolean',
      label: 'Allow spending transfer',
      default: true,
      hint: 'Warning: previewing a paid file can spend transfer. When this is off, only files the owner marks as free are offered.'
    },
    {
      key: 'formats',
      type: 'string',
      label: 'Ebook formats',
      format: 'list',
      default: 'epub,mobi,pdf',
      options: ['epub', 'kepub', 'mobi', 'azw3', 'azw', 'fb2', 'pdf', 'djvu'],
      minItems: 1,
      hint: 'One format narrows the search on the server; several formats are filtered locally. Archive formats are never offered.'
    }
  ],
  search,
  test,
  resolveFile,
  forget
}
