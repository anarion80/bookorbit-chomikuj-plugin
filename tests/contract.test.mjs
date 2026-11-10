/**
 * Contract tests for the BookOrbit plugin boundary.
 *
 * Only `host.fetch` is mocked. The real session cache, client, search, mapping,
 * filtering, ordering, and download-resolution modules all run behind the
 * plugin's `search`, `test`, `resolveFile`, and `forget` exports, so these tests
 * pin the behaviour BookOrbit actually receives.
 *
 * Every block uses a unique `config.id` and forgets it in `finally`, because the
 * session cache is module-global for the lifetime of the test process.
 */

import plugin from '../src/index.mjs'

// Optional; `verify.mjs --only` matches this as well as the filename.
export const testName = 'contract'

const BASE_URL = 'https://chomikuj.contract.test'
const USERNAME = 'synthetic-contract-user'
const PASSWORD = 'synthetic-contract-password-9x!'
const FORMATS = 'epub,pdf'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function htmlResponse(body, status = 403) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })
}

/**
 * Route each request by URL path to a Response or a handler. Calls are recorded
 * with their parsed page/FileId so tests can assert the real wire traffic.
 */
function createFakeFetch(routes = {}) {
  const calls = []

  async function fetchImpl(url, init = {}) {
    const href = String(url)
    const method = String(init?.method ?? 'GET').toUpperCase()

    let kind = null
    if (href.includes('/account/login')) kind = 'login'
    else if (href.includes('/account/info')) kind = 'account'
    else if (href.includes('/files/search')) kind = 'search'
    else if (href.includes('/files/download')) kind = 'download'
    if (kind === null) throw new Error(`unexpected fetch: ${method} ${href}`)

    const parsed = new URL(href)
    const call = {
      kind,
      method,
      url: href,
      init,
      page: kind === 'search' ? Number(parsed.searchParams.get('PageNumber') ?? '1') : null,
      query: kind === 'search' ? parsed.searchParams.get('Query') : null,
      extension: kind === 'search' ? parsed.searchParams.get('Extension') : null,
      fileId: kind === 'download' ? parsed.searchParams.get('FileId') : null
    }
    calls.push(call)

    const route = routes[kind]
    if (route === undefined) throw new Error(`no fake route for ${kind}`)
    return typeof route === 'function' ? route(call) : route
  }

  function count(kind) {
    return calls.filter((call) => call.kind === kind).length
  }

  return { fetchImpl, calls, count }
}

function createConfig(id, settings = {}) {
  return {
    id,
    baseUrl: BASE_URL,
    credential: PASSWORD,
    settings: { username: USERNAME, ...settings }
  }
}

function errorText(values) {
  return values
    .filter((value) => value !== undefined && value !== null)
    .map((value) => (value instanceof Error ? value.message : String(value)))
    .join('\n')
}

function assertNoSecrets(h, label, host, apiKey, errors = []) {
  const logs = host.logs.map((entry) => entry.message).join('\n')
  const errorsText = errorText(errors)

  h.ok(`${label}: password never reaches host.logs`, !logs.includes(PASSWORD), logs)
  h.ok(`${label}: ApiKey never reaches host.logs`, !logs.includes(apiKey), logs)
  h.ok(`${label}: password never appears in errors`, !errorsText.includes(PASSWORD), errorsText)
  h.ok(`${label}: ApiKey never appears in errors`, !errorsText.includes(apiKey), errorsText)
}

async function capture(promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

function guids(candidates) {
  return candidates.map((candidate) => candidate.guid)
}

export default async function run(h) {
  const login = h.loadFixture('login-ok.json')
  const accountFree = h.loadFixture('account-free.json')
  const accountUnlimited = h.loadFixture('account-unlimited.json')
  const page1 = h.loadFixture('search-page1.json')
  const page2 = h.loadFixture('search-page2.json')
  const downloadOk = h.loadFixture('download-ok.json')
  const download605 = h.loadFixture('download-605.json')
  const apiKey = login.ApiKey

  // --- search: login, two pages, filter, map, order, truncate -------------
  {
    const id = 'contract-search-happy'
    const config = createConfig(id, { formats: FORMATS })
    const fake = createFakeFetch({
      login: () => jsonResponse(login),
      account: () => jsonResponse(accountFree),
      search: (call) => jsonResponse(call.page === 1 ? page1 : page2),
      download: () => jsonResponse(downloadOk)
    })
    const host = h.createMockHost({ fetchImpl: fake.fetchImpl })
    const errors = []

    try {
      const candidates = await plugin.search(
        { title: 'Test', author: 'Author', limit: 2 },
        config,
        host
      )

      h.expectEqual(
        guids(candidates),
        ['200000004', '200000002'],
        'search happy: newest-first, format-filtered, truncated to the limit'
      )
      h.expectEqual(
        candidates.map((candidate) => candidate.format),
        ['epub', 'pdf'],
        'search happy: only selected formats survive'
      )
      h.ok(
        'search happy: the unselected mobi row is dropped',
        !guids(candidates).includes('200000003')
      )
      h.expectEqual(
        candidates[0],
        {
          guid: '200000004',
          title: 'Ostatnia Strona',
          bookTitle: 'Ostatnia Strona',
          author: 'Synthetic Author',
          format: 'epub',
          language: null,
          sizeBytes: 512 * 1024,
          seeders: null,
          leechers: null,
          primaryFileCount: 1,
          fileCount: 1,
          freeleech: false
        },
        'search happy: the fixture row maps to the exact candidate'
      )
      h.expectEqual(fake.count('login'), 1, 'search happy: exactly one login')
      h.expectEqual(fake.count('search'), 2, 'search happy: reads both result pages')
      h.expectEqual(fake.count('account'), 0, 'search happy: no account call')
      h.expectEqual(fake.count('download'), 0, 'search happy: no download call')
      h.expectEqual(
        fake.calls.filter((call) => call.kind === 'search').map((call) => call.page),
        [1, 2],
        'search happy: page numbers are 1 then 2'
      )
      h.expectEqual(
        fake.calls.find((call) => call.kind === 'search')?.query,
        'Test Author',
        'search happy: joins title and author into Query'
      )
      h.ok(
        'search happy: two formats omit the Extension hint',
        fake.calls
          .filter((call) => call.kind === 'search')
          .every((call) => call.extension === null)
      )
      h.expectEqual(host.savedCredentials.length, 0, 'search happy: no credential write')
    } catch (error) {
      errors.push(error)
      h.ok('search happy: does not throw', false, error)
    } finally {
      plugin.forget(id)
    }

    assertNoSecrets(h, 'search happy', host, apiKey, errors)
  }

  // --- search: 401 clears the session, so the next call logs in again ------
  {
    const id = 'contract-search-401'
    const config = createConfig(id, { formats: 'epub' })
    const searchResponses = [
      jsonResponse({ Message: 'Unauthorized', Code: 0 }, 401),
      jsonResponse({
        Code: 0,
        Results: [page1.Results[0]],
        IsNextPageAvailable: false
      })
    ]
    const fake = createFakeFetch({
      login: () => jsonResponse(login),
      account: () => jsonResponse(accountFree),
      search: () => searchResponses.shift(),
      download: () => jsonResponse(downloadOk)
    })
    const host = h.createMockHost({ fetchImpl: fake.fetchImpl })
    const errors = []

    try {
      const firstError = await capture(plugin.search({ title: 'Test' }, config, host))
      errors.push(firstError)

      h.ok('search 401: throws', firstError instanceof Error)
      h.expectEqual(
        firstError?.failure,
        'unauthorized',
        'search 401: maps to unauthorized'
      )
      h.ok(
        'search 401: message is non-empty',
        typeof firstError?.message === 'string' && firstError.message !== ''
      )
      h.expectEqual(fake.count('login'), 1, 'search 401: first call logged in once')

      const candidates = await plugin.search({ title: 'Test' }, config, host)

      h.expectEqual(candidates.length, 1, 'search 401: retry returns one candidate')
      h.expectEqual(candidates[0]?.guid, '200000001', 'search 401: retry maps the fresh page')
      h.expectEqual(
        fake.count('login'),
        2,
        'search 401: clearing the session forces a second login'
      )
      h.expectEqual(fake.count('search'), 2, 'search 401: exactly two search requests')
      h.expectEqual(host.savedCredentials.length, 0, 'search 401: no credential write')
    } catch (error) {
      errors.push(error)
      h.ok('search 401: second search succeeds', false, error)
    } finally {
      plugin.forget(id)
    }

    assertNoSecrets(h, 'search 401', host, apiKey, errors)
  }

  // --- search: Cloudflare HTML is unreachable and is not retried -----------
  {
    const id = 'contract-search-cloudflare'
    const config = createConfig(id, { formats: 'epub' })
    const fake = createFakeFetch({
      login: () => jsonResponse(login),
      account: () => jsonResponse(accountFree),
      search: () => htmlResponse(h.readFixtureText('cf-challenge.html'), 403),
      download: () => jsonResponse(downloadOk)
    })
    const host = h.createMockHost({ fetchImpl: fake.fetchImpl })
    const errors = []

    try {
      const error = await capture(plugin.search({ title: 'Test' }, config, host))
      errors.push(error)

      h.expectEqual(error?.failure, 'unreachable', 'search cloudflare: maps to unreachable')
      h.ok(
        'search cloudflare: message names the challenge',
        /cloudflare/i.test(error?.message ?? '')
      )
      h.expectEqual(fake.count('search'), 1, 'search cloudflare: no retry storm')
    } catch (error) {
      errors.push(error)
      h.ok('search cloudflare: returns a classified failure', false, error)
    } finally {
      plugin.forget(id)
    }

    assertNoSecrets(h, 'search cloudflare', host, apiKey, errors)
  }

  // --- test: free and unlimited tier summaries ----------------------------
  {
    const cases = [
      ['free', accountFree, 'Chomikuj.pl (free, 7,0 GB)'],
      ['unlimited', accountUnlimited, 'Chomikuj.pl (unlimited transfer)']
    ]

    for (const [label, account, expectedName] of cases) {
      const id = `contract-test-${label}`
      const config = createConfig(id)
      const fake = createFakeFetch({
        login: () => jsonResponse(login),
        account: () => jsonResponse(account),
        search: () => jsonResponse(page1),
        download: () => jsonResponse(downloadOk)
      })
      const host = h.createMockHost({ fetchImpl: fake.fetchImpl })
      const errors = []

      try {
        const result = await plugin.test(config, host)

        h.expectEqual(
          result,
          { success: true, indexerName: expectedName },
          `test ${label}: reports the tier summary`
        )
        h.expectEqual(fake.count('login'), 1, `test ${label}: exactly one login`)
        h.expectEqual(fake.count('account'), 1, `test ${label}: reads the account once`)
        h.expectEqual(
          fake.calls.find((call) => call.kind === 'account')?.init?.headers?.['Api-Key'],
          apiKey,
          `test ${label}: sends the session ApiKey to account/info`
        )
        h.expectEqual(host.savedCredentials.length, 0, `test ${label}: no credential write`)
      } catch (error) {
        errors.push(error)
        h.ok(`test ${label}: resolves`, false, error)
      } finally {
        plugin.forget(id)
      }

      assertNoSecrets(h, `test ${label}`, host, apiKey, errors)
    }
  }

  // --- test: login 401 returns success false instead of throwing ----------
  {
    const id = 'contract-test-401'
    const config = createConfig(id)
    const fake = createFakeFetch({
      login: () => jsonResponse({ Message: 'Unauthorized', Code: 0 }, 401),
      account: () => jsonResponse(accountFree),
      search: () => jsonResponse(page1),
      download: () => jsonResponse(downloadOk)
    })
    const host = h.createMockHost({ fetchImpl: fake.fetchImpl })
    const errors = []

    try {
      const result = await plugin.test(config, host)
      errors.push(result?.error)

      h.ok('test 401: success is false', result?.success === false)
      h.ok(
        'test 401: error is a non-empty string',
        typeof result?.error === 'string' && result.error !== ''
      )
      h.ok(
        'test 401: error names the auth failure',
        /unauthorized/i.test(result?.error ?? '')
      )
      h.expectEqual(fake.count('login'), 1, 'test 401: one login attempt')
      h.expectEqual(fake.count('account'), 0, 'test 401: no account call')
      h.expectEqual(host.savedCredentials.length, 0, 'test 401: no credential write')
    } catch (error) {
      errors.push(error)
      h.ok('test 401: returns a result instead of throwing', false, error)
    } finally {
      plugin.forget(id)
    }

    assertNoSecrets(h, 'test 401', host, apiKey, errors)
  }

  // --- resolveFile: success returns a complete descriptor -----------------
  {
    const id = 'contract-resolve-happy'
    const config = createConfig(id, { formats: FORMATS })
    const fake = createFakeFetch({
      login: () => jsonResponse(login),
      account: () => jsonResponse(accountFree),
      search: () => jsonResponse(page1),
      download: () => jsonResponse(downloadOk)
    })
    const host = h.createMockHost({ fetchImpl: fake.fetchImpl })
    const release = {
      guid: '200000001',
      title: 'Testowa Książka',
      bookTitle: 'Testowa Książka',
      format: 'epub',
      sizeBytes: 1024 * 1024,
      freeleech: true
    }
    const errors = []

    try {
      const descriptor = await plugin.resolveFile(release, config, host)

      h.expectEqual(
        descriptor,
        {
          url: downloadOk.FileUrl,
          fileName: downloadOk.Name,
          format: 'epub',
          sizeBytes: release.sizeBytes
        },
        'resolve happy: returns the exact BookOrbit descriptor'
      )
      h.ok(
        'resolve happy: url is non-empty',
        typeof descriptor?.url === 'string' && descriptor.url !== ''
      )
      h.ok(
        'resolve happy: fileName is non-empty',
        typeof descriptor?.fileName === 'string' && descriptor.fileName !== ''
      )
      h.ok(
        'resolve happy: format is non-empty',
        typeof descriptor?.format === 'string' && descriptor.format !== ''
      )
      h.expectEqual(fake.count('login'), 1, 'resolve happy: exactly one login')
      h.expectEqual(fake.count('account'), 1, 'resolve happy: reads the account once')
      h.expectEqual(fake.count('download'), 1, 'resolve happy: exactly one download call')
      h.expectEqual(
        fake.calls.find((call) => call.kind === 'download')?.fileId,
        release.guid,
        'resolve happy: sends release.guid as FileId'
      )
      h.expectEqual(host.savedCredentials.length, 0, 'resolve happy: no credential write')
    } catch (error) {
      errors.push(error)
      h.ok('resolve happy: resolves', false, error)
    } finally {
      plugin.forget(id)
    }

    assertNoSecrets(h, 'resolve happy', host, apiKey, errors)
  }

  // --- resolveFile: spending disabled blocks a paid file before download --
  {
    const id = 'contract-resolve-no-spend'
    const config = createConfig(id, { allowTransferSpend: false, formats: FORMATS })
    const fake = createFakeFetch({
      login: () => jsonResponse(login),
      account: () => jsonResponse(accountFree),
      search: () => jsonResponse(page1),
      download: () => jsonResponse(downloadOk)
    })
    const host = h.createMockHost({ fetchImpl: fake.fetchImpl })
    const release = {
      guid: '200000002',
      title: 'Paid Book',
      bookTitle: 'Paid Book',
      format: 'pdf',
      sizeBytes: 10 * 1024 * 1024,
      freeleech: false
    }
    const errors = []

    try {
      const error = await capture(plugin.resolveFile(release, config, host))
      errors.push(error)

      h.ok('resolve no-spend: throws', error instanceof Error)
      h.expectEqual(error?.failure, 'error', 'resolve no-spend: maps to error')
      h.ok(
        'resolve no-spend: message names allowTransferSpend',
        /allowTransferSpend/.test(error?.message ?? '')
      )
      h.expectEqual(fake.count('download'), 0, 'resolve no-spend: zero download calls')
      h.expectEqual(fake.count('login'), 1, 'resolve no-spend: one login')
      h.expectEqual(fake.count('account'), 1, 'resolve no-spend: account read for the preflight')
    } catch (error) {
      errors.push(error)
      h.ok('resolve no-spend: returns a classified failure', false, error)
    } finally {
      plugin.forget(id)
    }

    assertNoSecrets(h, 'resolve no-spend', host, apiKey, errors)
  }

  // --- resolveFile: 605 is a non-retryable error after one download call --
  {
    const id = 'contract-resolve-605'
    const config = createConfig(id, { allowTransferSpend: true, formats: FORMATS })
    const fake = createFakeFetch({
      login: () => jsonResponse(login),
      account: () => jsonResponse(accountFree),
      search: () => jsonResponse(page1),
      download: () => jsonResponse(download605)
    })
    const host = h.createMockHost({ fetchImpl: fake.fetchImpl })
    const release = {
      guid: '200000002',
      title: 'Paid Book',
      bookTitle: 'Paid Book',
      format: 'pdf',
      sizeBytes: 1024 * 1024,
      freeleech: false
    }
    const errors = []

    try {
      const error = await capture(plugin.resolveFile(release, config, host))
      errors.push(error)

      h.ok('resolve 605: throws', error instanceof Error)
      h.expectEqual(error?.failure, 'error', 'resolve 605: maps to error')
      h.ok(
        'resolve 605: message says not enough transfer',
        /not enough transfer/i.test(error?.message ?? '')
      )
      h.ok('resolve 605: is not retryable', error?.retryable !== true)
      h.expectEqual(fake.count('download'), 1, 'resolve 605: exactly one download request')
      h.expectEqual(
        fake.calls.find((call) => call.kind === 'download')?.fileId,
        release.guid,
        'resolve 605: the one request targets the release'
      )
      h.expectEqual(host.savedCredentials.length, 0, 'resolve 605: no credential write')
    } catch (error) {
      errors.push(error)
      h.ok('resolve 605: returns a classified failure', false, error)
    } finally {
      plugin.forget(id)
    }

    assertNoSecrets(h, 'resolve 605', host, apiKey, errors)
  }

  // --- forget: the next search logs in again ------------------------------
  {
    const id = 'contract-forget'
    const config = createConfig(id, { formats: 'epub' })
    const lonePage = {
      Code: 0,
      Results: [page1.Results[0]],
      IsNextPageAvailable: false
    }
    const fake = createFakeFetch({
      login: () => jsonResponse(login),
      account: () => jsonResponse(accountFree),
      search: () => jsonResponse(lonePage),
      download: () => jsonResponse(downloadOk)
    })
    const host = h.createMockHost({ fetchImpl: fake.fetchImpl })
    const errors = []

    try {
      const first = await plugin.search({ title: 'Test' }, config, host)
      h.expectEqual(first.length, 1, 'forget: the first search returns a candidate')
      h.expectEqual(fake.count('login'), 1, 'forget: the first search logs in once')

      plugin.forget(id)

      const second = await plugin.search({ title: 'Test' }, config, host)
      h.expectEqual(second.length, 1, 'forget: the second search still returns a candidate')
      h.expectEqual(
        fake.count('login'),
        2,
        'forget: the next search logs in again after eviction'
      )
      h.expectEqual(fake.count('search'), 2, 'forget: one search request per call')
    } catch (error) {
      errors.push(error)
      h.ok('forget: both searches resolve', false, error)
    } finally {
      plugin.forget(id)
    }

    assertNoSecrets(h, 'forget', host, apiKey, errors)
  }
}
