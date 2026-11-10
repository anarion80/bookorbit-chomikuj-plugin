/**
 * Self-test for the offline harness, and the contract every later test file follows:
 *
 *   export default async function run(h) { ... }
 *
 * `verify.mjs` discovers `tests/*.test.mjs` dynamically, imports the module, and awaits
 * its default export with the shared harness. No registration and no import of
 * `verify.mjs` is needed, so new test files are picked up automatically.
 *
 * Harness surface:
 *   h.ok(name, condition, extra?)      record PASS/FAIL, never throws on `false`
 *   h.expectEqual(actual, expected, label?)  deep equality with a readable diff
 *   h.loadFixture(name)                read fixtures/<name> JSON and return `.body`
 *   h.readFixtureText(name)            read a raw fixture such as cf-challenge.html
 *   h.createMockHost({ fetchImpl, logger })  BookOrbit PluginHost-shaped mock
 *   h.finish()                         print PASS/FAIL counts and return 0 or 1
 */

import { createHarness } from './harness.mjs'

// Optional; `verify.mjs --only` matches this as well as the filename.
export const testName = 'harness self-test'

export default async function run(h) {
  // ok() records both outcomes without throwing on a false condition.
  const nested = createHarness({ silent: true })
  h.expectEqual(
    nested.ok('nested pass', true),
    true,
    'ok returns true for a passing condition'
  )
  h.expectEqual(
    nested.ok('nested fail', false, 'captured failure'),
    false,
    'ok returns false for a failing condition without throwing'
  )
  h.expectEqual(nested.results.length, 2, 'ok records both assertions')
  h.expectEqual(
    nested.results.filter((result) => !result.pass).length,
    1,
    'ok records the failing assertion as FAIL'
  )

  // expectEqual compares deeply, reports a readable diff, and feeds finish().
  h.expectEqual(
    { title: 'Synthetic Title', size: 1024 },
    { title: 'Synthetic Title', size: 1024 },
    'expectEqual passes on deep equality'
  )
  const nestedEqual = createHarness({ silent: true })
  nestedEqual.expectEqual({ size: 1024 }, { size: 2048 }, 'nested size mismatch')
  const diffResult = nestedEqual.results[0]
  h.ok(
    'expectEqual records a failure for a mismatch',
    diffResult !== undefined && diffResult.pass === false
  )
  h.ok(
    'expectEqual failure keeps a readable diff',
    typeof diffResult?.extra === 'string' &&
      diffResult.extra.includes('1024') &&
      diffResult.extra.includes('2048')
  )
  h.expectEqual(nestedEqual.failed, 1, 'expectEqual increments the failed count')
  h.expectEqual(nestedEqual.finish(), 1, 'finish returns 1 when a nested assertion failed')
  h.expectEqual(createHarness({ silent: true }).finish(), 0, 'finish returns 0 with no failures')

  // loadFixture returns the envelope body and fails loudly when the file is missing.
  const login = h.loadFixture('login-ok.json')
  h.ok(
    'loadFixture returns the fixture body',
    login !== null && typeof login === 'object' && typeof login.ApiKey === 'string'
  )
  h.expectEqual(
    login.AccountName,
    'synthetic-test-account',
    'loadFixture preserves Chomikuj field names'
  )
  const searchPage = h.loadFixture('search-page1.json')
  h.ok(
    'search fixture exposes Results',
    searchPage.Code === 0 && Array.isArray(searchPage.Results) && searchPage.Results.length > 0
  )
  h.ok(
    'search Size values stay in kilobytes',
    searchPage.Results.every((file) => Number.isInteger(file.Size))
  )

  let missingError
  try {
    h.loadFixture('definitely-missing.json')
  } catch (error) {
    missingError = error
  }
  h.ok(
    'loadFixture throws for a missing fixture',
    missingError instanceof Error && /not found/i.test(missingError.message),
    missingError?.message
  )

  // readFixtureText leaves non-JSON fixtures untouched.
  const challenge = h.readFixtureText('cf-challenge.html')
  h.ok(
    'readFixtureText returns the raw HTML',
    typeof challenge === 'string' && challenge.includes('Just a moment')
  )
  h.ok('challenge fixture has a Cloudflare widget marker', challenge.includes('cf-chl-'))
  h.ok(
    'challenge fixture has the challenge platform path',
    challenge.includes('/cdn-cgi/challenge-platform/')
  )

  // createMockHost mirrors BookOrbit's PluginHost shape and records usage.
  const calls = []
  const forwarded = []
  const host = h.createMockHost({
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200 }
    },
    logger: {
      log: (message) => forwarded.push(['log', message]),
      warn: (message) => forwarded.push(['warn', message])
    }
  })

  const response = await host.fetch('https://mobile.chomikuj.pl/account/info', {
    headers: { 'Api-Key': 'synthetic-key' }
  })
  h.ok('createMockHost fetch delegates to fetchImpl', response.ok === true && calls.length === 1)
  h.expectEqual(
    host.fetchCalls[0].url,
    'https://mobile.chomikuj.pl/account/info',
    'fetchCalls records the URL'
  )

  host.logger.log('login ok')
  host.logger.warn('rate limit near')
  h.expectEqual(
    host.logs.map((entry) => entry.level),
    ['log', 'warn'],
    'logger records both levels'
  )
  h.expectEqual(forwarded.length, 2, 'logger forwards to a supplied logger')

  await host.saveCredential('rotated-synthetic-credential')
  h.expectEqual(
    host.savedCredentials,
    ['rotated-synthetic-credential'],
    'saveCredential records calls'
  )
  h.expectEqual(
    host.buildSearchText({ title: 'Synthetic Title (Illustrated)', author: 'Synthetic Author' }),
    'Synthetic Title Synthetic Author',
    'buildSearchText strips parentheticals and appends the author'
  )

  let missingFetchImplError
  try {
    await h.createMockHost().fetch('https://example.invalid/')
  } catch (error) {
    missingFetchImplError = error
  }
  h.ok(
    'createMockHost without fetchImpl throws a clear error',
    missingFetchImplError instanceof Error && /fetchImpl/i.test(missingFetchImplError.message)
  )

  // fail() returns a plain Error carrying BookOrbit's failure code.
  const failure = host.fail('unauthorized', 'Synthetic credential was rejected')
  h.ok('fail returns an Error', failure instanceof Error)
  h.expectEqual(failure.failure, 'unauthorized', 'fail exposes .failure')
  h.expectEqual(
    failure.message,
    'Synthetic credential was rejected',
    'fail exposes .message'
  )
  h.ok(
    'fail message remains actionable',
    /rejected/.test(failure.message) && failure.failure === 'unauthorized'
  )
}
