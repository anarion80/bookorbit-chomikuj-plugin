/**
 * Chomikuj transfer-quota preflight.
 *
 * `decideDownload` is pure and dependency-free: it never performs I/O, logs,
 * throws, or calls `files/download`. It answers one question before a download
 * URL is requested, because Chomikuj charges transfer when the URL is issued,
 * not when the bytes arrive.
 *
 * Units are inferred, not documented by the API: `/account/info` `Transfer` and
 * search-file `Size` are kilobytes (R13 `Utils.java:48-50`), so `sizeBytes` is
 * divided by 1024 before comparing. This preflight is advisory; business code
 * 605 from `files/download` remains authoritative and is never retryable.
 */

const FREE_REASON = 'allow: file is free for this user'
const UNLIMITED_REASON = 'allow: unlimited transfer'
const ADVISORY = 'preflight is advisory and code 605 is authoritative'

/**
 * Coerce a number-like value, treating non-numeric or empty values as unknown.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Render BalanceInfo/PointsInfo for a denial or caveat, when the API sent them.
 *
 * @param {object|null|undefined} account
 * @returns {string}
 */
function balanceSuffix(account) {
  const parts = []

  for (const key of ['BalanceInfo', 'PointsInfo']) {
    const value = account?.[key]
    if (value === null || value === undefined) continue
    const text = String(value).trim()
    if (text !== '') parts.push(`${key}: ${text}`)
  }

  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

function allow(reason) {
  return { allowed: true, failure: null, reason }
}

function deny(reason) {
  return { allowed: false, failure: 'error', reason }
}

/**
 * Decide whether a file may be downloaded without spending unavailable transfer.
 *
 * Rule order matters: unlimited and owner-marked-free files are always allowed,
 * even when `allowTransferSpend` is false. Only a literal `false` disables paid
 * spending; `undefined` keeps the manifest default of allowing it.
 *
 * @param {{
 *   file?: { sizeBytes?: unknown, freeleech?: unknown, IsFileFreeForUser?: unknown } | null,
 *   account?: {
 *     HasUnlimitedTransfer?: unknown,
 *     Transfer?: unknown,
 *     BalanceInfo?: unknown,
 *     PointsInfo?: unknown
 *   } | null,
 *   allowTransferSpend?: boolean
 * }} input
 * @returns {{ allowed: boolean, failure: string|null, reason: string }}
 */
export function decideDownload({ file, account, allowTransferSpend } = {}) {
  // 1. Unlimited transfer wins over every other rule.
  if (account?.HasUnlimitedTransfer === true) return allow(UNLIMITED_REASON)

  // 2. The owner marked the file free for this user: never a paid download.
  if (file?.freeleech === true || file?.IsFileFreeForUser === true) return allow(FREE_REASON)

  // 3. Paid spending disabled: refuse before any chargeable API call.
  if (allowTransferSpend === false) {
    const balance = balanceSuffix(account)
    return deny(
      `paid download blocked: transfer spending is disabled (allowTransferSpend=false)${balance}; the file is not marked free`
    )
  }

  // 4. Known balance and known size: compare in kilobytes.
  const transferKb = finiteNumber(account?.Transfer)
  const sizeBytes = finiteNumber(file?.sizeBytes)

  if (transferKb !== null && sizeBytes !== null && sizeBytes > 0) {
    const fileKb = Math.ceil(sizeBytes / 1024)
    if (fileKb > transferKb) {
      return deny(
        `not enough transfer: need ${fileKb} kB, have ${transferKb} kB${balanceSuffix(account)}`
      )
    }
    return allow(`allow: enough transfer (need ${fileKb} kB, have ${transferKb} kB)`)
  }

  // 5. Missing/unknown balance or size: allow and say the preflight is advisory.
  if (sizeBytes === null || sizeBytes <= 0) {
    return allow(`allow: unknown file size; ${ADVISORY}`)
  }
  return allow(`allow: unknown balance; ${ADVISORY}`)
}
