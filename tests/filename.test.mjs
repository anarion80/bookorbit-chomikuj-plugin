/**
 * Tests for the pure filename/format parser.
 *
 * The module is dependency-free, so these cases double as the executable
 * specification for how Chomikuj `FileName`/`FileType` pairs map to BookOrbit
 * title, author, and format metadata.
 */

import {
  ARCHIVE_EXTENSIONS,
  IMPORTABLE_EBOOK_FORMATS,
  isArchiveExtension,
  normalizeFormat,
  parseFileName
} from '../src/lib/filename.mjs'

export const testName = 'filename parser'

const EXPECTED_IMPORTABLE = ['epub', 'kepub', 'mobi', 'azw3', 'azw', 'fb2', 'pdf', 'djvu']
const EXPECTED_ARCHIVES = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'cbz', 'cbr', 'cb7', 'cbt']

const PARSER_CASES = [
  {
    fileName: 'Author - Title.epub',
    fileType: undefined,
    expected: { title: 'Title', bookTitle: 'Title', author: 'Author', format: 'epub' },
    label: 'parses "Author - Title.ext"'
  },
  {
    fileName: 'Synthetic Author - Testowa Książka',
    fileType: 'epub',
    expected: {
      title: 'Testowa Książka',
      bookTitle: 'Testowa Książka',
      author: 'Synthetic Author',
      format: 'epub'
    },
    label: 'parses a Chomikuj FileName without an extension using FileType'
  },
  {
    fileName: 'Title (Author).pdf',
    fileType: undefined,
    expected: { title: 'Title', bookTitle: 'Title', author: 'Author', format: 'pdf' },
    label: 'parses "Title (Author).ext"'
  },
  {
    fileName: '[PL] Author - Tytuł.epub',
    fileType: undefined,
    expected: { title: 'Tytuł', bookTitle: 'Tytuł', author: 'Author', format: 'epub' },
    label: 'strips a leading [PL] tag and preserves Polish diacritics'
  },
  {
    fileName: 'NoSeparator.mobi',
    fileType: undefined,
    expected: { title: 'NoSeparator', bookTitle: 'NoSeparator', author: null, format: 'mobi' },
    label: 'returns a null author when there is no clear separator'
  },
  {
    fileName: 'Author - Title.epub.epub',
    fileType: undefined,
    expected: { title: 'Title', bookTitle: 'Title', author: 'Author', format: 'epub' },
    label: 'strips a duplicated trailing extension'
  },
  {
    fileName: 'Author - Comic Book.cbz',
    fileType: undefined,
    expected: {
      title: 'Comic Book',
      bookTitle: 'Comic Book',
      author: 'Author',
      format: 'cbz'
    },
    label: 'parses an archive filename without treating it as importable'
  },
  {
    fileName: 'Author - Title',
    fileType: 'PDF',
    expected: { title: 'Title', bookTitle: 'Title', author: 'Author', format: 'pdf' },
    label: 'handles a missing extension and normalizes an uppercase FileType'
  },
  {
    fileName: 'Author - Title.epub',
    fileType: 'MOBI',
    expected: { title: 'Title', bookTitle: 'Title', author: 'Author', format: 'mobi' },
    label: 'prefers FileType over the filename extension'
  },
  {
    fileName: 'Title (Author) (ebook).epub',
    fileType: undefined,
    expected: { title: 'Title', bookTitle: 'Title', author: 'Author', format: 'epub' },
    label: 'strips trailing "(ebook)" noise before parsing the author'
  },
  {
    fileName: '[ENG][EBOOK] Author - Title.pdf',
    fileType: undefined,
    expected: { title: 'Title', bookTitle: 'Title', author: 'Author', format: 'pdf' },
    label: 'strips multiple leading language/format tags'
  },
  {
    fileName: 'Title (Author) [EPUB]',
    fileType: 'epub',
    expected: { title: 'Title', bookTitle: 'Title', author: 'Author', format: 'epub' },
    label: 'strips a trailing [EPUB] tag before parsing the author'
  },
  {
    fileName: '[PL] Jan Kowalski - Żółć gęślą jaźń.fb2',
    fileType: undefined,
    expected: {
      title: 'Żółć gęślą jaźń',
      bookTitle: 'Żółć gęślą jaźń',
      author: 'Jan Kowalski',
      format: 'fb2'
    },
    label: 'preserves Polish diacritics in both author and title'
  },
  {
    fileName: 'Zbrodnia i kara (Fiodor Dostojewski)',
    fileType: '.epub',
    expected: {
      title: 'Zbrodnia i kara',
      bookTitle: 'Zbrodnia i kara',
      author: 'Fiodor Dostojewski',
      format: 'epub'
    },
    label: 'handles a dot-prefixed FileType and an extensionless FileName'
  },
  {
    fileName: '  Author - Title.azw3  ',
    fileType: undefined,
    expected: { title: 'Title', bookTitle: 'Title', author: 'Author', format: 'azw3' },
    label: 'trims surrounding whitespace'
  },
  {
    fileName: 'NoSeparator',
    fileType: undefined,
    expected: { title: 'NoSeparator', bookTitle: 'NoSeparator', author: null, format: '' },
    label: 'leaves the format empty when neither FileType nor extension is present'
  },
  {
    fileName: 'book.zip',
    fileType: undefined,
    expected: { title: 'book', bookTitle: 'book', author: null, format: 'zip' },
    label: 'parses an archive with no author and format zip'
  },
  {
    fileName: 'Title (2020).djvu',
    fileType: undefined,
    expected: { title: 'Title (2020)', bookTitle: 'Title (2020)', author: null, format: 'djvu' },
    label: 'does not mistake a year in parentheses for an author'
  },
  {
    fileName: 'Author - Podtytuł - Tom 2.kepub',
    fileType: undefined,
    expected: {
      title: 'Podtytuł - Tom 2',
      bookTitle: 'Podtytuł - Tom 2',
      author: 'Author',
      format: 'kepub'
    },
    label: 'splits on the first author/title separator only'
  }
]

export default async function run(h) {
  h.expectEqual(
    IMPORTABLE_EBOOK_FORMATS,
    EXPECTED_IMPORTABLE,
    'IMPORTABLE_EBOOK_FORMATS is exactly the supported ebook list'
  )
  h.expectEqual(
    ARCHIVE_EXTENSIONS,
    EXPECTED_ARCHIVES,
    'ARCHIVE_EXTENSIONS is exactly the documented archive list'
  )

  h.ok(
    'no importable format is an archive',
    IMPORTABLE_EBOOK_FORMATS.every((format) => !ARCHIVE_EXTENSIONS.includes(format))
  )
  h.ok(
    'archive extensions are never importable',
    ARCHIVE_EXTENSIONS.every((format) => !IMPORTABLE_EBOOK_FORMATS.includes(format))
  )
  h.ok(
    'txt, doc, and docx are rejected by omission',
    ['txt', 'doc', 'docx'].every((format) => !IMPORTABLE_EBOOK_FORMATS.includes(format))
  )

  // normalizeFormat: lowercase, trim, strip a leading dot, and reject non-strings.
  h.expectEqual(normalizeFormat('.EPUB'), 'epub', 'normalizeFormat strips a leading dot')
  h.expectEqual(normalizeFormat('  MoBi '), 'mobi', 'normalizeFormat trims and lowercases')
  h.expectEqual(normalizeFormat('azw3'), 'azw3', 'normalizeFormat leaves a bare format intact')
  h.expectEqual(normalizeFormat(''), '', 'normalizeFormat returns empty for an empty string')
  h.expectEqual(normalizeFormat('   '), '', 'normalizeFormat returns empty for whitespace')
  h.expectEqual(normalizeFormat(null), '', 'normalizeFormat returns empty for null')
  h.expectEqual(normalizeFormat(undefined), '', 'normalizeFormat returns empty for undefined')
  h.expectEqual(normalizeFormat(42), '', 'normalizeFormat returns empty for a number')

  // isArchiveExtension: true for every documented archive, false elsewhere.
  h.ok(
    'isArchiveExtension is true for every ARCHIVE_EXTENSIONS member',
    ARCHIVE_EXTENSIONS.every((format) => isArchiveExtension(format))
  )
  h.ok(
    'isArchiveExtension normalizes case and a leading dot',
    isArchiveExtension('.CBZ') && isArchiveExtension(' RAR ')
  )
  h.ok(
    'isArchiveExtension is false for importable and unsupported formats',
    !isArchiveExtension('epub') && !isArchiveExtension('pdf') && !isArchiveExtension('txt')
  )
  h.ok('isArchiveExtension rejects non-strings', !isArchiveExtension(null))

  let parserCases = 0
  for (const testCase of PARSER_CASES) {
    parserCases += 1
    h.expectEqual(
      parseFileName(testCase.fileName, testCase.fileType),
      testCase.expected,
      testCase.label
    )
  }
  h.ok('covers at least 12 parser cases', parserCases >= 12, `parser cases: ${parserCases}`)

  h.ok(
    'cbz/cbr are detected as archives',
    isArchiveExtension('cbz') && isArchiveExtension('cbr')
  )
}
