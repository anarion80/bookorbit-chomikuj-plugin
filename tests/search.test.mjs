/**
 * Tests for the paginated Chomikuj document search.
 *
 * A scripted fake client records every `searchPage` call, so the assertions
 * pin the exact query text, page numbers, and the optional `Extension`. Time
 * is injected through `now`/`budgetMs`, so no case waits on the real budget.
 */

import { MAX_PAGES, SEARCH_BUDGET_MS, searchFiles } from '../src/lib/search.mjs'

// Optional; `verify.mjs --only` matches this as well as the filename.
export const testName = 'search'

const API_KEY = 'synthetic-api-key-search-0000-0000-000000000000'

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

function stoppedAt(body) {
  return { ...body, IsNextPageAvailable: false }
}

function file(fileId) {
  return {
    FileId: fileId,
    FileName: `Synthetic Author - File ${fileId}.epub`,
    FileType: 'epub',
    Size: 1024,
    MediaType: 'Documents',
    IsFileFreeForUser: true
  }
}

async function capture(promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

export default async function run(h) {
  const host = h.createMockHost()
  const session = { apiKey: API_KEY }
  const page1 = h.loadFixture('search-page1.json')
  const page2 = h.loadFixture('search-page2.json')

  h.expectEqual(SEARCH_BUDGET_MS, 12000, 'constants: self-budget is 12 s')
  h.expectEqual(MAX_PAGES, 3, 'constants: page cap is 3')

  // --- exact Query from a trimmed title and author ------------------------
  {
    const client = createFakeClient([stoppedAt(page1), stoppedAt(page1)])
    const rows = await searchFiles({
      client,
      session,
      query: {
        title: '  Testowa Książka  ',
        author: '  Synthetic Author  ',
        isbn13: '9780000000000'
      },
      formats: ['epub'],
      limit: 20,
      host
    })

    h.expectEqual(client.calls.length, 2, 'title+author: one page per normalization form')
    h.expectEqual(client.calls[0].apiKey, API_KEY, 'title+author: sends the session ApiKey')
    h.expectEqual(
      client.calls[0].query,
      'Testowa Książka Synthetic Author'.normalize('NFC'),
      'title+author: trims and joins into the exact NFC Query'
    )
    h.expectEqual(
      client.calls[1].query,
      'Testowa Książka Synthetic Author'.normalize('NFD'),
      'title+author: second request uses the NFD form'
    )
    h.expectEqual(client.calls[0].page, 1, 'title+author: first request is PageNumber 1')
    h.expectEqual(
      client.calls[1].page,
      1,
      'title+author: NFD request also starts at PageNumber 1'
    )
    h.expectEqual(client.calls[0].extension, 'epub', 'title+author: single format sends Extension')
    h.expectEqual(
      client.calls[1].extension,
      'epub',
      'title+author: NFD request also sends Extension'
    )
    h.ok(
      'title+author: passes a per-page AbortSignal',
      client.calls[0].signal instanceof AbortSignal
    )
    h.ok(
      'title+author: a fresh per-page signal is not aborted',
      !client.calls[0].signal.aborted
    )
    h.ok(
      'title+author: NFD request passes a per-page AbortSignal',
      client.calls[1].signal instanceof AbortSignal
    )
    h.ok(
      'title+author: NFD per-page signal is not aborted',
      !client.calls[1].signal.aborted
    )
    h.expectEqual(
      rows,
      [...page1.Results, ...page1.Results],
      'title+author: merges raw Results rows from both normalization forms'
    )
  }

  // --- a Polish query tries NFD after an empty NFC page --------------------
  {
    const nfcQuery = 'Twarz Księżyca Parnicki'.normalize('NFC')
    const nfdQuery = nfcQuery.normalize('NFD')
    const target = file(8850790304)
    const client = createFakeClient([
      stoppedAt({ Results: [] }),
      stoppedAt({ Results: [target] })
    ])
    const rows = await searchFiles({
      client,
      session,
      query: { title: 'Twarz Księżyca', author: 'Parnicki' },
      formats: ['epub'],
      limit: 20,
      host
    })

    h.ok('polish: NFC and NFD differ', nfcQuery !== nfdQuery)
    h.expectEqual(client.calls.length, 2, 'polish: requests both normalization forms')
    h.expectEqual(client.calls[0].query, nfcQuery, 'polish: first request uses NFC')
    h.expectEqual(client.calls[1].query, nfdQuery, 'polish: second request uses NFD')
    h.expectEqual(client.calls[1].page, 1, 'polish: NFD request starts at PageNumber 1')
    h.ok(
      'polish: returns the NFD-only target row',
      rows.some((row) => row?.FileId === target.FileId)
    )
  }

  // --- an ASCII query collapses to one normalization variant --------------
  {
    const client = createFakeClient([stoppedAt(page1)])
    await searchFiles({
      client,
      session,
      query: { title: 'Test' },
      formats: ['epub'],
      limit: 20,
      host
    })

    h.expectEqual(client.calls.length, 1, 'ASCII: sends only one query variant')
    h.expectEqual(client.calls[0].query, 'Test', 'ASCII: query is unchanged')
  }

  // --- ISBN-only query and no Extension for multiple formats --------------
  {
    const client = createFakeClient([stoppedAt(page1)])
    const rows = await searchFiles({
      client,
      session,
      query: { isbn13: ' 9781234567890 ' },
      formats: ['epub', 'pdf'],
      limit: 20,
      host
    })

    h.expectEqual(client.calls.length, 1, 'ISBN-only: one page request')
    h.expectEqual(client.calls[0].query, '9781234567890', 'ISBN-only: uses the ISBN as Query')
    h.ok(
      'multiple formats: Extension is omitted entirely',
      !Object.hasOwn(client.calls[0], 'extension')
    )
    h.expectEqual(rows, page1.Results, 'ISBN-only: returns raw Results rows')
  }

  // --- empty query fails through host.fail without a request --------------
  {
    const client = createFakeClient([])
    const error = await capture(
      searchFiles({
        client,
        session,
        query: { title: '   ', author: '', isbn13: '  ' },
        formats: ['epub'],
        limit: 20,
        host
      })
    )

    h.ok('empty query: throws an Error', error instanceof Error)
    h.expectEqual(error?.failure, 'error', 'empty query: failure is error')
    h.expectEqual(
      error?.message,
      'Chomikuj search needs a title, author, or ISBN',
      'empty query: clear message'
    )
    h.expectEqual(client.calls.length, 0, 'empty query: makes no request')
  }

  // --- two pages merge in order, then IsNextPageAvailable:false stops -----
  {
    const client = createFakeClient([page1, page2])
    const rows = await searchFiles({
      client,
      session,
      query: { title: 'Testowa' },
      formats: ['epub'],
      limit: 20,
      host
    })

    h.expectEqual(client.calls.length, 2, 'two pages: requests page 2')
    h.expectEqual(client.calls[1].page, 2, 'two pages: second request is PageNumber 2')
    h.expectEqual(
      rows,
      [...page1.Results, ...page2.Results],
      'two pages: merges rows in API order'
    )
  }

  {
    const client = createFakeClient([stoppedAt(page1)])
    await searchFiles({
      client,
      session,
      query: { title: 'Testowa' },
      formats: ['epub'],
      limit: 20,
      host
    })

    h.expectEqual(
      client.calls.length,
      1,
      'IsNextPageAvailable false: stops after the first page'
    )
  }

  // --- abort after page 1 returns the collected rows ----------------------
  {
    const controller = new AbortController()
    const client = createFakeClient([
      () => {
        controller.abort()
        return { ...page1, IsNextPageAvailable: true }
      }
    ])
    const rows = await searchFiles({
      client,
      session,
      query: { title: 'Testowa' },
      formats: ['epub'],
      limit: 100,
      signal: controller.signal,
      host
    })

    h.expectEqual(client.calls.length, 1, 'abort: does not request page 2')
    h.expectEqual(rows, page1.Results, 'abort: returns the page-1 rows')
  }

  // --- exhausted budget returns partial rows without throwing -------------
  {
    let clock = 0
    const budgetMs = 100
    const client = createFakeClient([
      () => {
        clock = budgetMs
        return { ...page1, IsNextPageAvailable: true }
      }
    ])
    const rows = await searchFiles({
      client,
      session,
      query: { title: 'Testowa' },
      formats: ['epub'],
      limit: 100,
      host,
      now: () => clock,
      budgetMs
    })

    h.expectEqual(client.calls.length, 1, 'budget: stops before requesting page 2')
    h.expectEqual(rows, page1.Results, 'budget: returns partial rows without throwing')
  }

  // --- first-page failure rethrows, later-page failure returns partial ----
  {
    const failure = new Error('synthetic first-page failure')
    const client = createFakeClient([failure])
    const error = await capture(
      searchFiles({
        client,
        session,
        query: { title: 'Testowa' },
        formats: ['epub'],
        limit: 20,
        host
      })
    )

    h.expectEqual(error, failure, 'first-page failure: rethrows the original error')
  }

  {
    const failure = new Error('synthetic second-page failure')
    const client = createFakeClient([page1, failure])
    const rows = await searchFiles({
      client,
      session,
      query: { title: 'Testowa' },
      formats: ['epub'],
      limit: 20,
      host
    })

    h.expectEqual(client.calls.length, 2, 'later-page failure: page 2 was attempted')
    h.expectEqual(rows, page1.Results, 'later-page failure: returns partial rows')
  }

  // --- a non-array Results payload on page 1 fails through host.fail ------
  {
    const client = createFakeClient([{ Results: 'not-an-array', IsNextPageAvailable: true }])
    const error = await capture(
      searchFiles({
        client,
        session,
        query: { title: 'Testowa' },
        formats: ['epub'],
        limit: 20,
        host
      })
    )

    h.ok('invalid Results: throws an Error', error instanceof Error)
    h.expectEqual(error?.failure, 'error', 'invalid Results: failure is error')
    h.ok(
      'invalid Results: message names Results',
      /Results/.test(error?.message ?? '')
    )
  }

  // --- never exceeds MAX_PAGES --------------------------------------------
  {
    const openPage = (ids) => ({ Results: ids.map(file), IsNextPageAvailable: true })
    const client = createFakeClient([
      openPage([1]),
      openPage([2]),
      openPage([3]),
      openPage([4])
    ])
    const rows = await searchFiles({
      client,
      session,
      query: { title: 'Testowa' },
      formats: ['epub'],
      limit: 100,
      host
    })

    h.expectEqual(client.calls.length, MAX_PAGES, 'page cap: stops at MAX_PAGES requests')
    h.expectEqual(
      client.calls.map((call) => call.page),
      [1, 2, 3],
      'page cap: requests pages 1-3 only'
    )
    h.expectEqual(rows.length, 3, 'page cap: keeps the rows from those pages')
  }

  // --- unique FileId pool target stops pagination without deduping --------
  {
    const client = createFakeClient([
      { Results: [file(10), file(11)], IsNextPageAvailable: true },
      { Results: [file(11), file(12)], IsNextPageAvailable: true },
      { Results: [file(13)], IsNextPageAvailable: true }
    ])
    const rows = await searchFiles({
      client,
      session,
      query: { title: 'Testowa' },
      formats: ['epub'],
      limit: 1,
      host
    })

    h.expectEqual(
      client.calls.length,
      2,
      'pool target: stops when unique FileIds reach limit * 3'
    )
    h.expectEqual(
      rows.map((row) => row.FileId),
      [10, 11, 11, 12],
      'pool target: returns raw rows, duplicates included'
    )
  }

  // --- limit is normalized to at least 1 ----------------------------------
  {
    const client = createFakeClient([
      { Results: [file(20)], IsNextPageAvailable: true },
      { Results: [file(21)], IsNextPageAvailable: true },
      { Results: [file(22)], IsNextPageAvailable: true }
    ])
    await searchFiles({
      client,
      session,
      query: { title: 'Testowa' },
      formats: ['epub'],
      limit: 0,
      host
    })

    h.expectEqual(client.calls.length, 3, 'limit 0: normalized to a target of 3 unique FileIds')
  }
}
