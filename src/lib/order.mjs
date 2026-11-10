/**
 * Order BookOrbit release candidates newest-first without fabricating dates.
 *
 * Chomikuj's search API exposes no reliable publication date, so the practical
 * recency proxy is the numeric `FileId` carried as the candidate `guid`. A real
 * date field is honoured only when a candidate actually carries one; this module
 * never writes `publishedAt` (or any other field) and never mutates the input.
 *
 * BookOrbit re-sorts merged results by score afterwards, so this ordering only
 * decides which rows survive the plugin's requested limit.
 *
 * Pure and dependency-free: safe to unit test and to bundle for BookOrbit.
 */

const DATE_FIELDS = ['AddedDate', 'Date', 'CreatedAt', 'publishedAt']

/**
 * Convert a candidate date field to a millisecond timestamp, or null when it is
 * absent or unparseable. Never invents a value.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toTimestamp(value) {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? null : time
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const time = Date.parse(trimmed)
    return Number.isNaN(time) ? null : time
  }
  return null
}

/**
 * Return the first parseable date carried by a candidate, preferring the more
 * specific Chomikuj-style fields over a generic `publishedAt`.
 *
 * @param {unknown} candidate
 * @returns {number|null}
 */
function candidateTimestamp(candidate) {
  if (candidate === null || typeof candidate !== 'object') return null
  for (const field of DATE_FIELDS) {
    const time = toTimestamp(candidate[field])
    if (time !== null) return time
  }
  return null
}

/**
 * Normalize a guid to the text used for comparison. Missing, non-numeric, or
 * non-string values become the empty string rather than `undefined`.
 *
 * @param {unknown} value
 * @returns {string}
 */
function guidText(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * Parse an integer guid as `BigInt` so values above `Number.MAX_SAFE_INTEGER`
 * keep full precision. Returns null when the guid is not an integer string.
 *
 * @param {unknown} value
 * @returns {bigint|null}
 */
function toBigIntGuid(value) {
  const text = guidText(value)
  if (!/^\d+$/.test(text)) return null
  try {
    return BigInt(text)
  } catch {
    return null
  }
}

/**
 * Compare two guids descending (newest first).
 *
 * Integer strings compare exactly as `BigInt`. Anything else - including a pair
 * where only one side is an integer - falls back to digit-length then
 * lexicographic comparison. The result is always -1, 0, or 1 and never `NaN`.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number}
 */
function compareGuidDesc(left, right) {
  const leftBig = toBigIntGuid(left)
  const rightBig = toBigIntGuid(right)
  if (leftBig !== null && rightBig !== null) {
    if (leftBig === rightBig) return 0
    return leftBig > rightBig ? -1 : 1
  }

  const leftText = guidText(left)
  const rightText = guidText(right)
  if (leftText.length !== rightText.length) return rightText.length - leftText.length
  if (leftText === rightText) return 0
  return leftText < rightText ? 1 : -1
}

/**
 * Return a new array of candidates ordered newest-first.
 *
 * When any candidate carries a parseable `AddedDate`, `Date`, `CreatedAt`, or
 * `publishedAt`, dated candidates sort first by timestamp descending and
 * undated candidates follow, ordered by `guid` descending. Otherwise every
 * candidate is ordered by `guid` descending. Equal keys keep the input order.
 *
 * @template {Record<string, unknown>} T
 * @param {T[]} candidates
 * @returns {T[]}
 */
export function orderByNewest(candidates) {
  if (!Array.isArray(candidates)) return []

  const entries = candidates.map((candidate, index) => ({
    candidate,
    index,
    time: candidateTimestamp(candidate)
  }))

  const hasDates = entries.some((entry) => entry.time !== null)

  entries.sort((left, right) => {
    if (hasDates) {
      if (left.time !== null && right.time !== null) {
        if (left.time !== right.time) return right.time - left.time
        return left.index - right.index
      }
      if (left.time !== null) return -1
      if (right.time !== null) return 1
    }

    const byGuid = compareGuidDesc(left.candidate?.guid, right.candidate?.guid)
    if (byGuid !== 0) return byGuid
    return left.index - right.index
  })

  return entries.map((entry) => entry.candidate)
}
