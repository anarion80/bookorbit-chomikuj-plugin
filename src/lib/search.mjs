/**
 * Paginated Chomikuj document search with a self-imposed time and page budget.
 *
 * The client owns the wire format: it always adds `MediaType=Documents` and
 * `PageNumber`, and adds `Extension` only when this module passes it. This
 * module returns the raw `payload.Results` rows in API order; mapping,
 * filtering, ordering, and deduplication belong to later modules.
 *
 * A later page failure, an exhausted budget, or an aborted caller signal
 * returns the rows collected so far instead of throwing, so one search attempt
 * never spends the host's whole deadline. Only a failed or unusable first page
 * is thrown.
 */

export const SEARCH_BUDGET_MS = 12000
export const MAX_PAGES = 3

const DEFAULT_LIMIT = 20

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_LIMIT
  return Math.max(1, Math.floor(numeric))
}

function buildQueryText(query) {
  const title = trimmed(query?.title)
  const author = trimmed(query?.author)
  const isbn = trimmed(query?.isbn13)

  if (title === '' && author === '' && isbn !== '') return isbn
  if (title !== '' || author !== '') return [title, author].filter(Boolean).join(' ')
  return ''
}

/** Combine the caller signal with a timeout for the remaining budget. */
function combineWithTimeout(signal, remainingMs) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs)))
  if (signal === undefined || signal === null) return timeout
  return AbortSignal.any([signal, timeout])
}

/**
 * Search Chomikuj for documents, merging raw result rows across up to three
 * pages within a 12 s self-budget.
 *
 * @param {{
 *   client: { searchPage: Function },
 *   session: { apiKey?: string },
 *   query?: { title?: string, author?: string, isbn13?: string },
 *   formats?: string[],
 *   limit?: number,
 *   signal?: AbortSignal,
 *   host: { fail: Function },
 *   now?: () => number,
 *   budgetMs?: number
 * }} options
 * @returns {Promise<object[]>}
 */
export async function searchFiles({
  client,
  session,
  query,
  formats,
  limit,
  signal,
  host,
  now = Date.now,
  budgetMs = SEARCH_BUDGET_MS
} = {}) {
  const queryText = buildQueryText(query)
  if (queryText === '') {
    throw host.fail('error', 'Chomikuj search needs a title, author, or ISBN')
  }

  const selectedFormats = Array.isArray(formats) ? formats : []
  const singleFormat = selectedFormats.length === 1
  const extension = singleFormat ? selectedFormats[0] : undefined
  const apiKey = session?.apiKey
  const target = normalizeLimit(limit) * 3
  const budget = Number.isFinite(budgetMs) && budgetMs >= 0 ? budgetMs : SEARCH_BUDGET_MS
  const deadline = now() + budget

  const rows = []
  const fileIds = new Set()
  let page = 1

  while (page <= MAX_PAGES) {
    if (signal?.aborted) break

    const remaining = deadline - now()
    if (remaining <= 0) break

    const options = {
      query: queryText,
      page,
      signal: combineWithTimeout(signal, remaining)
    }
    if (singleFormat) options.extension = extension

    let payload
    try {
      payload = await client.searchPage(apiKey, options)
    } catch (error) {
      if (page === 1) throw error
      break
    }

    const results = payload?.Results
    if (!Array.isArray(results)) {
      if (page === 1) {
        throw host.fail('error', 'Chomikuj search returned an invalid Results payload')
      }
      break
    }

    rows.push(...results)
    for (const file of results) {
      const fileId = file?.FileId
      if (fileId !== undefined && fileId !== null) fileIds.add(String(fileId))
    }

    if (fileIds.size >= target) break
    if (payload.IsNextPageAvailable !== true) break

    page += 1
  }

  return rows
}
