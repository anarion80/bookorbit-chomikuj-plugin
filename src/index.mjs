/**
 * BookOrbit plugin manifest for Chomikuj.pl.
 *
 * Declarative contract fields only. The `search`, `test`, and `resolveFile`
 * placeholders are replaced with the real implementation in Todo 17.
 */

function notWired() {
  throw new Error('not wired yet')
}

export default {
  apiVersion: 1,
  version: '0.1.0',
  type: 'chomikuj',
  label: 'Chomikuj.pl',
  requiresCredential: true,
  credentialKind: 'apiKey',
  mediaKinds: ['ebook'],
  supportsIsbnSearch: true,
  usesCategories: false,
  seedsBack: false,
  defaultBaseUrl: 'https://mobile.chomikuj.pl',
  baseUrlHint: 'Chomikuj mobile API base; normally unchanged.',
  settingsFields: [
    {
      key: 'username',
      type: 'string',
      label: 'Chomikuj username',
      hint: 'Your Chomikuj.pl account name. Put the account password in BookOrbit\'s credential field, which the UI labels "API key".'
    },
    {
      key: 'allowTransferSpend',
      type: 'boolean',
      label: 'Allow spending transfer',
      default: true,
      hint: 'Warning: previewing a paid file can spend transfer. When this is off, only files the owner marks as free are offered.'
    },
    {
      key: 'formats',
      type: 'string',
      label: 'Ebook formats',
      format: 'list',
      default: 'epub,mobi,pdf',
      options: ['epub', 'kepub', 'mobi', 'azw3', 'azw', 'fb2', 'pdf', 'djvu'],
      minItems: 1,
      hint: 'One format narrows the search on the server; several formats are filtered locally. Archive formats are never offered.'
    }
  ],
  search: notWired,
  test: notWired,
  resolveFile: notWired
}
