/**
 * Known-answer tests for the Chomikuj mobile API request token.
 *
 * The formula and vectors were verified against the mobile app in
 * `scripts/live-spike.mjs`. Hardcoding the digests keeps any regression in the
 * secret, separator, path normalization, or UTF-8 handling visible.
 */

import { createHash } from 'node:crypto'
import { CHOMIKUJ_SECRET, signToken } from '../src/lib/token.mjs'

// Optional; `verify.mjs --only` matches this as well as the filename.
export const testName = 'token'

const MD5_HEX = /^[0-9a-f]{32}$/

const VECTORS = [
  {
    name: 'account/info with no query and no body',
    path: 'account/info',
    query: '',
    body: '',
    expected: '7f9de9e90cb427d8aaad405c71c1d0f4'
  },
  {
    name: 'files/search with the exact query string',
    path: 'files/search',
    query: 'Query=test&PageNumber=1&MediaType=Documents&Extension=pdf',
    body: '',
    expected: '7d6a667a66f8a2666afe58dc8db6fcc4'
  },
  {
    name: 'files/download with a FileId query',
    path: 'files/download',
    query: 'FileId=123456',
    body: '',
    expected: '84c3a2089bd10124f7e31dd01d4b1593'
  },
  {
    name: 'account/login with a compact JSON body',
    path: 'account/login',
    query: '',
    body: '{"AccountName":"alice","Password":"p@ss"}',
    expected: '318c4f502d0c00a3d92bfe29d98a17f0'
  },
  {
    name: 'account/login with a Unicode body',
    path: 'account/login',
    query: '',
    body: '{"AccountName":"żółć","Password":"päss"}',
    expected: 'a033dc4fe119a8bbdb0f8358aa96e568'
  }
]

// Same formula with a deliberately wrong final secret character, used only to
// prove the known answers actually depend on the secret.
const WRONG_SECRET = "wzrwYua$.DSe8suk!`'3"

function signWithSecret(secret, pathValue, query = '', body = '') {
  const normalizedPath = String(pathValue).replace(/^\/+/, '')
  const pathQuery = normalizedPath + (query ? `?${query}` : '')
  return createHash('md5').update(pathQuery + body + secret, 'utf8').digest('hex')
}

export default async function run(h) {
  h.expectEqual(
    CHOMIKUJ_SECRET,
    "wzrwYua$.DSe8suk!`'2",
    'CHOMIKUJ_SECRET is the exact mobile-app constant'
  )
  h.expectEqual(CHOMIKUJ_SECRET.length, 20, 'CHOMIKUJ_SECRET is exactly 20 characters')

  for (const vector of VECTORS) {
    const actual = signToken(vector.path, vector.query, vector.body)
    h.expectEqual(actual, vector.expected, `signToken: ${vector.name}`)
    h.ok(
      `signToken output is lowercase MD5 hex: ${vector.name}`,
      MD5_HEX.test(actual),
      actual
    )
  }

  // Leading slashes are stripped, not signed.
  h.expectEqual(
    signToken('/account/info'),
    VECTORS[0].expected,
    'signToken strips one leading slash'
  )
  h.expectEqual(
    signToken('//account/info'),
    VECTORS[0].expected,
    'signToken strips repeated leading slashes'
  )

  // Default arguments and an explicit empty query are equivalent: no '?' is
  // added when the query is empty.
  h.expectEqual(
    signToken('account/info'),
    signToken('account/info', '', ''),
    'signToken omits the "?" when the query is empty'
  )
  h.expectEqual(
    signToken('account/info', '', ''),
    VECTORS[0].expected,
    'signToken with explicit empty query matches the no-query vector'
  )

  // A trailing slash is part of the path and must change the digest.
  const trailingSlash = signToken('account/info/')
  h.expectEqual(
    trailingSlash,
    '04cd8c6cf8d09a054941249903ab29eb',
    'signToken signs a trailing slash as part of the path'
  )
  h.ok(
    'signToken distinguishes a trailing slash from no slash',
    trailingSlash !== VECTORS[0].expected
  )

  // A wrong secret must not reproduce any known-answer vector.
  const wrongSecretHash = signWithSecret(WRONG_SECRET, 'account/info')
  h.ok(
    'a deliberately wrong secret produces a different hash',
    wrongSecretHash !== VECTORS[0].expected,
    { wrongSecretHash, expected: VECTORS[0].expected }
  )
  h.ok(
    'a deliberately wrong secret differs from every known-answer vector',
    VECTORS.every((vector) => signWithSecret(WRONG_SECRET, vector.path, vector.query, vector.body) !== vector.expected)
  )
}
