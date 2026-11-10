/**
 * End-to-end search pipeline test against the sanitized Chomikuj fixtures.
 *
 * The fake client only replaces the network boundary. The real modules run in
 * the production order - `searchFiles` -> `selectFormats` -> `dedupeByFileId`
 * -> `toCandidate` -> `orderByNewest` - so this file pins the exact rows,
 * candidates, ordering, and failure classes BookOrbit receives without ever
 * touching the network.
 */

import { dedupeByFileId, selectFormats } from '../src/lib/filter.mjs'
import { toCandidate } from '../src/lib/map.mjs'
import { orderByNewest } from '../src/lib/order.mjs'
import { searchFiles } from '../src/lib/search.mjs'

// Optional; `verify.mjs --only` matches this as well as the filename.
export const testName = 'pipeline'

const API_KEY = 'test-key'
const QUERY = { title: 'Test', author: 'Author' }
const FORBIDDEN_FIELDS = ['publishedAt', 'infoUrl', 'Owner']

function createFakeClient(steps) {
  const queue = [...steps]
  const calls = []

  async function searchPage(apiKey, options = {}) {
    calls.push({ apiKey, ...options })
    if (queue.length === 0) {
      throw new Error(`unexpected searchPage call #${calls.length}`)
    }
    const step = queue.shift()
    if (step instanceof Error) throw step
    if (typeof step === 'function') return step(options)
    return step
  }

  return { searchPage, calls }
}

/**
 * Build the already-classified error the real client would throw after it has
 * seen a status, Cloudflare challenge, or unusable payload.
 */
function classifiedError(failure, { status, code, retryable, message }) {
  const error = new Error(message ?? failure)
  error.failure = failure
  error.retryable = retryable
  error.status = status
  error.code = code
  return error
}

async function capture(promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

function ids(records) {
  return records.map((record) => record.FileId)
}

function guids(candidates) {
  return candidates.map((candidate) => candidate.guid)
}

function assertNoForbiddenFields(h, candidates, label) {
  for (const field of FORBIDDEN_FIELDS) {
    h.ok(
      `${label}: no ${field} field on any candidate`,
      candidates.every((candidate) => !Object.hasOwn(candidate, field))
    )
  }
}

/**
 * The exact production pipeline, kept explicit so each stage can be asserted.
 */
async function runPipeline({ client, formats, limit = 20, signal, host }) {
  const raw = await searchFiles({
    client,
    session: { apiKey: API_KEY },
    query: QUERY,
    formats,
    limit,
    host,
    ...(signal === undefined ? {} : { signal })
  })
  const selected = selectFormats(raw, formats)
  const unique = dedupeByFileId(selected)
  const candidates = unique.map((file) => toCandidate(file, { formats })).filter(Boolean)
  const ordered = orderByNewest(candidates)
  const final = ordered.slice(0, limit)
  return { raw, selected, unique, candidates, ordered, final }
}

export default async function run(h) {
  const host = h.createMockHost()
  const page1 = h.loadFixture('search-page1.json')
  const page2 = h.loadFixture('search-page2.json')

  // --- happy path: two pages, format selection, newest first, limit --------
  {
    const archive = {
      FileId: 200000005,
      FileName: 'Synthetic Author - Bundle.zip',
      FileType: 'zip',
      Size: 1024,
      MediaType: 'Documents',
      IsFileFreeForUser: true
    }
    const client = createFakeClient([
      page1,
      { ...page2, Results: [...page2.Results, archive] }
    ])
    const result = await runPipeline({
      client,
      formats: ['epub', 'pdf'],
      limit: 2,
      host
    })

    h.expectEqual(client.calls.length, 2, 'happy: requests both fixture pages')
    h.expectEqual(
      client.calls.map((call) => call.page),
      [1, 2],
      'happy: page numbers are 1 then 2'
    )
    h.expectEqual(client.calls[0].apiKey, API_KEY, 'happy: sends the session ApiKey')
    h.expectEqual(client.calls[0].query, 'Test Author', 'happy: joins the trimmed query text')
    h.ok(
      'happy: two selected formats omit the Extension hint',
      !Object.hasOwn(client.calls[0], 'extension')
    )
    h.expectEqual(result.raw.length, 5, 'happy: merges the raw rows of both pages')
    h.expectEqual(
      ids(result.selected),
      [200000001, 200000002, 200000004],
      'happy: drops the unselected mobi row and the archive'
    )
    h.expectEqual(
      guids(result.candidates),
      ['200000001', '200000002', '200000004'],
      'happy: maps every selected row to a candidate'
    )
    h.expectEqual(
      guids(result.ordered),
      ['200000004', '200000002', '200000001'],
      'happy: newest guid first'
    )
    h.expectEqual(
      guids(result.final),
      ['200000004', '200000002'],
      'happy: final slice(0, limit) truncates to the newest two'
    )
    h.ok(
      'happy: truncation really drops an ordered candidate',
      result.ordered.length === 3 && result.final.length === 2
    )
    h.expectEqual(
      result.final.map((candidate) => candidate.format),
      ['epub', 'pdf'],
      'happy: final candidates carry only the selected formats'
    )
    h.ok(
      'happy: the archive FileId never becomes a candidate',
      !result.candidates.some((candidate) => candidate.guid === '200000005')
    )
    h.ok(
      'happy: no archive format survives',
      !result.candidates.some((candidate) => candidate.format === 'zip')
    )
    assertNoForbiddenFields(h, result.candidates, 'happy')

    const row1 = result.ordered.find((candidate) => candidate.guid === '200000001') ?? null
    h.expectEqual(
      row1,
      {
        guid: '200000001',
        title: 'Testowa Książka',
        bookTitle: 'Testowa Książka',
        author: 'Synthetic Author',
        format: 'epub',
        language: null,
        sizeBytes: 1024 * 1024,
        seeders: null,
        leechers: null,
        primaryFileCount: 1,
        fileCount: 1,
        freeleech: true
      },
      'happy: a fixture row maps to the exact BookOrbit candidate'
    )
    h.expectEqual(
      Object.keys(row1 ?? {}).sort(),
      [
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
      ],
      'happy: candidate has exactly the BookOrbit fields, nothing fabricated'
    )
    h.ok(
      'happy: IsFileFreeForUser true survives as freeleech true',
      row1?.freeleech === true
    )
    h.expectEqual(
      result.ordered.find((candidate) => candidate.guid === '200000002')?.freeleech,
      false,
      'happy: IsFileFreeForUser false stays false'
    )
  }

  // --- deduplication across pages keeps the first occurrence ---------------
  {
    const duplicateRow = structuredClone(page1.Results[0])
    const extraRow = {
      FileId: 200000006,
      FileName: 'Synthetic Author - Extra Dedupe',
      FileType: 'epub',
      Size: 256,
      MediaType: 'Documents',
      IsFileFreeForUser: false
    }
    const client = createFakeClient([
      page1,
      { ...page2, Results: [duplicateRow, ...page2.Results, extraRow] }
    ])
    const result = await runPipeline({ client, formats: undefined, limit: 20, host })

    h.expectEqual(client.calls.length, 2, 'dedupe: reads both pages')
    h.expectEqual(result.raw.length, 6, 'dedupe: raw rows keep the cross-page duplicate')
    h.expectEqual(
      result.raw.filter((record) => record.FileId === 200000001).length,
      2,
      'dedupe: the fixture duplicate is really present in the raw rows'
    )
    h.expectEqual(result.selected.length, 6, 'dedupe: the local filter keeps both duplicates')
    h.expectEqual(
      ids(result.unique),
      [200000001, 200000002, 200000003, 200000004, 200000006],
      'dedupe: one row per FileId, in first-seen order'
    )
    h.ok(
      'dedupe: keeps the page-1 object for a duplicated FileId',
      result.unique[0] === page1.Results[0]
    )
    h.ok(
      'dedupe: drops the later duplicate object',
      !result.unique.includes(duplicateRow)
    )
    h.expectEqual(
      guids(result.ordered),
      ['200000006', '200000004', '200000003', '200000002', '200000001'],
      'dedupe: the deduplicated candidates still order newest first'
    )
    h.expectEqual(result.final.length, 5, 'dedupe: no row is lost after the limit slice')
  }

  // --- empty Results is a successful empty search -------------------------
  {
    const client = createFakeClient([{ Results: [], IsNextPageAvailable: false }])
    const result = await runPipeline({ client, formats: ['epub'], limit: 20, host })

    h.expectEqual(client.calls.length, 1, 'empty: makes one request')
    h.expectEqual(result.raw, [], 'empty: searchFiles returns no raw rows')
    h.expectEqual(result.selected, [], 'empty: format selection stays empty')
    h.expectEqual(result.candidates, [], 'empty: no candidates are mapped')
    h.expectEqual(result.final, [], 'empty: the pipeline returns [] instead of throwing')
  }

  // --- freeleech survives the full pipeline -------------------------------
  {
    const client = createFakeClient([page1, page2])
    const result = await runPipeline({ client, formats: ['epub'], limit: 20, host })

    h.expectEqual(
      guids(result.final),
      ['200000004', '200000001'],
      'freeleech: only the epub rows survive, newest first'
    )
    const free = result.final.find((candidate) => candidate.guid === '200000001')
    const paid = result.final.find((candidate) => candidate.guid === '200000004')
    h.ok('freeleech: the free fixture row keeps freeleech true', free?.freeleech === true)
    h.ok('freeleech: the paid fixture row keeps freeleech false', paid?.freeleech === false)
  }

  // --- abort after page 1 returns partial rows that still map/order -------
  {
    const controller = new AbortController()
    const client = createFakeClient([
      () => {
        controller.abort()
        return { ...page1, IsNextPageAvailable: true }
      }
    ])
    const result = await runPipeline({
      client,
      formats: undefined,
      limit: 20,
      signal: controller.signal,
      host
    })

    h.ok('abort: the caller signal is aborted', controller.signal.aborted)
    h.expectEqual(client.calls.length, 1, 'abort: page 2 is never requested')
    h.expectEqual(result.raw.length, 3, 'abort: keeps the page-1 rows')
    h.expectEqual(
      guids(result.ordered),
      ['200000003', '200000002', '200000001'],
      'abort: partial rows still map and order correctly'
    )
    h.expectEqual(result.final.length, 3, 'abort: all partial candidates survive the limit')
  }

  // --- formats ['zip'] cannot resurrect an archive ------------------------
  {
    const archive = {
      FileId: 200000007,
      FileName: 'Synthetic Author - Archive.zip',
      FileType: 'zip',
      Size: 999,
      MediaType: 'Documents',
      IsFileFreeForUser: true
    }
    const client = createFakeClient([
      { ...page1, Results: [...page1.Results, archive], IsNextPageAvailable: false }
    ])
    const result = await runPipeline({ client, formats: ['zip'], limit: 20, host })

    h.expectEqual(client.calls.length, 1, 'zip: one request when the first page is last')
    h.expectEqual(client.calls[0].extension, 'zip', 'zip: sends the single-format Extension hint')
    h.expectEqual(result.raw.length, 4, 'zip: the raw rows still contain the archive')
    h.expectEqual(result.selected, [], 'zip: selection drops every archive')
    h.expectEqual(result.unique, [], 'zip: dedupe stays empty')
    h.expectEqual(result.candidates, [], 'zip: the mapper cannot resurrect an archive')
    h.expectEqual(result.final, [], 'zip: the pipeline returns zero candidates')
  }

  // --- missing FileId/FileName rows are dropped by the mapper -------------
  {
    const noFileId = {
      FileName: 'Synthetic Author - No Identifier',
      FileType: 'epub',
      Size: 128,
      MediaType: 'Documents',
      IsFileFreeForUser: true
    }
    const noFileName = {
      FileId: 200000099,
      FileType: 'epub',
      Size: 128,
      MediaType: 'Documents',
      IsFileFreeForUser: true
    }
    const client = createFakeClient([
      {
        ...page1,
        Results: [...page1.Results, noFileId, noFileName],
        IsNextPageAvailable: false
      }
    ])
    const result = await runPipeline({ client, formats: ['epub'], limit: 20, host })

    h.expectEqual(client.calls.length, 1, 'missing fields: one request')
    h.expectEqual(result.raw.length, 5, 'missing fields: both unusable rows reach the filter')
    h.ok(
      'missing fields: a row without FileId survives format selection',
      result.selected.includes(noFileId)
    )
    h.ok(
      'missing fields: a row without FileName survives format selection',
      result.selected.includes(noFileName)
    )
    h.ok(
      'missing fields: the no-FileId row survives dedupe for the mapper to drop',
      result.unique.includes(noFileId)
    )
    h.ok(
      'missing fields: the no-FileName row survives dedupe for the mapper to drop',
      result.unique.includes(noFileName)
    )
    h.expectEqual(
      guids(result.candidates),
      ['200000001'],
      'missing fields: only the complete fixture row becomes a candidate'
    )
    h.ok(
      'missing fields: no candidate was emitted with an empty guid',
      result.candidates.every((candidate) => candidate.guid !== '')
    )
    h.ok(
      'missing fields: the FileId-only row never becomes a candidate',
      !result.candidates.some((candidate) => candidate.guid === '200000099')
    )
    h.expectEqual(result.final.length, 1, 'missing fields: one final candidate remains')
  }

  // --- first-page 401 becomes unauthorized --------------------------------
  {
    const client = createFakeClient([
      classifiedError('unauthorized', {
        status: 401,
        code: 401,
        retryable: false,
        message: 'unauthorized'
      })
    ])
    const error = await capture(runPipeline({ client, formats: ['epub'], limit: 20, host }))

    h.ok('401: the pipeline throws', error instanceof Error)
    h.expectEqual(error?.failure, 'unauthorized', '401: failure is unauthorized')
    h.expectEqual(error?.status, 401, '401: status is preserved')
    h.expectEqual(error?.retryable, false, '401: not retryable')
    h.expectEqual(client.calls.length, 1, '401: no page-2 request')
  }

  // --- first-page 429 becomes throttled -----------------------------------
  {
    const client = createFakeClient([
      classifiedError('throttled', {
        status: 429,
        code: 429,
        retryable: true,
        message: 'throttled'
      })
    ])
    const error = await capture(runPipeline({ client, formats: ['epub'], limit: 20, host }))

    h.ok('429: the pipeline throws', error instanceof Error)
    h.expectEqual(error?.failure, 'throttled', '429: failure is throttled')
    h.expectEqual(error?.status, 429, '429: status is preserved')
    h.expectEqual(error?.retryable, true, '429: retryable')
    h.expectEqual(client.calls.length, 1, '429: no page-2 request')
  }

  // --- first-page Cloudflare HTML becomes unreachable ---------------------
  {
    const client = createFakeClient([
      classifiedError('unreachable', {
        status: 403,
        code: 1020,
        retryable: true,
        message: 'cloudflare challenge'
      })
    ])
    const error = await capture(runPipeline({ client, formats: ['epub'], limit: 20, host }))

    h.ok('cloudflare HTML: the pipeline throws', error instanceof Error)
    h.expectEqual(error?.failure, 'unreachable', 'cloudflare HTML: failure is unreachable')
    h.expectEqual(error?.retryable, true, 'cloudflare HTML: retryable transport failure')
    h.ok(
      'cloudflare HTML: the error names the challenge',
      /cloudflare/i.test(error?.message ?? '')
    )
    h.expectEqual(client.calls.length, 1, 'cloudflare HTML: no page-2 request')
  }

  // --- first-page invalid Results becomes error ---------------------------
  {
    const client = createFakeClient([{ Results: 'not-an-array', IsNextPageAvailable: false }])
    const error = await capture(runPipeline({ client, formats: ['epub'], limit: 20, host }))

    h.ok('invalid Results: the pipeline throws', error instanceof Error)
    h.expectEqual(error?.failure, 'error', 'invalid Results: failure is error')
    h.ok(
      'invalid Results: the message names Results',
      /Results/.test(error?.message ?? '')
    )
    h.expectEqual(client.calls.length, 1, 'invalid Results: no page-2 request')
  }
}
