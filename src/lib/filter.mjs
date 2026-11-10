/**
 * Local format selection and `FileId` deduplication for Chomikuj search rows.
 *
 * The plugin sends Chomikuj an `Extension` hint only when exactly one format is
 * selected, so the local filter always runs as the source of truth. Archives
 * are dropped before the selection is applied: a user typing `zip` into the
 * setting must never resurrect an archive. Records are kept as the original
 * raw API objects; mapping to BookOrbit candidates happens later.
 *
 * Pure and dependency-free: safe to unit test and to bundle for BookOrbit.
 */

import {
  IMPORTABLE_EBOOK_FORMATS,
  isArchiveExtension,
  normalizeFormat,
  parseFileName
} from './filename.mjs'

/**
 * Build the normalized, dotless selection set. Returns null when the caller
 * did not select any formats, meaning every importable format is accepted.
 *
 * @param {unknown} formats
 * @returns {Set<string>|null}
 */
function selectedFormatSet(formats) {
  if (!Array.isArray(formats) || formats.length === 0) return null
  const selected = new Set()
  for (const format of formats) {
    const normalized = normalizeFormat(format)
    if (normalized !== '') selected.add(normalized)
  }
  return selected
}

/**
 * Return the file's normalized, dotless format, or an empty string when the
 * record has no usable filename/type information.
 *
 * @param {unknown} record
 * @returns {string}
 */
function recordFormat(record) {
  if (record === null || typeof record !== 'object') return ''
  return normalizeFormat(parseFileName(record.FileName, record.FileType).format)
}

/**
 * Return a non-empty string key for `FileId`, or null when it is missing or
 * unusable. Mirrors the mapper's identifier handling so both stages agree.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function fileIdKey(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  return null
}

/**
 * Keep only raw Chomikuj file records whose format is importable, not an
 * archive, and selected by the caller.
 *
 * @param {unknown} records
 * @param {unknown} [formats] Selected formats; omitted/empty/non-array means
 *   every importable format.
 * @returns {unknown[]} The original record objects, in their original order.
 */
export function selectFormats(records, formats) {
  if (!Array.isArray(records)) return []

  const selected = selectedFormatSet(formats)
  const result = []

  for (const record of records) {
    const format = recordFormat(record)
    if (format === '') continue
    if (isArchiveExtension(format)) continue
    if (!IMPORTABLE_EBOOK_FORMATS.includes(format)) continue
    if (selected !== null && !selected.has(format)) continue
    result.push(record)
  }

  return result
}

/**
 * Keep the first record for each usable `FileId`, preserving input order.
 * Records without a usable `FileId` are kept because the mapper is responsible
 * for dropping them; the filter never silently loses data it cannot key.
 *
 * @param {unknown} records
 * @returns {unknown[]} The original record objects, in their original order.
 */
export function dedupeByFileId(records) {
  if (!Array.isArray(records)) return []

  const seen = new Set()
  const result = []

  for (const record of records) {
    const rawId = record !== null && typeof record === 'object' ? record.FileId : undefined
    const key = fileIdKey(rawId)
    if (key !== null) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    result.push(record)
  }

  return result
}
