/**
 * Tests for download resolution.
 *
 * The success and preflight cases use a scripted fake client so every call is
 * observable; the business-code cases use the real client over a fake `fetch`
 * so the assertions prove that 605 stays a non-retryable `error` (with the
 * "not enough transfer" message), 602 stays `unauthorized`, and the remaining
 * codes never become success. No test touches the network or a real host.
 */

import { createClient } from '../src/lib/client.mjs'
import { resolveDownload } from '../src/lib/resolve.mjs'

// Optional; `verify.mjs --only` matches this as well as the filename.
export const testName = 'resolve'

const API_KEY = 'synthetic-api-key-resolve-0000-0000-000000000000'

const session = { apiKey: API_KEY }
const account = { Transfer: 1024 * 1024 }
const config = { settings: { allowTransferSpend: true } }
const release = {
  guid: 'file-guid-0001',
  format: 'epub',
  title: 'Testowa Książka',
  bookTitle: 'Testowa Książka',
  sizeBytes: 4096
}

function createFakeClient(steps) {
  const queue = [...steps]
  const calls = []

  async function downloadUrl(apiKey, fileId, options = {}) {
    calls.push({ apiKey, fileId, ...options })
    if (queue.length === 0) {
      throw new Error(`unexpected downloadUrl call #${calls.length}`)
    }
    const step = queue.shift()
    if (step instanceof Error) throw step
    return step
  }

  return { downloadUrl, calls }
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}

/** A real client whose fake fetch always returns the same JSON payload. */
function createLiveClient(payload) {
  const calls = []

  async function fetchImpl(url, init) {
    calls.push({ url: String(url), init })
    return jsonResponse(payload)
  }

  return { client: createClient({ fetchImpl }), calls }
}

async function capture(promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

function expectHostFailure(h, label, error, failure, needles = []) {
  h.ok(`${label}: throws`, error instanceof Error, error)
  h.expectEqual(error?.failure, failure, `${label}: failure is ${failure}`)

  for (const needle of needles) {
    h.ok(
      `${label}: message includes ${JSON.stringify(needle)}`,
      typeof error?.message === 'string' && error.message.includes(needle),
      error?.message
    )
  }
}

export default async function run(h) {
  // --- quota preflight denial: zero chargeable requests -------------------
  {
    const host = h.createMockHost()
    const client = createFakeClient([])
    const paidRelease = { ...release, sizeBytes: 10 * 1024 * 1024 }
    const error = await capture(
      resolveDownload({
        client,
        session,
        release: paidRelease,
        config: { settings: { allowTransferSpend: false } },
        account: { Transfer: 100 },
        host
      })
    )

    expectHostFailure(h, 'preflight denial', error, 'error', ['allowTransferSpend'])
    h.expectEqual(client.calls.length, 0, 'preflight denial: zero downloadUrl calls')
    h.expectEqual(host.savedCredentials.length, 0, 'preflight denial: no credential write')
  }

  // --- success: one call and a complete descriptor ------------------------
  {
    const host = h.createMockHost()
    const payload = h.loadFixture('download-ok.json')
    const client = createFakeClient([payload])
    const controller = new AbortController()

    const descriptor = await resolveDownload({
      client,
      session,
      release,
      config,
      account,
      host,
      signal: controller.signal
    })

    h.expectEqual(client.calls.length, 1, 'success: exactly one downloadUrl call')
    h.expectEqual(client.calls[0].apiKey, API_KEY, 'success: sends the session ApiKey')
    h.expectEqual(client.calls[0].fileId, release.guid, 'success: sends release.guid as FileId')
    h.expectEqual(client.calls[0].signal, controller.signal, 'success: forwards the abort signal')

    h.expectEqual(
      Object.keys(descriptor).sort(),
      ['fileName', 'format', 'sizeBytes', 'url'],
      'success: descriptor has exactly url/fileName/format/sizeBytes'
    )
    h.expectEqual(descriptor.url, payload.FileUrl, 'success: url is the response FileUrl')
    h.expectEqual(descriptor.fileName, payload.Name, 'success: reuses the response Name')
    h.expectEqual(descriptor.format, 'epub', 'success: format comes from the release first')
    h.expectEqual(descriptor.sizeBytes, release.sizeBytes, 'success: sizeBytes is preserved')
    h.ok('success: url is non-empty', typeof descriptor.url === 'string' && descriptor.url !== '')
    h.ok(
      'success: fileName is non-empty',
      typeof descriptor.fileName === 'string' && descriptor.fileName !== ''
    )
    h.ok('success: format is non-empty', typeof descriptor.format === 'string' && descriptor.format !== '')
    h.expectEqual(host.savedCredentials.length, 0, 'success: no credential write')
  }

  // --- 605: permanent quota error, never retried --------------------------
  {
    const host = h.createMockHost()
    const { client, calls } = createLiveClient(h.loadFixture('download-605.json'))
    const error = await capture(
      resolveDownload({ client, session, release, config, account, host })
    )

    expectHostFailure(h, '605', error, 'error', ['not enough transfer'])
    h.ok('605: is not retryable', error?.retryable !== true)
    h.expectEqual(calls.length, 1, '605: exactly one download request, no retry')
    h.expectEqual(host.savedCredentials.length, 0, '605: no credential write')
  }

  // --- 602 and the remaining business codes -------------------------------
  {
    const cases = [
      [602, 'unauthorized', ['access denied']],
      [601, 'error', []],
      [604, 'error', []],
      [606, 'error', []],
      [610, 'error', []]
    ]

    for (const [code, failure, needles] of cases) {
      const host = h.createMockHost()
      const { client, calls } = createLiveClient({ Code: code, Message: `Synthetic code ${code}` })
      const error = await capture(
        resolveDownload({ client, session, release, config, account, host })
      )

      expectHostFailure(h, `code ${code}`, error, failure, needles)
      h.expectEqual(calls.length, 1, `code ${code}: exactly one download request`)
    }
  }

  // --- missing FileUrl ----------------------------------------------------
  {
    const host = h.createMockHost()
    const client = createFakeClient([{ Code: 0, Name: 'Book.epub' }])
    const error = await capture(
      resolveDownload({ client, session, release, config, account, host })
    )

    expectHostFailure(h, 'missing FileUrl', error, 'error', ['FileUrl'])
    h.expectEqual(client.calls.length, 1, 'missing FileUrl: one downloadUrl call')
  }

  // --- a fallback title with separators and control characters ------------
  {
    const host = h.createMockHost()
    const client = createFakeClient([
      { Code: 0, FileUrl: 'https://example.invalid/download/ok', Name: '' }
    ])
    const descriptor = await resolveDownload({
      client,
      session,
      release: {
        ...release,
        bookTitle: 'Bad/Title\\Name\u0000',
        title: 'Bad/Title\\Name'
      },
      config,
      account,
      host
    })

    h.expectEqual(
      descriptor.fileName,
      'Bad_Title_Name.epub',
      'sanitize: separators and control characters are replaced or removed'
    )
    h.ok(
      'sanitize: no path separators remain',
      !descriptor.fileName.includes('/') && !descriptor.fileName.includes('\\'),
      descriptor.fileName
    )
  }

  // --- a response Name that already carries the extension -----------------
  {
    const host = h.createMockHost()
    const client = createFakeClient([
      { Code: 0, FileUrl: 'https://example.invalid/download/ok', Name: 'Already Named.epub' }
    ])
    const descriptor = await resolveDownload({
      client,
      session,
      release: { ...release, format: undefined },
      config,
      account,
      host
    })

    h.expectEqual(descriptor.format, 'epub', 'name extension: format falls back to Name')
    h.expectEqual(descriptor.fileName, 'Already Named.epub', 'name extension: reused as-is')
    h.ok(
      'name extension: no double extension',
      !descriptor.fileName.toLowerCase().endsWith('.epub.epub'),
      descriptor.fileName
    )
  }

  // --- a release title that carries the only extension --------------------
  {
    const host = h.createMockHost()
    const client = createFakeClient([
      { Code: 0, FileUrl: 'https://example.invalid/download/ok', Name: 'No Extension' }
    ])
    const descriptor = await resolveDownload({
      client,
      session,
      release: { ...release, format: undefined, title: 'Only Title.mobi', bookTitle: 'Only Title' },
      config,
      account,
      host
    })

    h.expectEqual(descriptor.format, 'mobi', 'title extension: format comes from the title')
    h.expectEqual(descriptor.fileName, 'No Extension.mobi', 'title extension: Name gets the format')
  }

  // --- no format anywhere is an error, not a guessed extension ------------
  {
    const host = h.createMockHost()
    const client = createFakeClient([
      { Code: 0, FileUrl: 'https://example.invalid/download/ok', Name: 'No Extension' }
    ])
    const error = await capture(
      resolveDownload({
        client,
        session,
        release: { ...release, format: undefined, title: 'No Extension', bookTitle: 'No Extension' },
        config,
        account,
        host
      })
    )

    expectHostFailure(h, 'no format', error, 'error', ['cannot determine the file format'])
    h.expectEqual(client.calls.length, 1, 'no format: one downloadUrl call')
  }

  // --- fallback file name when nothing usable is supplied -----------------
  {
    const host = h.createMockHost()
    const client = createFakeClient([
      { Code: 0, FileUrl: 'https://example.invalid/download/ok', Name: '   ' }
    ])
    const descriptor = await resolveDownload({
      client,
      session,
      release: { ...release, format: 'pdf', title: '', bookTitle: '' },
      config,
      account,
      host
    })

    h.expectEqual(descriptor.fileName, 'chomikuj-download.pdf', 'fallback: default stem with format')
  }
}
