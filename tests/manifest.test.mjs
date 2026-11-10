/**
 * Tests for the declarative plugin manifest and its settings schema.
 *
 * These lock the contract BookOrbit reads before it calls any plugin function:
 * the plugin identity, credential shape, base URL, media kinds, and the three
 * settings fields. Placeholder behaviour is deliberately not asserted here;
 * Todo 17 replaces it.
 */

import manifest from '../src/index.mjs'

export const testName = 'plugin manifest'

const EXPECTED_FORMATS = ['epub', 'kepub', 'mobi', 'azw3', 'azw', 'fb2', 'pdf', 'djvu']
const ARCHIVE_OPTIONS = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'cbz', 'cbr', 'cb7', 'cbt']
const NON_IMPORTABLE_OPTIONS = ['txt', 'doc', 'docx']
const TYPE_SLUG = /^[a-z0-9][a-z0-9-]{0,29}$/

function shapeViolations(plugin) {
  const violations = []

  if (plugin.apiVersion !== 1) violations.push('apiVersion')
  if (typeof plugin.type !== 'string' || !TYPE_SLUG.test(plugin.type)) violations.push('type')
  if (typeof plugin.label !== 'string' || plugin.label.trim() === '') violations.push('label')
  if (typeof plugin.requiresCredential !== 'boolean') violations.push('requiresCredential')
  if (typeof plugin.usesCategories !== 'boolean') violations.push('usesCategories')
  if (typeof plugin.seedsBack !== 'boolean') violations.push('seedsBack')
  if (!Array.isArray(plugin.mediaKinds) || plugin.mediaKinds.length === 0) violations.push('mediaKinds')
  if (!Array.isArray(plugin.settingsFields)) violations.push('settingsFields')
  if (typeof plugin.search !== 'function') violations.push('search')
  if (typeof plugin.test !== 'function') violations.push('test')

  const hasResolveFile = typeof plugin.resolveFile === 'function'
  const hasFetchTorrentFile = typeof plugin.fetchTorrentFile === 'function'
  if (hasResolveFile === hasFetchTorrentFile) violations.push('download hook')

  return violations
}

export default async function run(h) {
  h.expectEqual(manifest.apiVersion, 1, 'apiVersion is 1')
  h.expectEqual(manifest.version, '0.1.0', 'version is 0.1.0 without a leading v')
  h.expectEqual(manifest.type, 'chomikuj', 'type is chomikuj')
  h.expectEqual(manifest.label, 'Chomikuj.pl', 'label is Chomikuj.pl')
  h.ok('requiresCredential is true', manifest.requiresCredential === true)
  h.expectEqual(manifest.credentialKind, 'apiKey', 'credentialKind is apiKey')
  h.expectEqual(manifest.mediaKinds, ['ebook'], 'mediaKinds is [ebook]')
  h.ok('supportsIsbnSearch is true', manifest.supportsIsbnSearch === true)
  h.ok('usesCategories is false', manifest.usesCategories === false)
  h.ok('seedsBack is false', manifest.seedsBack === false)
  h.expectEqual(
    manifest.defaultBaseUrl,
    'https://mobile.chomikuj.pl',
    'defaultBaseUrl is the Chomikuj mobile API'
  )
  h.expectEqual(
    manifest.baseUrlHint,
    'Chomikuj mobile API base; normally unchanged.',
    'baseUrlHint explains the base URL'
  )

  const fields = manifest.settingsFields
  h.ok('settingsFields is an array', Array.isArray(fields))
  h.expectEqual(
    fields.map((field) => field.key),
    ['username', 'allowTransferSpend', 'formats'],
    'settingsFields declares exactly username, allowTransferSpend, and formats'
  )

  const username = fields.find((field) => field.key === 'username')
  h.ok('username field exists', username !== undefined)
  h.expectEqual(username?.type, 'string', 'username is a string field')
  h.expectEqual(username?.label, 'Chomikuj username', 'username label is exact')
  h.ok(
    'username hint explains where the password goes',
    /password/i.test(username?.hint ?? '')
  )
  h.ok(
    'username hint names the credential field and its "API key" UI label',
    /credential/i.test(username?.hint ?? '') && /API key/i.test(username?.hint ?? '')
  )

  const allowTransferSpend = fields.find((field) => field.key === 'allowTransferSpend')
  h.ok('allowTransferSpend field exists', allowTransferSpend !== undefined)
  h.expectEqual(allowTransferSpend?.type, 'boolean', 'allowTransferSpend is a boolean field')
  h.expectEqual(allowTransferSpend?.default, true, 'allowTransferSpend defaults to true')
  h.expectEqual(
    allowTransferSpend?.label,
    'Allow spending transfer',
    'allowTransferSpend label is exact'
  )
  h.ok(
    'allowTransferSpend hint warns that previewing can spend transfer',
    /preview/i.test(allowTransferSpend?.hint ?? '') &&
      /spend/i.test(allowTransferSpend?.hint ?? '')
  )
  h.ok(
    'allowTransferSpend hint says only owner-marked-free files are offered when off',
    /owner/i.test(allowTransferSpend?.hint ?? '') && /free/i.test(allowTransferSpend?.hint ?? '')
  )

  const formats = fields.find((field) => field.key === 'formats')
  h.ok('formats field exists', formats !== undefined)
  h.expectEqual(formats?.type, 'string', 'formats is a string field')
  h.expectEqual(formats?.format, 'list', 'formats uses list format')
  h.ok('formats.default is a string, not an array', typeof formats?.default === 'string')
  h.expectEqual(formats?.default, 'epub,mobi,pdf', 'formats.default is epub,mobi,pdf')
  h.expectEqual(formats?.options, EXPECTED_FORMATS, 'formats.options is the importable list')
  h.expectEqual(formats?.minItems, 1, 'formats.minItems is 1')
  h.expectEqual(formats?.label, 'Ebook formats', 'formats label is exact')
  h.ok('formats hint says one format narrows server-side', /server/i.test(formats?.hint ?? ''))
  h.ok('formats hint says several formats filter locally', /local/i.test(formats?.hint ?? ''))
  h.ok('formats hint says archives are never offered', /archive/i.test(formats?.hint ?? ''))

  for (const archive of ARCHIVE_OPTIONS) {
    h.ok(
      `formats.options excludes archive "${archive}"`,
      !formats?.options.includes(archive)
    )
  }
  for (const unsupported of NON_IMPORTABLE_OPTIONS) {
    h.ok(
      `formats.options excludes non-importable "${unsupported}"`,
      !formats?.options.includes(unsupported)
    )
  }

  h.ok('search is a function', typeof manifest.search === 'function')
  h.ok('test is a function', typeof manifest.test === 'function')
  h.ok('resolveFile is a function', typeof manifest.resolveFile === 'function')
  h.ok('fetchTorrentFile is absent', !('fetchTorrentFile' in manifest))
  h.ok('update block is absent in v0.1.0', !('update' in manifest))

  h.ok('type matches the lowercase slug pattern', TYPE_SLUG.test(manifest.type))
  h.ok(
    'type is not a reserved tracker type',
    !['torznab', 'newznab'].includes(manifest.type)
  )

  h.expectEqual(shapeViolations(manifest), [], 'manifest passes the shape check')

  const withoutMediaKinds = { ...manifest }
  delete withoutMediaKinds.mediaKinds
  h.ok(
    'shape check rejects a variant missing mediaKinds',
    shapeViolations(withoutMediaKinds).includes('mediaKinds')
  )
  h.ok(
    'shape check rejects a variant with empty mediaKinds',
    shapeViolations({ ...manifest, mediaKinds: [] }).includes('mediaKinds')
  )
}
