/**
 * Map a raw Chomikuj search file record to a BookOrbit release candidate.
 *
 * Only fields the API actually provides are emitted. Chomikuj has no reliable
 * publication date, so `publishedAt` is never fabricated; the owner, folder,
 * thumbnails, and streaming URL are deliberately omitted because BookOrbit has
 * no corresponding candidate fields. Archives and non-importable documents are
 * dropped here as a second line of defence after the local format filter.
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
 * Return a non-empty string identifier for `FileId`, or null when it is
 * missing or unusable.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeFileId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  return null
}

/**
 * Chomikuj reports `Size` in kilobytes; BookOrbit expects bytes.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toSizeBytes(value) {
  const bytes = Number(value) * 1024
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null
}

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
 * Convert one Chomikuj search result row into a BookOrbit candidate.
 *
 * Returns null for records without a usable `FileId` or `FileName`, for
 * archives, for formats outside `IMPORTABLE_EBOOK_FORMATS`, and for formats the
 * caller did not select.
 *
 * @param {{
 *   FileId?: unknown,
 *   FileName?: unknown,
 *   FileType?: unknown,
 *   Size?: unknown,
 *   IsFileFreeForUser?: unknown
 * } | null | undefined} file
 * @param {{ formats?: string[] }} [options]
 * @returns {{
 *   guid: string,
 *   title: string,
 *   bookTitle: string,
 *   author: string | undefined,
 *   format: string,
 *   language: null,
 *   sizeBytes: number | null,
 *   seeders: null,
 *   leechers: null,
 *   primaryFileCount: number,
 *   fileCount: number,
 *   freeleech: boolean
 * } | null}
 */
export function toCandidate(file, { formats } = {}) {
  if (file === null || typeof file !== 'object') return null

  const guid = normalizeFileId(file.FileId)
  if (guid === null) return null

  if (typeof file.FileName !== 'string') return null
  const fileName = file.FileName.trim()
  if (fileName === '') return null

  const parsed = parseFileName(file.FileName, file.FileType)
  const format = normalizeFormat(parsed.format)

  if (format === '') return null
  if (isArchiveExtension(format)) return null
  if (!IMPORTABLE_EBOOK_FORMATS.includes(format)) return null

  const selected = selectedFormatSet(formats)
  if (selected !== null && !selected.has(format)) return null

  const parsedTitle = typeof parsed.title === 'string' ? parsed.title.trim() : ''
  const title = parsedTitle === '' ? fileName : parsedTitle
  const author =
    typeof parsed.author === 'string' && parsed.author.trim() !== ''
      ? parsed.author.trim()
      : undefined

  return {
    guid,
    title,
    bookTitle: title,
    author,
    format,
    language: null,
    sizeBytes: toSizeBytes(file.Size),
    seeders: null,
    leechers: null,
    primaryFileCount: 1,
    fileCount: 1,
    freeleech: Boolean(file.IsFileFreeForUser)
  }
}
