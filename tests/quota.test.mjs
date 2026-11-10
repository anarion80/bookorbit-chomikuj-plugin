/**
 * Tests for the pure transfer-quota preflight.
 *
 * These cases are the executable specification for the matrix in plan Todo 14:
 * unlimited, owner-free, paid with spending disabled, sufficient/insufficient
 * balance, the exact boundary, and unknown inputs that fall back to the
 * authoritative 605 check.
 */

import { decideDownload } from '../src/lib/quota.mjs'

export const testName = 'quota decision'

const KB = 1024

export default async function run(h) {
  const freeAccount = h.loadFixture('account-free.json')
  const unlimitedAccount = h.loadFixture('account-unlimited.json')
  const transferKb = freeAccount.Transfer

  /**
   * Assert the verdict shape plus optional reason substrings.
   *
   * @param {string} label
   * @param {{ allowed: boolean, failure: string|null, reason: string }} result
   * @param {boolean} expectedAllowed
   * @param {string[]} [needles]
   */
  function verdict(label, result, expectedAllowed, needles = []) {
    h.expectEqual(
      { allowed: result.allowed, failure: result.failure },
      { allowed: expectedAllowed, failure: expectedAllowed ? null : 'error' },
      `${label}: allowed/failure`
    )
    h.expectEqual(
      Object.keys(result).sort(),
      ['allowed', 'failure', 'reason'],
      `${label}: result has exactly allowed/failure/reason`
    )
    h.ok(
      `${label}: reason is a non-empty string`,
      typeof result.reason === 'string' && result.reason.length > 0,
      result.reason
    )
    for (const needle of needles) {
      h.ok(
        `${label}: reason includes ${JSON.stringify(needle)}`,
        typeof result.reason === 'string' && result.reason.includes(needle),
        result.reason
      )
    }
  }

  // Unlimited transfer always wins, including when paid spending is disabled.
  verdict(
    'unlimited account allows a paid file even with allowTransferSpend=false',
    decideDownload({
      file: { sizeBytes: 500 * 1024 * KB },
      account: unlimitedAccount,
      allowTransferSpend: false
    }),
    true,
    ['unlimited']
  )

  // Owner-marked-free files are allowed before the spending switch is checked.
  verdict(
    'candidate freeleech=true allows with allowTransferSpend=false',
    decideDownload({
      file: { sizeBytes: 500 * 1024 * KB, freeleech: true },
      account: freeAccount,
      allowTransferSpend: false
    }),
    true,
    ['free']
  )
  verdict(
    'raw IsFileFreeForUser=true allows with allowTransferSpend=false',
    decideDownload({
      file: { sizeBytes: 500 * 1024 * KB, IsFileFreeForUser: true },
      account: freeAccount,
      allowTransferSpend: false
    }),
    true,
    ['free']
  )

  // Paid file with spending disabled is denied before any API call.
  verdict(
    'paid file with allowTransferSpend=false is denied',
    decideDownload({
      file: { sizeBytes: 10 * KB },
      account: freeAccount,
      allowTransferSpend: false
    }),
    false,
    ['allowTransferSpend', 'disabled', '7,0 GB']
  )
  h.ok(
    'paid+disabled denial is not reported as an insufficient-balance denial',
    !decideDownload({
      file: { sizeBytes: transferKb * KB + KB },
      account: freeAccount,
      allowTransferSpend: false
    }).reason.includes('not enough transfer'),
    'The spending switch must be checked before the balance rule.'
  )

  // Explicit and implicit permission to spend with a sufficient balance.
  verdict(
    'paid file with allowTransferSpend=true and sufficient Transfer allows',
    decideDownload({
      file: { sizeBytes: 100 * KB },
      account: freeAccount,
      allowTransferSpend: true
    }),
    true,
    ['enough transfer']
  )
  verdict(
    'paid file with allowTransferSpend undefined defaults to spending allowed',
    decideDownload({ file: { sizeBytes: 100 * KB }, account: freeAccount }),
    true,
    ['enough transfer']
  )

  // Insufficient balance is denied and carries the server balance text.
  verdict(
    'paid file with insufficient Transfer denies and includes the balance text',
    decideDownload({
      file: { sizeBytes: (transferKb + 1) * KB },
      account: freeAccount,
      allowTransferSpend: true
    }),
    false,
    ['not enough transfer', '7,0 GB', '120 pkt']
  )

  // Exact boundary: fileKb === Transfer is still affordable.
  verdict(
    'paid file exactly at the Transfer boundary allows',
    decideDownload({
      file: { sizeBytes: transferKb * KB },
      account: freeAccount,
      allowTransferSpend: true
    }),
    true,
    ['enough transfer']
  )

  // Unknown balance allows but must advertise that 605 is authoritative.
  verdict(
    'missing Transfer allows with an unknown-balance caveat',
    decideDownload({
      file: { sizeBytes: 100 * KB },
      account: { HasUnlimitedTransfer: false },
      allowTransferSpend: true
    }),
    true,
    ['unknown balance', '605']
  )
  verdict(
    'null Transfer allows with an unknown-balance caveat',
    decideDownload({
      file: { sizeBytes: 100 * KB },
      account: { HasUnlimitedTransfer: false, Transfer: null },
      allowTransferSpend: true
    }),
    true,
    ['unknown balance', '605']
  )
  verdict(
    'missing account allows with an unknown-balance caveat',
    decideDownload({ file: { sizeBytes: 100 * KB } }),
    true,
    ['unknown balance', '605']
  )

  // Unknown file size allows even when the account balance is known and tiny.
  verdict(
    'missing sizeBytes allows with a 605 caveat',
    decideDownload({ file: {}, account: { HasUnlimitedTransfer: false, Transfer: 1 } }),
    true,
    ['unknown file size', '605']
  )
  verdict(
    'null sizeBytes allows with a 605 caveat',
    decideDownload({
      file: { sizeBytes: null },
      account: { HasUnlimitedTransfer: false, Transfer: 1 }
    }),
    true,
    ['unknown file size', '605']
  )

  // Numeric strings from the JSON API are coerced before comparing.
  verdict(
    'string Transfer is coerced when the file fits',
    decideDownload({
      file: { sizeBytes: 1024 * KB },
      account: { HasUnlimitedTransfer: false, Transfer: '1024' },
      allowTransferSpend: true
    }),
    true,
    ['enough transfer']
  )
  verdict(
    'string Transfer is coerced when the file does not fit',
    decideDownload({
      file: { sizeBytes: 1025 * KB },
      account: { HasUnlimitedTransfer: false, Transfer: '1024' },
      allowTransferSpend: true
    }),
    false,
    ['not enough transfer']
  )
  verdict(
    'non-numeric Transfer is treated as unknown',
    decideDownload({
      file: { sizeBytes: 1024 * KB },
      account: { HasUnlimitedTransfer: false, Transfer: 'unlimited?' },
      allowTransferSpend: true
    }),
    true,
    ['unknown balance', '605']
  )

  // A file explicitly marked paid is still denied by the spending switch.
  verdict(
    'freeleech=false and IsFileFreeForUser=false does not bypass the switch',
    decideDownload({
      file: { sizeBytes: 10 * KB, freeleech: false, IsFileFreeForUser: false },
      account: freeAccount,
      allowTransferSpend: false
    }),
    false,
    ['allowTransferSpend']
  )
}
