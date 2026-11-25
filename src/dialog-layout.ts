import { balance, clock, count, money } from './format.ts'
import type { SummaryResult, WalletSnapshot } from './rpc.ts'

// Pure layout of the /openrouter-budget dialog: every line comes out padded and
// cut to the content width, so the TUI only draws cells and never wraps them.

export type Tone = 'title' | 'heading' | 'base' | 'muted' | 'faint' | 'warning'

export interface Cell {
  readonly text: string
  readonly tone: Tone
}

export type Line = readonly Cell[]

export interface DialogLayout {
  readonly summary: readonly Line[]
  readonly requestsHeading: Line
  readonly tableHeader: Line | null
  readonly requests: readonly Line[]
  readonly footer: readonly Line[]
}

type Entry = SummaryResult['entries'][number]

interface Row {
  readonly label: string
  // Joined with ` · `; a row that does not fit wraps between parts.
  readonly parts: readonly Cell[]
  // Free text that is expected to wrap, so it never decides the arrangement.
  readonly prose?: boolean
}

interface Column {
  readonly title: string
  readonly align: 'left' | 'right'
  readonly width: number
  readonly cell: (entry: Entry) => Cell
}

// The full table needs room for the model next to six fixed columns.
const FULL_TABLE_WIDTH = 90
const MIN_MODEL_WIDTH = 10
const COLUMN_GAP = '  '
const SECTION_GAP = '   '
const LABEL_GAP = 2
// The list scrolls, and its scrollbar takes one column when it shows.
const SCROLLBAR_GUTTER = 1
const SEPARATOR = ' · '

// Lines the dialog draws around the summary, the list and the footer: the
// host's top padding, the header and its blank line, the blank line after the
// summary, the requests heading, the table header, the blank line before the
// footer and the bottom padding.
const CHROME_LINES = 8
const SCREEN_MARGIN = 4
const MIN_LIST_LINES = 3

const KEY_HINTS = '↑↓ PgUp PgDn scroll · r refresh · esc close'
const BYOK_NOTE = 'BYOK costs are reported by OpenRouter, not an invoice'
const UNKNOWN_NOTE = '? = BYOK cost unknown'
const ACTIVITY_URL = 'https://openrouter.ai/activity'

const cell = (text: string, tone: Tone = 'base'): Cell => ({ text, tone })

const widthOf = (line: Line) => line.reduce((sum, part) => sum + part.text.length, 0)

function cut(text: string, width: number): string {
  if (width <= 0) {
    return ''
  }

  return text.length <= width ? text : `${text.slice(0, width - 1)}…`
}

const align = (text: string, width: number, side: 'left' | 'right') =>
  side === 'left' ? cut(text, width).padEnd(width) : cut(text, width).padStart(width)

// Merges a cell into the line's last one when they share a tone.
function append(line: Cell[], next: Cell): Cell[] {
  const last = line.at(-1)

  if (!next.text) {
    return line
  }

  if (last?.tone === next.tone) {
    return [...line.slice(0, -1), cell(last.text + next.text, next.tone)]
  }

  return [...line, next]
}

// Cuts a line to the width, drops trailing blanks and merges neighbours of one
// tone, so most lines render as a single text node.
function fit(cells: readonly Cell[], width: number): Line {
  const { line } = cells.reduce(
    (acc, part) => {
      const text = cut(part.text, acc.room)

      return { room: acc.room - text.length, line: append(acc.line, cell(text, part.tone)) }
    },
    { room: width, line: new Array<Cell>() },
  )

  return trimEnd(line)
}

function trimEnd(cells: Cell[]): Line {
  const last = cells.at(-1)

  if (!last) {
    return cells
  }

  const text = last.text.trimEnd()

  return text ? [...cells.slice(0, -1), cell(text, last.tone)] : trimEnd(cells.slice(0, -1))
}

// A word wider than the line keeps a line of its own; fit() cuts it later.
function wrapWords(text: string, width: number): string[] {
  return text.split(' ').reduce<string[]>((lines, word) => {
    const last = lines.at(-1)
    const joined = `${last} ${word}`

    if (last !== undefined && joined.length <= width) {
      return lines.slice(0, -1).concat([joined])
    }

    return lines.concat([word])
  }, [])
}

// Greedy wrap that keeps each part whole unless the part alone is too wide.
function wrapParts(parts: readonly Cell[], width: number): Cell[][] {
  const pieces = parts.flatMap((part) =>
    wrapWords(part.text, width).map((text) => cell(text, part.tone)),
  )

  return pieces.reduce<Cell[][]>((lines, piece) => {
    const last = lines.at(-1)
    const joined = [...(last ?? []), cell(SEPARATOR, 'muted'), piece]

    if (last && widthOf(joined) <= width) {
      return lines.slice(0, -1).concat([joined])
    }

    return lines.concat([[piece]])
  }, [])
}

function yesNo(value: boolean | undefined): string {
  if (value === undefined) {
    return 'unknown'
  }

  return value ? 'yes' : 'no'
}

const plural = (value: number, noun: string) => `${count(value)} ${noun}${value === 1 ? '' : 's'}`

export function keyRemaining(wallet: WalletSnapshot): number | null {
  if (typeof wallet.keyLimitRemaining === 'number') {
    return wallet.keyLimitRemaining
  }

  if (typeof wallet.keyLimit === 'number' && typeof wallet.keyUsage === 'number') {
    return Math.max(0, wallet.keyLimit - wallet.keyUsage)
  }

  return null
}

function spendRows(session: SummaryResult['session']): Row[] {
  const unknown =
    session.unknownBYOK > 0 ? [cell(`${count(session.unknownBYOK)} unknown`, 'warning')] : []

  return [
    {
      label: 'Session total',
      parts: [
        cell(money(session.totalUSD + session.byokUSD)),
        cell(plural(session.requests, 'request')),
      ],
    },
    { label: '  OpenRouter', parts: [cell(money(session.totalUSD))] },
    { label: '  BYOK upstream', parts: [cell(money(session.byokUSD)), ...unknown] },
  ]
}

const withSuffix = (label: string, suffix: string | null | undefined) =>
  suffix ? `${label} (${suffix})` : label

function keyLimitRow(wallet: WalletSnapshot): Row[] {
  const remaining = keyRemaining(wallet)

  if (remaining === null) {
    return []
  }

  return [
    {
      label: withSuffix('Key limit', wallet.keyLimitReset),
      parts: [
        cell(`${balance(remaining)} left`),
        cell(`BYOK counted: ${yesNo(wallet.includeByokInLimit)}`),
      ],
    },
  ]
}

function effectiveBudgetRow(wallet: WalletSnapshot): Row[] {
  const budget = wallet.effectiveBudget

  if (!budget) {
    return []
  }

  const left =
    typeof budget.remainingUSD === 'number' ? [cell(`${balance(budget.remainingUSD)} left`)] : []

  return [
    {
      label: withSuffix('Effective budget', budget.scope),
      parts: [...left, cell(`BYOK counted: ${yesNo(budget.includeByok)}`)],
    },
  ]
}

function creditsRow(wallet: WalletSnapshot): Row[] {
  if (typeof wallet.creditsRemaining === 'number') {
    const total =
      typeof wallet.creditsTotal === 'number' ? ` of ${balance(wallet.creditsTotal)}` : ''

    return [
      {
        label: 'Account credits',
        parts: [cell(`${balance(wallet.creditsRemaining)} left${total}`)],
      },
    ]
  }

  if (wallet.creditsUnavailable) {
    return [
      {
        label: 'Account credits',
        parts: [cell('not readable with this key (needs a management key)', 'muted')],
      },
    ]
  }

  return []
}

function keyRow(wallet: WalletSnapshot): Row[] {
  const parts = [
    ...(wallet.label ? [cell(wallet.label)] : []),
    ...(typeof wallet.keyUsage === 'number' ? [cell(`${balance(wallet.keyUsage)} used`)] : []),
  ]

  return parts.length ? [{ label: 'Key', parts }] : []
}

function limitRows(wallet: WalletSnapshot | null): Row[] {
  if (!wallet) {
    return [{ label: 'Wallet', parts: [cell('no data yet · press r', 'muted')] }]
  }

  const rows = [
    ...keyLimitRow(wallet),
    ...effectiveBudgetRow(wallet),
    ...creditsRow(wallet),
    ...keyRow(wallet),
    ...(wallet.reason
      ? [{ label: 'Note', parts: [cell(wallet.reason, 'warning')], prose: true }]
      : []),
  ]

  return rows.length ? rows : [{ label: 'Wallet', parts: [cell('no limits reported', 'muted')] }]
}

const labelWidth = (rows: readonly Row[]) =>
  Math.max(...rows.map((row) => row.label.length)) + LABEL_GAP

// One row per line when the value fits; otherwise continuation lines under the value column.
function rowLines(row: Row, labels: number, width: number): Cell[][] {
  return wrapParts(row.parts, Math.max(1, width - labels)).map((value, index) =>
    [cell(cut(index === 0 ? row.label : '', labels - 1).padEnd(labels), 'muted')].concat(value),
  )
}

function section(title: string, rows: readonly Row[], labels: number, width: number): Cell[][] {
  return [[cell(title, 'heading')], ...rows.flatMap((row) => rowLines(row, labels, width))]
}

function sideBySide(left: Cell[][], right: Cell[][]): Cell[][] {
  const leftWidth = Math.max(...left.map(widthOf))

  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
    const start = left[index] ?? []

    return [
      ...start,
      cell(' '.repeat(leftWidth - widthOf(start)) + SECTION_GAP),
      ...(right[index] ?? []),
    ]
  })
}

function summaryLines(summary: SummaryResult, width: number): Line[] {
  const spend = spendRows(summary.session)
  const limits = limitRows(summary.wallet)
  const left = section('Spend', spend, labelWidth(spend), Number.POSITIVE_INFINITY)
  const room = width - Math.max(...left.map(widthOf)) - SECTION_GAP.length
  const rigid = limits.filter((row) => !row.prose)
  const rigidWidth = Math.max(
    ...section('Limits', rigid, labelWidth(limits), Number.POSITIVE_INFINITY).map(widthOf),
  )

  if (rigidWidth <= room) {
    const right = section('Limits', limits, labelWidth(limits), room)

    return sideBySide(left, right).map((line) => fit(line, width))
  }

  // Stacked: one label column for both sections, never more than half the width.
  const shared = Math.min(labelWidth([...spend, ...limits]), Math.floor(width / 2))

  return [
    ...section('Spend', spend, shared, width),
    [],
    ...section('Limits', limits, shared, width),
  ].map((line) => fit(line, width))
}

const isUnknown = (value: number | null | undefined) => typeof value !== 'number'

const shortTime = (ts: number) => clock(ts).slice(0, 5)

function modelText(model: string | null, width: number): string {
  const full = model ?? 'unknown'

  if (full.length <= width) {
    return full
  }

  return cut(full.slice(full.indexOf('/') + 1), width)
}

function moneyCell(value: number | null | undefined): Cell {
  return typeof value === 'number' ? cell(money(value)) : cell('—', 'muted')
}

// Compact cost is OpenRouter + BYOK; the trailing column holds `?` when BYOK is unknown.
function combinedCost(entry: Entry): Cell {
  if (typeof entry.cost !== 'number') {
    return cell('— ', 'muted')
  }

  if (isUnknown(entry.byokCost)) {
    return cell(`${money(entry.cost)}?`, 'warning')
  }

  return cell(`${money(entry.cost + (entry.byokCost ?? 0))} `)
}

function byokCell(entry: Entry): Cell {
  return isUnknown(entry.byokCost) ? cell('unknown', 'warning') : moneyCell(entry.byokCost)
}

const tokensCell = (value: number | null) =>
  value === null ? cell('—', 'muted') : cell(count(value))

function column(
  title: string,
  align: Column['align'],
  entries: readonly Entry[],
  build: Column['cell'],
): Column {
  const width = Math.max(title.length, ...entries.map((entry) => build(entry).text.length))

  return { title, align, width, cell: build }
}

function roleColumn(entries: readonly Entry[]): Column[] {
  const role = (entry: Entry) => cell(entry.kind === 'primary' ? '' : entry.kind)

  return entries.some((entry) => entry.kind !== 'primary')
    ? [column('Role', 'left', entries, role)]
    : []
}

function costColumns(entries: readonly Entry[], compact: boolean): Column[] {
  if (compact) {
    return [column('Cost', 'right', entries, combinedCost)]
  }

  const byokMatters = entries.some((entry) => entry.byokCost !== 0)
  const cost = (entry: Entry) => moneyCell(entry.cost)

  return byokMatters
    ? [column('OpenRouter', 'right', entries, cost), column('BYOK', 'right', entries, byokCell)]
    : [column('Cost', 'right', entries, cost)]
}

interface Table {
  readonly time: Column
  readonly before: readonly Column[]
  readonly after: readonly Column[]
  readonly modelWidth: number
}

function modelRoom(time: Column, others: readonly Column[], width: number): number {
  const fixed = [time, ...others].reduce((sum, col) => sum + col.width + COLUMN_GAP.length, 0)

  return width - fixed
}

const timeColumn = (entries: readonly Entry[], compact: boolean) =>
  column('Time', 'left', entries, (entry) => cell(compact ? shortTime(entry.ts) : clock(entry.ts)))

function tokenColumns(entries: readonly Entry[], compact: boolean): Column[] {
  if (compact) {
    return []
  }

  return [
    column('In', 'right', entries, (entry) => tokensCell(entry.promptTokens)),
    column('Out', 'right', entries, (entry) => tokensCell(entry.completionTokens)),
  ]
}

function table(entries: readonly Entry[], width: number): Table {
  const compact = width < FULL_TABLE_WIDTH
  const time = timeColumn(entries, compact)
  const after = [...costColumns(entries, compact), ...tokenColumns(entries, compact)]
  const roles = roleColumn(entries)
  const withRoles = modelRoom(time, [...roles, ...after], width)

  // The role is the first thing to give up its place in a very narrow dialog.
  if (withRoles >= MIN_MODEL_WIDTH || !roles.length) {
    return { time, before: roles, after, modelWidth: Math.max(1, withRoles) }
  }

  return { time, before: [], after, modelWidth: Math.max(1, modelRoom(time, after, width)) }
}

function tableLine(spec: Table, cells: (col: Column) => Cell, model: Cell): Cell[] {
  const aligned = (col: Column) => {
    const value = cells(col)

    return [cell(COLUMN_GAP), cell(align(value.text, col.width, col.align), value.tone)]
  }

  return [
    cell(align(cells(spec.time).text, spec.time.width, 'left'), cells(spec.time).tone),
    cell(COLUMN_GAP),
    cell(model.text.padEnd(spec.modelWidth), model.tone),
    ...[...spec.before, ...spec.after].flatMap(aligned),
  ]
}

const dayKey = (ts: number) => new Date(ts).toDateString()

function dayLabel(ts: number, now: number): string {
  const today = new Date(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)

  if (dayKey(ts) === dayKey(now)) {
    return 'Today'
  }

  if (dayKey(ts) === yesterday.toDateString()) {
    return 'Yesterday'
  }

  const date = new Date(ts)
  const options: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }
  const sameYear = date.getFullYear() === today.getFullYear()

  return date.toLocaleDateString('en-US', sameYear ? options : { ...options, year: 'numeric' })
}

function dayRule(label: string, width: number): Cell[] {
  return [cell(`── ${label} ${'─'.repeat(Math.max(0, width - label.length - 4))}`, 'faint')]
}

function requestLines(newestFirst: readonly Entry[], spec: Table, width: number, now: number) {
  const ruled = newestFirst.some((entry) => dayKey(entry.ts) !== dayKey(now))

  return newestFirst.flatMap((entry, index) => {
    const previous = newestFirst[index - 1]
    const startsDay = ruled && (!previous || dayKey(previous.ts) !== dayKey(entry.ts))
    const row = tableLine(
      spec,
      (col) => col.cell(entry),
      cell(modelText(entry.model, spec.modelWidth)),
    )

    return [...(startsDay ? [dayRule(dayLabel(entry.ts, now), width)] : []), row].map((line) =>
      fit(line, width),
    )
  })
}

function requestsHeading(summary: SummaryResult, width: number): Line {
  const kept = summary.entries.length

  if (!kept) {
    return fit([cell('Requests', 'heading')], width)
  }

  const total = summary.session.requests
  const shown = kept < total ? `${count(kept)} of ${count(total)} kept` : count(kept)

  return fit([cell(`Requests · ${shown} · newest first`, 'heading')], width)
}

function footerLines(summary: SummaryResult, compact: boolean, width: number): Line[] {
  const unknown = compact && summary.entries.some((entry) => isUnknown(entry.byokCost))
  const parts = [
    BYOK_NOTE,
    ...(unknown ? [UNKNOWN_NOTE] : []),
    ...(summary.wallet ? [`Fetched ${clock(summary.wallet.at)}`] : []),
    ACTIVITY_URL,
  ].map((text) => cell(text, 'muted'))

  return [...wrapParts(parts, width), ...wrapParts([cell(KEY_HINTS, 'muted')], width)].map((line) =>
    fit(line, width),
  )
}

export function layoutDialog(
  summary: SummaryResult,
  options: { readonly width: number; readonly now: number },
): DialogLayout {
  const width = Math.max(1, options.width)
  // The header sits outside the scrollbox but keeps the rows' width, so the columns line up.
  const tableWidth = Math.max(1, width - SCROLLBAR_GUTTER)
  const compact = tableWidth < FULL_TABLE_WIDTH
  const footer = footerLines(summary, compact, width)
  const base = {
    summary: summaryLines(summary, width),
    requestsHeading: requestsHeading(summary, width),
    footer,
  }

  if (!summary.entries.length) {
    return {
      ...base,
      tableHeader: null,
      requests: [
        fit([cell('No OpenRouter requests captured in this session yet.', 'muted')], tableWidth),
      ],
    }
  }

  const spec = table(summary.entries, tableWidth)
  const header = tableLine(spec, (col) => cell(col.title, 'muted'), cell('Model', 'muted'))

  return {
    ...base,
    tableHeader: fit(header, tableWidth),
    requests: requestLines(summary.entries.toReversed(), spec, tableWidth, options.now),
  }
}

// The list scrolls inside whatever height the rest of the dialog leaves on screen.
export function listHeight(layout: DialogLayout, terminalHeight: number): number {
  const fixed = CHROME_LINES + layout.summary.length + layout.footer.length
  const room = Math.max(MIN_LIST_LINES, terminalHeight - fixed - SCREEN_MARGIN)

  return Math.min(layout.requests.length, room)
}
