/**
 * Chomikuj mobile API request token.
 *
 * Chomikuj signs every mobile API request with a static app constant:
 *
 *   md5(PATH_WITHOUT_LEADING_SLASH + ('?' + query if query else '') + body + SECRET)
 *
 * The digest is lowercase hexadecimal MD5 over the UTF-8 bytes of that string.
 * The caller must sign the exact query string it puts on the wire (same order,
 * same encoding); this module never re-encodes or reorders the query.
 */

import { createHash } from 'node:crypto'

/** The 20-character secret shipped in Chomikuj's mobile app. */
export const CHOMIKUJ_SECRET = "wzrwYua$.DSe8suk!`'2"

const LEADING_SLASHES = /^\/+/

/**
 * @param {string} pathValue API path, with or without a leading slash
 * @param {string} [query] query string without the leading '?', exactly as sent
 * @param {string} [body] raw request body, exactly as sent
 * @returns {string} lowercase MD5 hex digest
 */
export function signToken(pathValue, query = '', body = '') {
  const normalizedPath = String(pathValue).replace(LEADING_SLASHES, '')
  const pathQuery = normalizedPath + (query ? `?${query}` : '')
  return createHash('md5').update(pathQuery + body + CHOMIKUJ_SECRET, 'utf8').digest('hex')
}
