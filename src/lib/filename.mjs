/**
 * Filename and format parsing for Chomikuj search results.
 *
 * Chomikuj exposes the extension in `FileType` and usually omits it from
 * `FileName`, but some records embed it in the name. This module is the single
 * source of truth for which formats may be imported and which are archives.
 *
 * Pure and dependency-free: safe to unit test and to bundle for BookOrbit.
 */

export const IMPORTABLE_EBOOK_FORMATS = [
  'epub',
  'kepub',
  'mobi',
  'azw3',
  'azw',
  'fb2',
  'pdf',
  'djvu'
]

export const ARCHIVE_EXTENSIONS = [
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'cbz',
  'cbr',
  'cb7',
  'cbt'
]

const KNOWN_EXTENSIONS = new Set([...IMPORTABLE_EBOOK_FORMATS, ...ARCHIVE_EXTENSIONS])

const LANGUAGE_CODES = new Set([
  'pl',
  'pol',
  'polish',
  'polski',
  'eng',
  'en',
  'english',
  'angielski',
  'de',
  'ger',
  'deu',
  'fr',
  'fra',
  'es',
  'spa',
  'it',
  'ita',
  'ru',
  'rus',
  'uk',
  'ua',
  'cz',
  'cs',
  'sk',
  'nl',
  'sv',
  'swe',
  'pt',
  'por',
  'hu',
  'ro',
  'bg',
  'hr',
  'sr',
  'sl',
  'lt',
  'lv',
  'et',
  'fi',
  'no',
  'da',
  'el',
  'tr',
  'ar',
  'he',
  'ja',
  'zh',
  'ko'
])

const NOISE_WORDS = new Set([
  ...IMPORTABLE_EBOOK_FORMATS,
  ...ARCHIVE_EXTENSIONS,
  'ebook',
  'ebooks',
  'e-book',
  'e-books',
  'book',
  'books',
  'ksiazka',
  'książka',
  'dokument'
])

const EXTENSION_RE = /\.([A-Za-z0-9]{1,10})$/
const LEADING_BRACKET_RE = /^\s*[[(]([^\])]*)[\])]\s*/
const TRAILING_BRACKET_RE = /\s*[[(]([^\])]*)[\])]\s*$/
const AUTHOR_TITLE_SEPARATOR_RE = /\s+[-\u2013\u2014]\s+/
const TRAILING_PARENTHETICAL_RE = /^(.*\S)\s*\(([^()]+)\)\s*$/

/**
 * Lowercase, trim, and remove a single leading dot from a format/extension.
 * Returns an empty string for anything that is not a non-empty string.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeFormat(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0) return ''
  return trimmed.startsWith('.') ? trimmed.slice(1).trim() : trimmed
}

/**
 * True when the value is one of the archive extensions that must never be
 * offered or imported, including comic-book archives such as cbz/cbr.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isArchiveExtension(value) {
  return ARCHIVE_EXTENSIONS.includes(normalizeFormat(value))
}

function isNoiseTag(content) {
  const normalized = String(content).trim().toLowerCase()
  if (normalized.length === 0) return true
  const tokens = normalized.split(/[^a-z0-9ąćęłńóśźż]+/i).filter(Boolean)
  if (tokens.length === 0) return true
  return tokens.every((token) => NOISE_WORDS.has(token) || LANGUAGE_CODES.has(token))
}

function stripLeadingNoise(name) {
  let current = name.trim()
  while (true) {
    const match = current.match(LEADING_BRACKET_RE)
    if (!match || !isNoiseTag(match[1])) return current
    current = current.slice(match[0].length).trim()
  }
}

function stripTrailingNoise(name) {
  let current = name.trim()
  while (true) {
    const match = current.match(TRAILING_BRACKET_RE)
    if (!match || !isNoiseTag(match[1])) return current
    current = current.slice(0, match.index).trim()
  }
}

function stripRepeatedKnownExtensions(name) {
  let current = name.trim()
  while (true) {
    const match = current.match(EXTENSION_RE)
    if (!match) return current
    if (!KNOWN_EXTENSIONS.has(match[1].toLowerCase())) return current
    current = current.slice(0, match.index).trim()
  }
}

function splitAuthorTitle(name) {
  const match = AUTHOR_TITLE_SEPARATOR_RE.exec(name)
  if (!match) return null
  const author = name.slice(0, match.index).trim()
  const title = name.slice(match.index + match[0].length).trim()
  if (author.length === 0 || title.length === 0) return null
  return { author, title }
}

function looksLikeAuthor(value) {
  const candidate = value.trim()
  if (candidate.length === 0) return false
  // Require a letter so years and bare edition numbers are not treated as authors.
  return /\p{L}/u.test(candidate) && !/^\d+$/.test(candidate)
}

function splitTitleAuthor(name) {
  const match = TRAILING_PARENTHETICAL_RE.exec(name)
  if (!match) return null
  const title = match[1].trim()
  const author = match[2].trim()
  if (title.length === 0 || !looksLikeAuthor(author) || isNoiseTag(author)) return null
  return { author, title }
}

/**
 * Parse a Chomikuj `FileName`/`FileType` pair into BookOrbit title metadata.
 *
 * Supported shapes:
 *   "Author - Title.epub"   -> author "Author", title "Title"
 *   "Title (Author).pdf"    -> author "Author", title "Title"
 *   "[PL] Title.epub"       -> author null, title "Title"
 *   "NoSeparator.mobi"      -> author null, title "NoSeparator"
 *
 * @param {unknown} fileName
 * @param {unknown} fileType
 * @returns {{ title: string, bookTitle: string, author: string | null, format: string }}
 */
export function parseFileName(fileName, fileType) {
  const raw = typeof fileName === 'string' ? fileName.trim() : ''
  const typeFormat = normalizeFormat(fileType)

  const extensionMatch = raw.match(EXTENSION_RE)
  const extension = extensionMatch ? extensionMatch[1].toLowerCase() : ''
  const withoutExtension = extensionMatch ? raw.slice(0, extensionMatch.index).trim() : raw

  const format = typeFormat || normalizeFormat(extension)

  let stem = stripRepeatedKnownExtensions(withoutExtension)
  stem = stripLeadingNoise(stem)
  stem = stripTrailingNoise(stem)
  stem = stem.trim()

  const authorTitle = splitAuthorTitle(stem)
  if (authorTitle) {
    return {
      title: authorTitle.title,
      bookTitle: authorTitle.title,
      author: authorTitle.author,
      format
    }
  }

  const titleAuthor = splitTitleAuthor(stem)
  if (titleAuthor) {
    return {
      title: titleAuthor.title,
      bookTitle: titleAuthor.title,
      author: titleAuthor.author,
      format
    }
  }

  return { title: stem, bookTitle: stem, author: null, format }
}
