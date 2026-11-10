/**
 * Tests for newest-first candidate ordering.
 *
 * `orderByNewest` is pure: it must return a new array, preserve the input order
 * for equal keys, compare numeric guids without Number precision loss, honour a
 * real date field when present, and never fabricate or rewrite dates.
 */

import { orderByNewest } from '../src/lib/order.mjs'

// Optional; `verify.mjs --only` matches this as well as the filename.
export const testName = 'order'

const DATE_FIELDS = ['AddedDate', 'Date', 'CreatedAt', 'publishedAt']

function guids(candidates) {
  return candidates.map((candidate) => candidate.guid)
}

function ids(candidates) {
  return candidates.map((candidate) => candidate.id)
}

export default async function run(h) {
  // --- numeric guid order ----------------------------------------------------
  h.expectEqual(
    guids(orderByNewest([{ guid: '2' }, { guid: '10' }])),
    ['10', '2'],
    'guid 10 sorts before guid 2'
  )
  h.expectEqual(
    guids(orderByNewest([{ guid: '2' }, { guid: '10' }, { guid: '1' }])),
    ['10', '2', '1'],
    'multiple numeric guids sort descending'
  )

  // --- BigInt precision above 2^53 ------------------------------------------
  const huge = orderByNewest([
    { guid: '9007199254740992' },
    { guid: '9007199254740994' },
    { guid: '9007199254740993' }
  ])
  h.expectEqual(
    guids(huge),
    ['9007199254740994', '9007199254740993', '9007199254740992'],
    'guids above 2^53 sort exactly without Number precision loss'
  )
  h.ok(
    'the >2^53 case really is beyond safe integer precision',
    Number('9007199254740992') === Number('9007199254740993')
  )

  // --- equal keys are stable -------------------------------------------------
  const stable = orderByNewest([
    { guid: '7', id: 'first' },
    { guid: '7', id: 'second' },
    { guid: '8', id: 'third' }
  ])
  h.expectEqual(ids(stable), ['third', 'first', 'second'], 'equal guids keep the input order')

  // --- missing and invalid guids fall back safely ---------------------------
  const fallbackInput = [
    { id: 'two', guid: '2' },
    { id: 'missing', guid: undefined },
    { id: 'letters', guid: 'abc' },
    { id: 'ten', guid: '10' },
    { id: 'empty', guid: '' },
    { id: 'mixed', guid: '12x' },
    { id: 'no-guid' }
  ]
  const fallback = orderByNewest(fallbackInput)
  h.expectEqual(
    ids(fallback),
    ['letters', 'mixed', 'ten', 'two', 'missing', 'empty', 'no-guid'],
    'invalid guids fall back to digit-length then lexicographic order'
  )
  h.expectEqual(
    ids(orderByNewest(fallbackInput)),
    ids(fallback),
    'the fallback ordering is deterministic across calls'
  )
  h.ok('fallback keeps every candidate', fallback.length === fallbackInput.length)

  // --- every real date field sorts descending -------------------------------
  for (const field of DATE_FIELDS) {
    const dated = [
      { guid: '99', [field]: '2024-01-01T00:00:00.000Z' },
      { guid: '10', [field]: '2025-06-01T12:00:00.000Z' },
      { guid: '50', [field]: '2023-03-01T00:00:00.000Z' }
    ]
    h.expectEqual(
      guids(orderByNewest(dated)),
      ['10', '99', '50'],
      `${field} sorts descending and outranks the guid order`
    )
  }

  // --- equal dates stay stable; invalid dates fall back ---------------------
  h.expectEqual(
    ids(
      orderByNewest([
        { guid: '1', id: 'first', Date: '2025-01-01T00:00:00.000Z' },
        { guid: '999', id: 'second', Date: '2025-01-01T00:00:00.000Z' }
      ])
    ),
    ['first', 'second'],
    'equal dates keep the input order'
  )
  h.expectEqual(
    guids(
      orderByNewest([
        { guid: '2', AddedDate: 'not-a-date' },
        { guid: '10', AddedDate: null }
      ])
    ),
    ['10', '2'],
    'unparseable dates fall back to guid order'
  )

  // --- mixed dated and undated candidates -----------------------------------
  const mixed = orderByNewest([
    { id: 'undated-big-guid', guid: '1000' },
    { id: 'older', guid: '1', Date: '2024-01-01T00:00:00.000Z' },
    { id: 'undated-second', guid: '500' },
    { id: 'newer', guid: '2', publishedAt: '2025-01-01T00:00:00.000Z' }
  ])
  h.expectEqual(
    ids(mixed),
    ['newer', 'older', 'undated-big-guid', 'undated-second'],
    'dated candidates come first by date, then undated candidates by guid'
  )

  // --- no date is added or rewritten ----------------------------------------
  const undated = [{ guid: '2', title: 'two' }, { guid: '10', title: 'ten' }]
  const datedSnapshot = [
    { guid: '1', title: 'old', AddedDate: '2024-01-01T00:00:00.000Z' },
    { guid: '2', title: 'new', Date: '2025-01-01T00:00:00.000Z' }
  ]
  const undatedJson = JSON.stringify(undated)
  const datedJson = JSON.stringify(datedSnapshot)
  const orderedUndated = orderByNewest(undated)
  const orderedDated = orderByNewest(datedSnapshot)

  h.expectEqual(JSON.stringify(undated), undatedJson, 'ordering leaves undated objects untouched')
  h.expectEqual(
    JSON.stringify(datedSnapshot),
    datedJson,
    'ordering neither adds nor rewrites date fields'
  )
  h.ok(
    'no undated candidate gains a date field',
    orderedUndated.every((candidate) =>
      DATE_FIELDS.every((field) => !Object.hasOwn(candidate, field))
    )
  )
  h.ok(
    'publishedAt is never fabricated',
    orderedUndated.every((candidate) => !Object.hasOwn(candidate, 'publishedAt')) &&
      orderedDated.every((candidate) => !Object.hasOwn(candidate, 'publishedAt'))
  )

  // --- input array and objects are not mutated ------------------------------
  const input = [
    { guid: '2', title: 'two' },
    { guid: '10', title: 'ten' }
  ]
  const inputOrder = input.map((candidate) => candidate.title)
  const inputRefs = [...input]
  const output = orderByNewest(input)

  h.ok('returns a new array', output !== input)
  h.expectEqual(
    input.map((candidate) => candidate.title),
    inputOrder,
    'input array order is not mutated'
  )
  h.ok(
    'output reuses the same candidate objects without dropping any',
    output.length === inputRefs.length && output.every((candidate) => inputRefs.includes(candidate))
  )

  // --- trivial inputs --------------------------------------------------------
  h.expectEqual(orderByNewest([]), [], 'empty input returns an empty array')
  h.expectEqual(orderByNewest(), [], 'a missing input returns an empty array')
}
