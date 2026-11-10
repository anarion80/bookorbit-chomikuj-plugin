/**
 * Download resolution for one Chomikuj release.
 *
 * Chomikuj charges transfer when the download URL is issued, so this module
 * runs the pure quota preflight first and only then asks the client for a
 * `FileUrl`. The request is issued exactly once and is never retried: a 605 is
 * an authoritative quota verdict, not a transient rate limit.
 *
 * The result is the BookOrbit download descriptor `{ url, fileName, format,
 * sizeBytes }`. The format comes from the release metadata first, then the
 * response `Name`, then the release title; the file name always ends in that
 * format and never contains path separators or control characters.
 */

import { normalizeFormat } from './filename.mjs'
import { decideDownload } from './quota.mjs'

const DEFAULT_FILE_NAME = 'chomikuj-download'
const EXTENSION_RE = /\.[A-Za-z][A-Za-z0-9]{0,9}$/

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Return the lowercased extension of a name, or an empty string. */
function extensionOf(value) {
  const name = trimmed(value)
  if (name === '') return ''
  const match = name.match(EXTENSION_RE)
  return match ? normalizeFormat(match[0]) : ''
}

/** Replace path separators and drop control characters. */
function sanitizeName(value) {
  const text = trimmed(value)
  if (text === '') return ''
  return text
    .replace(/[/\\]/g, '_')
    .replace(/\p{Cc}/gu, '')
    .trim()
}

/** Guarantee a non-empty file name ending in `.<format>` without doubling it. */
function ensureExtension(value, format) {
  const base = sanitizeName(value) || DEFAULT_FILE_NAME
  const suffix = `.${format}`
  if (base.toLowerCase().endsWith(suffix.toLowerCase())) return base

  const stem = base.replace(EXTENSION_RE, '').trim() || DEFAULT_FILE_NAME
  return `${stem}${suffix}`
}

function formatFrom(release, responseName) {
  return (
    normalizeFormat(release?.format) ||
    extensionOf(responseName) ||
    extensionOf(release?.title) ||
    extensionOf(release?.bookTitle)
  )
}

function nameFrom(release, responseName) {
  const fromResponse = trimmed(responseName)
  if (fromResponse !== '') return fromResponse
  return trimmed(release?.bookTitle) || trimmed(release?.title) || DEFAULT_FILE_NAME
}

/**
 * Resolve a download descriptor for one release.
 *
 * @param {{
 *   client: { downloadUrl: Function },
 *   session: { apiKey?: string },
 *   release: {
 *     guid?: string,
 *     format?: string,
 *     title?: string,
 *     bookTitle?: string,
 *     sizeBytes?: number|null,
 *     freeleech?: boolean,
 *     IsFileFreeForUser?: boolean
 *   },
 *   config?: { settings?: { allowTransferSpend?: boolean } },
 *   account?: object|null,
 *   host: { fail: Function },
 *   signal?: AbortSignal
 * }} options
 * @returns {Promise<{ url: string, fileName: string, format: string, sizeBytes: number|null }>}
 */
export async function resolveDownload({
  client,
  session,
  release,
  config,
  account,
  host,
  signal
} = {}) {
  const decision = decideDownload({
    file: release,
    account,
    allowTransferSpend: config?.settings?.allowTransferSpend
  })
  if (!decision.allowed) {
    throw host.fail(decision.failure, decision.reason)
  }

  let payload
  try {
    payload = await client.downloadUrl(session?.apiKey, release?.guid, { signal })
  } catch (error) {
    throw host.fail(
      error?.failure ?? 'error',
      error?.message ?? 'Chomikuj download request failed'
    )
  }

  const url = trimmed(payload?.FileUrl)
  if (url === '') {
    throw host.fail('error', 'Chomikuj download response is missing FileUrl')
  }

  const responseName = payload?.Name
  const format = formatFrom(release, responseName)
  if (format === '') {
    throw host.fail('error', 'cannot determine the file format')
  }

  return {
    url,
    fileName: ensureExtension(nameFrom(release, responseName), format),
    format,
    sizeBytes: release?.sizeBytes ?? null
  }
}
