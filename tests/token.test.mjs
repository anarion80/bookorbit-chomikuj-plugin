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
    path: 'api/v3/account/info',
    query: '',
    body: '',
    expected: '22dbb80e516477793934fa0add1b8929'
  },
  {
    name: 'files/search with the exact query string',
    path: 'api/v3/files/search',
    query: 'Query=test&PageNumber=1&MediaType=Documents&Extension=pdf',
    body: '',
    expected: '83b420ec92a611e58b884b89e68ac530'
  },
  {
    name: 'files/download with a FileId query',
    path: 'api/v3/files/download',
    query: 'FileId=123456',
    body: '',
    expected: 'bfdebdece4cef4a17ebe44808ab4cda4'
  },
  {
    name: 'account/login with a compact JSON body',
    path: 'api/v3/account/login',
    query: '',
    body: '{"AccountName":"alice","Password":"p@ss"}',
    expected: '9f78082445ecf973cb41180065a0fc50'
  },
  {
    name: 'account/login with a Unicode body',
    path: 'api/v3/account/login',
    query: '',
    body: '{"AccountName":"żółć","Password":"päss"}',
    expected: '801e16c63c58dede556adfa87c78476e'
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
    signToken('/api/v3/account/info'),
    VECTORS[0].expected,
    'signToken strips one leading slash'
  )
  h.expectEqual(
    signToken('//api/v3/account/info'),
    VECTORS[0].expected,
    'signToken strips repeated leading slashes'
  )

  // Default arguments and an explicit empty query are equivalent: no '?' is
  // added when the query is empty.
  h.expectEqual(
    signToken('api/v3/account/info'),
    signToken('api/v3/account/info', '', ''),
    'signToken omits the "?" when the query is empty'
  )
  h.expectEqual(
    signToken('api/v3/account/info', '', ''),
    VECTORS[0].expected,
    'signToken with explicit empty query matches the no-query vector'
  )

  // A trailing slash is part of the path and must change the digest.
  const trailingSlash = signToken('api/v3/account/info/')
  h.expectEqual(
    trailingSlash,
    'fd75d7d488c54390b51a5bc0a54700a0',
    'signToken signs a trailing slash as part of the path'
  )
  h.ok(
    'signToken distinguishes a trailing slash from no slash',
    trailingSlash !== VECTORS[0].expected
  )

  // A wrong secret must not reproduce any known-answer vector.
  const wrongSecretHash = signWithSecret(WRONG_SECRET, 'api/v3/account/info')
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
