import assert from 'node:assert/strict'
import { type DialogLayout, type Line, layoutDialog, listHeight } from '../src/dialog-layout.ts'
import type { SummaryResult } from '../src/rpc.ts'

type Entry = SummaryResult['entries'][number]
type Wallet = NonNullable<SummaryResult['wallet']>

// Local-time timestamps keep the checks independent of the machine's time zone.
const at = (day: number, hour: number, minute: number, second = 0) =>
  new Date(2026, 10, day, hour, minute, second).getTime()

const now = at(25, 10, 53)

const entry = (overrides: Partial<Entry>): Entry => ({
  ts: at(24, 14, 36, 18),
  kind: 'primary',
  model: 'google/gemini-4-hydrogen',
  cost: 0.0131,
  byokCost: 0,
  promptTokens: 92953,
  completionTokens: 426,
  generationID: null,
  ...overrides,
})

const wallet: Wallet = {
  at: at(25, 10, 52, 30),
  keyLimitRemaining: 78.42,
  keyLimitReset: 'weekly',
  includeByokInLimit: false,
  creditsRemaining: 114.11,
  creditsTotal: 200,
}

// Oldest first, as the server stores them; the figures are the 25 Nov screenshot's.
const entries: Entry[] = [
  entry({
    ts: at(24, 14, 35, 6),
    cost: 0.0164,
    byokCost: null,
    promptTokens: 90369,
    completionTokens: 818,
  }),
  entry({}),
  entry({
    ts: at(25, 10, 52, 22),
    kind: 'compaction',
    model: 'anthropic/claude-haiku-5.5',
    cost: 0.089,
    promptTokens: 126505,
    completionTokens: 3982,
  }),
]

const summaryOf = (overrides: Partial<SummaryResult> = {}): SummaryResult => ({
  session: {
    sessionID: 'ses_dialog',
    startedAt: 0,
    totalUSD: 4.0761,
    byokUSD: 0,
    unknownBYOK: 132,
    requests: 3,
  },
  entries,
  wallet,
  ...overrides,
})

const text = (line: Line) => line.map((cell) => cell.text).join('')

const allLines = (layout: DialogLayout): Line[] => [
  ...layout.summary,
  layout.requestsHeading,
  ...(layout.tableHeader ? [layout.tableHeader] : []),
  ...layout.requests,
  ...layout.footer,
]

const narrow = layoutDialog(summaryOf(), { width: 54, now })
const wide = layoutDialog(summaryOf(), { width: 110, now })

// #narrow-one-line: nothing is wider than 54 columns and each request is one line.
for (const line of allLines(narrow)) {
  assert.ok(text(line).length <= 54, `wider than 54: "${text(line)}"`)
}

// The table leaves one column free for the list's scrollbar.
for (const line of [...(narrow.tableHeader ? [narrow.tableHeader] : []), ...narrow.requests]) {
  assert.ok(text(line).length <= 53, `table line wider than 53: "${text(line)}"`)
}

assert.deepEqual(narrow.requests.map(text), [
  '── Today ────────────────────────────────────────────',
  '10:52  claude-haiku-5.5          compaction  $0.0890',
  '── Yesterday ────────────────────────────────────────',
  '14:36  google/gemini-4-hydrogen              $0.0131',
  '14:35  google/gemini-4-hydrogen              $0.0164?',
])

assert.equal(
  narrow.tableHeader && text(narrow.tableHeader),
  'Time   Model                     Role            Cost',
)

// #wide-columns: OpenRouter, BYOK, In and Out, right-aligned.
assert.equal(
  wide.tableHeader && text(wide.tableHeader),
  'Time      Model                                               Role        OpenRouter     BYOK       In    Out',
)

assert.deepEqual(wide.requests.filter((line) => !text(line).startsWith('──')).map(text), [
  '10:52:22  anthropic/claude-haiku-5.5                          compaction     $0.0890  $0.0000  126,505  3,982',
  '14:36:18  google/gemini-4-hydrogen                                           $0.0131  $0.0000   92,953    426',
  '14:35:06  google/gemini-4-hydrogen                                           $0.0164  unknown   90,369    818',
])

// #figures-once: each figure once, as `Label  value`, in two sections.
const narrowSummary = narrow.summary.map(text)

assert.deepEqual(narrowSummary, [
  'Spend',
  'Session total       $4.0761 · 3 requests',
  '  OpenRouter        $4.0761',
  '  BYOK upstream     $0.0000 · 132 unknown',
  '',
  'Limits',
  'Key limit (weekly)  $78.42 left · BYOK counted: no',
  'Account credits     $114.11 left of $200.00',
])

for (const figure of ['$78.42', '$114.11']) {
  const all = allLines(narrow).map(text).join('\n')

  assert.equal(all.split(figure).length - 1, 1, `${figure} should appear once`)
}

assert.deepEqual(wide.summary.map(text), [
  'Spend                                    Limits',
  'Session total    $4.0761 · 3 requests    Key limit (weekly)  $78.42 left · BYOK counted: no',
  '  OpenRouter     $4.0761                 Account credits     $114.11 left of $200.00',
  '  BYOK upstream  $0.0000 · 132 unknown',
])

// #day-headings: rules only when the list reaches back before today.
const todayOnly = layoutDialog(summaryOf({ entries: entries.slice(2) }), { width: 54, now })

assert.deepEqual(todayOnly.requests.map(text), [
  '10:52  claude-haiku-5.5          compaction  $0.0890',
])

const older = layoutDialog(
  summaryOf({
    entries: [entry({ ts: new Date(2025, 11, 31, 9, 0).getTime() }), entry({ ts: at(23, 9, 0) })],
  }),
  { width: 54, now },
)

const olderRules = older.requests.map(text).filter((line) => line.startsWith('──'))

assert.deepEqual(
  olderRules.map((line) => line.replace(/ ─+$/, '')),
  ['── Mon, Nov 23', '── Wed, Dec 31, 2025'],
)
assert.ok(olderRules.every((line) => line.length === 53))

// #unknown-marked: unknown BYOK reads `?` or `unknown`, in the warning tone.
const compactUnknown = narrow.requests.at(-1)
const wideUnknown = wide.requests.at(-1)

assert.ok(compactUnknown?.some((cell) => cell.text.includes('$0.0164?') && cell.tone === 'warning'))
assert.ok(wideUnknown?.some((cell) => cell.text.trim() === 'unknown' && cell.tone === 'warning'))
assert.ok(narrow.footer.map(text).some((line) => line.includes('? = BYOK cost unknown')))
assert.ok(!wide.footer.map(text).some((line) => line.includes('? = BYOK cost unknown')))

assert.ok(
  narrow.summary.some((line) =>
    line.some((cell) => cell.text === '132 unknown' && cell.tone === 'warning'),
  ),
)

// Repeated values drop out: no Role column when all are primary, no BYOK column when all are zero.
const plain = layoutDialog(summaryOf({ entries: [entry({}), entry({ cost: 0.02 })] }), {
  width: 110,
  now,
})

assert.deepEqual(plain.tableHeader && text(plain.tableHeader).split(/\s+/), [
  'Time',
  'Model',
  'Cost',
  'In',
  'Out',
])

// A long model drops its provider, then gets cut.
const longModel = layoutDialog(
  summaryOf({
    entries: [
      entry({ ts: at(25, 9, 0), model: 'anthropic/claude-sonnet-5-5-thinking-extended-preview' }),
    ],
  }),
  { width: 54, now },
)

assert.deepEqual(longModel.requests.map(text), [
  '09:00  claude-sonnet-5-5-thinking-extended…  $0.0131',
])

// Limits: a $0 key balance still shows; the effective budget and key rows; a long note wraps.
const limits = layoutDialog(
  summaryOf({
    wallet: {
      ...wallet,
      keyLimitRemaining: 0,
      effectiveBudget: { scope: 'key', includeByok: true, remainingUSD: 0 },
      label: 'laptop',
      keyUsage: 12.5,
      reason:
        'No OpenRouter credential available. Connect OpenRouter (/connect) or set OPENROUTER_API_KEY.',
    },
  }),
  { width: 54, now },
)

assert.deepEqual(limits.summary.map(text).slice(5), [
  'Limits',
  'Key limit (weekly)      $0.00 left · BYOK counted: no',
  'Effective budget (key)  $0.00 left · BYOK counted: yes',
  'Account credits         $114.11 left of $200.00',
  'Key                     laptop · $12.50 used',
  'Note                    No OpenRouter credential',
  '                        available. Connect OpenRouter',
  '                        (/connect) or set',
  '                        OPENROUTER_API_KEY.',
])

// No wallet yet, no requests yet.
const empty = layoutDialog(summaryOf({ wallet: null, entries: [] }), { width: 54, now })

assert.deepEqual(empty.summary.map(text).slice(-2), [
  'Limits',
  'Wallet           no data yet · press r',
])
assert.equal(text(empty.requestsHeading), 'Requests')
assert.equal(empty.tableHeader, null)
assert.deepEqual(empty.requests.map(text), ['No OpenRouter requests captured in this session yet.'])
assert.ok(!empty.footer.map(text).join(' ').includes('Fetched'))

// The heading says when the server sent only the newest requests of the session.
const partial = layoutDialog(summaryOf({ session: { ...summaryOf().session, requests: 450 } }), {
  width: 54,
  now,
})

assert.equal(text(partial.requestsHeading), 'Requests · 3 of 450 shown · newest first')

// A very narrow dialog still keeps every line inside its width.
const tiny = layoutDialog(summaryOf(), { width: 30, now })

for (const line of allLines(tiny)) {
  assert.ok(text(line).length <= 30, `wider than 30: "${text(line)}"`)
}

// The list takes what the screen leaves, at least 3 lines, at most its own length.
assert.equal(listHeight(narrow, 200), narrow.requests.length)
assert.equal(listHeight(narrow, 10), 3)
assert.equal(listHeight(todayOnly, 10), 1)
assert.equal(listHeight(narrow, 8 + narrow.summary.length + narrow.footer.length + 4 + 4), 4)

console.log('dialog-layout checks passed')
