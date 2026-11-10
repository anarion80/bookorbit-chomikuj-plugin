/**
 * Tests for local format selection and `FileId` deduplication.
 *
 * The filter is pure and returns the original raw Chomikuj records, so every
 * case pins the contract the search pipeline relies on: archives can never be
 * selected, only importable formats survive, non-array input is empty, and
 * deduplication keeps the first occurrence without disturbing order.
 */

import { IMPORTABLE_EBOOK_FORMATS } from '../src/lib/filename.mjs'
import { dedupeByFileId, selectFormats } from '../src/lib/filter.mjs'

// Optional; `verify.mjs --only` matches this as well as the filename.
export const testName = 'format filter'

/**
 * An importable Chomikuj row. Overrides let each case change exactly the field
 * under test.
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

function fileIds(records) {
  return records.map((entry) => entry.FileId)
}

export default async function run(h) {
  // --- mixed formats selected down to one or two -----------------------------
  const mixed = [
    record({ FileId: 1, FileType: 'epub' }),
    record({ FileId: 2, FileType: 'pdf' }),
    record({ FileId: 3, FileType: 'mobi' })
  ]

  h.expectEqual(fileIds(selectFormats(mixed, ['epub'])), [1], 'selects only epub from a mixed set')
  h.expectEqual(
    fileIds(selectFormats(mixed, ['epub', 'pdf'])),
    [1, 2],
    'selects epub and pdf from a mixed set'
  )
  h.expectEqual(
    fileIds(selectFormats(mixed, ['mobi', 'pdf'])),
    [2, 3],
    'selection follows the incoming record order, not the formats order'
  )
  h.expectEqual(
    fileIds(selectFormats(mixed, ['EPUB', '.PDF'])),
    [1, 2],
    'selection normalizes uppercase and dot-prefixed formats'
  )
  h.ok('selection preserves the original record objects', selectFormats(mixed, ['epub'])[0] === mixed[0])

  // --- uppercase and dot-prefixed record formats -----------------------------
  const uppercaseType = record({ FileType: 'EPUB' })
  const dottedType = record({ FileType: '.EPUB' })
  const uppercaseName = record({
    FileName: 'Synthetic Author - Testowa Książka.EPUB',
    FileType: undefined
  })

  h.expectEqual(
    fileIds(selectFormats([uppercaseType], ['epub'])),
    [200000001],
    'uppercase FileType EPUB matches the epub selection'
  )
  h.expectEqual(
    fileIds(selectFormats([dottedType], ['epub'])),
    [200000001],
    'dot-prefixed FileType .EPUB matches the epub selection'
  )
  h.expectEqual(
    fileIds(selectFormats([uppercaseName], ['epub'])),
    [200000001],
    'uppercase extension in FileName normalizes to epub'
  )

  // --- archives are never selected, even explicitly --------------------------
  const archiveNames = ['book.zip', 'book.cbz', 'book.cbr']
  for (const name of archiveNames) {
    const row = record({ FileId: 10, FileName: name, FileType: undefined })
    h.expectEqual(selectFormats([row]), [], `${name} is dropped by default`)
    h.expectEqual(selectFormats([row], ['zip']), [], `${name} stays dropped with formats ['zip']`)
    h.expectEqual(selectFormats([row], ['cbz']), [], `${name} stays dropped with formats ['cbz']`)
  }
  h.expectEqual(
    selectFormats(mixed, ['zip']),
    [],
    'formats [zip] yields zero results instead of returning an archive'
  )
  h.expectEqual(
    fileIds(selectFormats([...mixed, record({ FileId: 4, FileName: 'book.zip', FileType: undefined })], ['zip', 'epub'])),
    [1],
    'an importable selection coexisting with an archive selection keeps only the importable row'
  )
  h.ok(
    'archive FileType CBZ stays dropped even when selected',
    selectFormats([record({ FileName: 'book', FileType: 'CBZ' })], ['cbz']).length === 0
  )

  // --- non-importable document formats are dropped ---------------------------
  const documents = ['book.txt', 'book.doc', 'book.docx'].map((name, index) =>
    record({ FileId: 20 + index, FileName: name, FileType: undefined })
  )
  h.expectEqual(selectFormats(documents), [], 'txt, doc, and docx are dropped')
  h.expectEqual(
    selectFormats(documents, ['txt', 'doc']),
    [],
    'txt and doc selections do not admit non-importable documents'
  )

  // --- empty format is dropped ----------------------------------------------
  h.expectEqual(
    selectFormats([record({ FileName: '', FileType: undefined })]),
    [],
    'a record with no parseable format is dropped'
  )

  // --- omitted, undefined, empty, and non-array formats accept all -----------
  const importable = IMPORTABLE_EBOOK_FORMATS.map((format, index) =>
    record({ FileId: 100 + index, FileName: `Synthetic Book ${format}`, FileType: format })
  )

  h.expectEqual(selectFormats(importable), importable, 'omitted formats accepts every importable format')
  h.expectEqual(
    selectFormats(importable, undefined),
    importable,
    'undefined formats accepts every importable format'
  )
  h.expectEqual(selectFormats(importable, []), importable, 'empty formats accepts every importable format')
  h.expectEqual(
    selectFormats(importable, 'epub'),
    importable,
    'non-array formats accepts every importable format'
  )
  h.expectEqual(
    selectFormats([...importable, ...documents, record({ FileName: 'book.zip', FileType: undefined })]),
    importable,
    'accept-all mode still drops documents and archives'
  )

  // --- fixture rows ----------------------------------------------------------
  const page = h.loadFixture('search-page1.json')
  const fixtureRecords = page.Results
  h.expectEqual(
    fileIds(selectFormats(fixtureRecords)),
    [200000001, 200000002, 200000003],
    'the mixed search fixture survives the default filter'
  )
  h.expectEqual(
    fileIds(selectFormats(fixtureRecords, ['pdf'])),
    [200000002],
    'the mixed search fixture filters down to pdf'
  )

  // --- deduplication ---------------------------------------------------------
  const first = record({ FileId: 7, FileName: 'First' })
  const second = record({ FileId: 8, FileName: 'Second' })
  const duplicate = record({ FileId: 7, FileName: 'Duplicate' })
  const deduped = dedupeByFileId([first, second, duplicate])

  h.expectEqual(deduped.length, 2, 'duplicate FileId yields one row')
  h.ok('dedupe keeps the first occurrence object', deduped[0] === first)
  h.ok('dedupe keeps the later unique object', deduped[1] === second)
  h.expectEqual(fileIds(deduped), [7, 8], 'dedupe preserves the incoming order')
  h.expectEqual(
    fileIds(dedupeByFileId([second, first, duplicate])),
    [8, 7],
    'dedupe order tracks the input, not the FileId values'
  )
  h.expectEqual(
    fileIds(dedupeByFileId([record({ FileId: '7' }), record({ FileId: 7 })])),
    ['7'],
    'string and numeric FileId forms share one key'
  )

  // --- records without a usable FileId survive -------------------------------
  const noIdA = { FileName: 'No Identifier A', FileType: 'epub' }
  const noIdB = { FileName: 'No Identifier B', FileType: 'pdf' }
  const emptyId = record({ FileId: '', FileName: 'Empty Identifier' })
  const unkeyed = dedupeByFileId([first, noIdA, first, noIdB, emptyId])

  h.expectEqual(unkeyed.length, 4, 'records without a usable FileId are preserved')
  h.ok('a missing FileId row survives dedupe', unkeyed[1] === noIdA)
  h.ok('a second missing FileId row survives dedupe', unkeyed[2] === noIdB)
  h.ok('an empty FileId row survives dedupe', unkeyed[3] === emptyId)

  // --- non-array input -------------------------------------------------------
  for (const value of [null, undefined, 'records', 42, {}]) {
    h.expectEqual(selectFormats(value), [], `selectFormats(${String(value)}) -> []`)
    h.expectEqual(dedupeByFileId(value), [], `dedupeByFileId(${String(value)}) -> []`)
  }
}
