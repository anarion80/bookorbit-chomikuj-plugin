/**
 * Tests for mapping Chomikuj search rows to BookOrbit release candidates.
 *
 * The mapper is pure, so every case pins the exact contract: which identifiers
 * are required, how sizes and formats are normalized, what is dropped, and
 * which BookOrbit fields must never be invented.
 */

import { IMPORTABLE_EBOOK_FORMATS } from '../src/lib/filename.mjs'
import { toCandidate } from '../src/lib/map.mjs'

// Optional; `verify.mjs --only` matches this as well as the filename.
export const testName = 'map'

/**
 * A complete, importable Chomikuj row. Overrides let each case change exactly
 * the field under test.
 */
function record(overrides = {}) {
  return {
    FileId: 200000001,
    FileName: 'Synthetic Author - Testowa Książka',
    FileType: 'epub',
    Size: 1024,
    IsFileFreeForUser: true,
    ...overrides
  }
}

function omit(source, key) {
  const copy = { ...source }
  delete copy[key]
  return copy
}

const FULL_EXPECTED = {
  guid: '200000001',
  title: 'Testowa Książka',
  bookTitle: 'Testowa Książka',
  author: 'Synthetic Author',
  format: 'epub',
  language: null,
  sizeBytes: 1048576,
  seeders: null,
  leechers: null,
  primaryFileCount: 1,
  fileCount: 1,
  freeleech: true
}

const EXPECTED_KEYS = [
  'author',
  'bookTitle',
  'fileCount',
  'format',
  'freeleech',
  'guid',
  'language',
  'leechers',
  'primaryFileCount',
  'seeders',
  'sizeBytes',
  'title'
]

const FORBIDDEN_FIELDS = [
  'publishedAt',
  'infoUrl',
  'downloadUrl',
  'Owner',
  'SmallThumbnailImg',
  'ThumbnailImg',
  'StreamingUrl',
  'FolderId',
  'FolderName'
]

export default async function run(h) {
  // --- full fixture record ---------------------------------------------------
  const page = h.loadFixture('search-page1.json')
  const fixtureRecord = page.Results[0]
  h.expectEqual(
    toCandidate(fixtureRecord),
    FULL_EXPECTED,
    'full fixture record maps to the exact expected candidate'
  )

  // --- size is reported in kilobytes ----------------------------------------
  h.expectEqual(
    toCandidate(record({ Size: 1024 }))?.sizeBytes,
    1048576,
    'Size 1024 kB becomes 1048576 bytes'
  )
  h.expectEqual(toCandidate(record({ Size: 1 }))?.sizeBytes, 1024, 'Size 1 kB becomes 1024 bytes')
  h.expectEqual(
    toCandidate(record({ Size: 0 }))?.sizeBytes,
    null,
    'Size 0 becomes null instead of zero bytes'
  )
  h.expectEqual(
    toCandidate(omit(record(), 'Size'))?.sizeBytes,
    null,
    'missing Size becomes null'
  )
  h.expectEqual(
    toCandidate(record({ Size: undefined }))?.sizeBytes,
    null,
    'undefined Size becomes null'
  )
  h.expectEqual(toCandidate(record({ Size: null }))?.sizeBytes, null, 'null Size becomes null')
  h.expectEqual(
    toCandidate(record({ Size: -5 }))?.sizeBytes,
    null,
    'negative Size becomes null'
  )
  h.expectEqual(
    toCandidate(record({ Size: 'not-a-number' }))?.sizeBytes,
    null,
    'non-numeric Size becomes null'
  )

  // --- required identifiers --------------------------------------------------
  const missingIdCases = [
    ['missing FileId', omit(record(), 'FileId')],
    ['undefined FileId', record({ FileId: undefined })],
    ['null FileId', record({ FileId: null })],
    ['empty FileId', record({ FileId: '' })],
    ['whitespace FileId', record({ FileId: '   ' })]
  ]
  for (const [label, value] of missingIdCases) {
    h.ok(`${label} -> null`, toCandidate(value) === null)
  }

  const missingNameCases = [
    ['missing FileName', omit(record(), 'FileName')],
    ['undefined FileName', record({ FileName: undefined })],
    ['null FileName', record({ FileName: null })],
    ['empty FileName', record({ FileName: '' })],
    ['whitespace FileName', record({ FileName: '   ' })],
    ['non-string FileName', record({ FileName: 42 })]
  ]
  for (const [label, value] of missingNameCases) {
    h.ok(`${label} -> null`, toCandidate(value) === null)
  }

  h.ok('null record -> null', toCandidate(null) === null)
  h.ok('undefined record -> null', toCandidate(undefined) === null)

  // --- archives are never candidates ----------------------------------------
  for (const name of ['book.zip', 'book.cbz', 'book.rar']) {
    h.ok(
      `${name} -> null`,
      toCandidate(record({ FileName: name, FileType: undefined })) === null
    )
  }
  h.ok(
    'archive FileType -> null',
    toCandidate(record({ FileName: 'book', FileType: 'CBZ' })) === null
  )
  h.ok(
    'archive stays dropped even when explicitly selected',
    toCandidate(record({ FileName: 'book.zip', FileType: undefined }), { formats: ['zip'] }) ===
      null
  )

  // --- non-importable document formats --------------------------------------
  for (const name of ['book.txt', 'book.doc', 'book.docx']) {
    h.ok(
      `${name} -> null`,
      toCandidate(record({ FileName: name, FileType: undefined })) === null
    )
  }

  // --- format selection ------------------------------------------------------
  h.ok(
    'format outside the selected formats -> null',
    toCandidate(record({ FileName: 'Synthetic Author - Testowa Książka', FileType: 'pdf' }), {
      formats: ['epub']
    }) === null
  )
  h.ok(
    'omitted formats accepts every importable format',
    IMPORTABLE_EBOOK_FORMATS.every(
      (format) =>
        toCandidate(record({ FileName: 'Synthetic Author - Testowa Książka', FileType: format })) !==
        null
    )
  )
  h.ok('empty formats accepts an importable format', toCandidate(record(), { formats: [] }) !== null)
  h.ok(
    'formats compares lowercase, dotless values',
    toCandidate(record({ FileType: 'epub' }), { formats: ['.EPUB'] }) !== null
  )
  h.ok(
    'selected format matches a lowercase, dotless FileType',
    toCandidate(record({ FileType: '.PDF' }), { formats: ['pdf'] }) !== null
  )

  // --- format normalization --------------------------------------------------
  h.expectEqual(
    toCandidate(record({ FileType: 'EPUB' }))?.format,
    'epub',
    'uppercase FileType normalizes to lowercase'
  )
  h.expectEqual(
    toCandidate(record({ FileType: '.EPUB' }))?.format,
    'epub',
    'dot-prefixed FileType normalizes to a bare lowercase format'
  )

  // --- freeleech -------------------------------------------------------------
  h.expectEqual(
    toCandidate(record({ IsFileFreeForUser: true }))?.freeleech,
    true,
    'IsFileFreeForUser true -> freeleech true'
  )
  h.expectEqual(
    toCandidate(record({ IsFileFreeForUser: false }))?.freeleech,
    false,
    'IsFileFreeForUser false -> freeleech false'
  )
  h.expectEqual(
    toCandidate(omit(record(), 'IsFileFreeForUser'))?.freeleech,
    false,
    'missing IsFileFreeForUser -> freeleech false'
  )

  // --- guid ------------------------------------------------------------------
  h.expectEqual(
    toCandidate(record({ FileId: 987654321 }))?.guid,
    '987654321',
    'numeric FileId becomes a string guid'
  )
  h.expectEqual(
    toCandidate(record({ FileId: ' 987654321 ' }))?.guid,
    '987654321',
    'string FileId is trimmed into the guid'
  )

  // --- title/author fallbacks ------------------------------------------------
  const fallback = toCandidate(record({ FileName: '[PL]' }))
  h.expectEqual(fallback?.title, '[PL]', 'empty parsed title falls back to the raw FileName')
  h.expectEqual(
    fallback?.bookTitle,
    '[PL]',
    'bookTitle falls back to the raw FileName with the title'
  )

  const uploaderOnly = toCandidate({
    ...record({ FileName: 'NoSeparator' }),
    Owner: { Id: '90000001', Name: 'synthetic-uploader' }
  })
  h.ok('parser title survives without an author', uploaderOnly?.title === 'NoSeparator')
  h.ok(
    'Owner/uploader is never used as the author',
    uploaderOnly?.author === undefined && uploaderOnly?.author !== 'synthetic-uploader'
  )

  // --- exact field set -------------------------------------------------------
  const candidate = toCandidate({
    ...record(),
    Owner: { Id: '90000001', Name: 'synthetic-uploader' },
    FolderId: 40000001,
    FolderName: 'Synthetic Ebooks',
    SmallThumbnailImg: 'https://example.invalid/thumbs/200000001-small.jpg',
    ThumbnailImg: 'https://example.invalid/thumbs/200000001.jpg',
    StreamingUrl: 'https://example.invalid/stream/200000001'
  })
  h.ok('full record maps with extra API fields present', candidate !== null)
  h.expectEqual(
    Object.keys(candidate).sort(),
    EXPECTED_KEYS,
    'candidate exposes exactly the mapped BookOrbit fields'
  )
  for (const field of FORBIDDEN_FIELDS) {
    h.ok(`candidate does not add ${field}`, !(field in candidate))
  }
  h.expectEqual(candidate.author, 'Synthetic Author', 'author comes from the filename parser')
}
