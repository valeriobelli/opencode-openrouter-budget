// @jsxImportSource @opentui/solid
import { Plugin, usePlugin } from '@opencode/plugin/tui'
import { createSignal } from 'solid-js'
import { CostContract, type SummaryResult, type UpdatedEvent, type WalletSnapshot } from './rpc.ts'

type TuiContext = ReturnType<typeof usePlugin>

type SummaryEntry = SummaryResult['entries'][number]

interface SessionSummary {
  totalUSD: number
  byokUSD: number
  unknownBYOK: number
  lastModel: string | null
  lastCost: number | null
  lastByokCost: number | null
  requests: number
}

// totalUSD is what OpenRouter charged; byokUSD is what the provider charged on the user's own key.
interface CostSplit {
  totalUSD: number
  byokUSD: number
  unknownBYOK: number
}

interface StoreState {
  sessions: Record<string, SessionSummary>
  wallet: WalletSnapshot | null
}

type Mutate = (mutation: (draft: StoreState) => void) => void

// Structural slice of the generated RPC client: enough for the dialog and
// hydration paths, without threading SDK generics through module helpers.
interface BudgetRpc {
  summary(input: { sessionID: string }): Promise<SummaryResult>
  wallet(input: {}): Promise<{ wallet: WalletSnapshot | null }>
  refresh(input: {}): Promise<{ wallet: WalletSnapshot | null }>
}

const money = (value: number) => `$${value.toFixed(4)}`
const count = (value: number) => value.toLocaleString('en-US')

const yesNo = (value: boolean | undefined) => {
  if (value === undefined) {
    return 'unknown'
  }

  return value ? 'yes' : 'no'
}

const sessionTotalLine = (split: CostSplit, requests: number) =>
  `Session total ${money(split.totalUSD + split.byokUSD)} · ${requests} req`

function splitLine(split: CostSplit): string {
  const unknown = split.unknownBYOK > 0 ? ` (${split.unknownBYOK} unknown)` : ''

  return `OpenRouter ${money(split.totalUSD)} + BYOK ${money(split.byokUSD)}${unknown}`
}

function lastLine(model: string, cost: number | null, byokCost: number | null): string {
  if (typeof cost !== 'number') {
    return `Last: ${model}`
  }

  if (typeof byokCost !== 'number') {
    return `Last: ${model} · ${money(cost)} + BYOK unknown`
  }

  return `Last: ${model} · total ${money(cost + byokCost)}`
}

function keyRemaining(wallet: WalletSnapshot): number | null {
  if (typeof wallet.keyLimitRemaining === 'number') {
    return wallet.keyLimitRemaining
  }

  if (typeof wallet.keyLimit === 'number' && typeof wallet.keyUsage === 'number') {
    return Math.max(0, wallet.keyLimit - wallet.keyUsage)
  }

  return null
}

function keyBudgetLine(wallet: WalletSnapshot | null): string {
  if (!wallet) {
    return ''
  }

  const remaining = keyRemaining(wallet)

  if (!remaining) {
    return ''
  }

  const reset = wallet.keyLimitReset ? ` (${wallet.keyLimitReset})` : ''

  return `$${remaining.toFixed(2)} key left${reset}`
}

// Global account credits: shown only when the key can read them (e.g. the
// workspace admin). Member keys get no data here and render nothing.
function globalBudgetLine(wallet: WalletSnapshot | null): string | null {
  if (typeof wallet?.creditsRemaining !== 'number') {
    return null
  }

  return `Global: $${wallet.creditsRemaining.toFixed(2)} left`
}

function keyUsageDetail(wallet: WalletSnapshot): string {
  return [
    ...(wallet.label ? [`Key: ${wallet.label}`] : []),
    ...(typeof wallet.keyUsage === 'number'
      ? [`lifetime usage $${wallet.keyUsage.toFixed(2)}`]
      : []),
  ].join(' · ')
}

function creditsDetail(wallet: WalletSnapshot): string | null {
  if (typeof wallet.creditsRemaining !== 'number') {
    return null
  }

  const used = (wallet.creditsUsage ?? 0).toFixed(2)
  const total = (wallet.creditsTotal ?? 0).toFixed(2)

  return `Credits: $${wallet.creditsRemaining.toFixed(2)} remaining ($${used} used of $${total})`
}

function detailLine(line: string | null): string[] {
  return line ? [line] : []
}

// The key's own credit limit and the budget that blocks requests first have separate BYOK settings.
function keyLimitDetail(wallet: WalletSnapshot): string | null {
  const remaining = keyRemaining(wallet)

  if (remaining === null) {
    return null
  }

  return `Key limit: $${remaining.toFixed(2)} left · BYOK counted: ${yesNo(wallet.includeByokInLimit)}`
}

function effectiveBudgetDetail(wallet: WalletSnapshot): string | null {
  const budget = wallet.effectiveBudget

  if (!budget) {
    return null
  }

  const scope = budget.scope ? ` (${budget.scope})` : ''
  const left =
    typeof budget.remainingUSD === 'number' ? `$${budget.remainingUSD.toFixed(2)} left · ` : ''

  return `Effective budget${scope}: ${left}BYOK counted: ${yesNo(budget.includeByok)}`
}

function walletDetailLines(wallet: WalletSnapshot | null): string[] {
  return !wallet
    ? ['Wallet: no data yet']
    : [
        ...detailLine(keyUsageDetail(wallet)),
        ...detailLine(keyLimitDetail(wallet)),
        ...detailLine(effectiveBudgetDetail(wallet)),
        ...detailLine(creditsDetail(wallet)),
        ...(wallet.creditsUnavailable
          ? ['Credits: not readable with this key (management key required)']
          : []),
        ...(wallet.reason ? [`Note: ${wallet.reason}`] : []),
        `Fetched: ${new Date(wallet.at).toLocaleTimeString('en-US', { hour12: false })}`,
      ]
}

function lastEntryLine(entry: SummaryEntry): string {
  return lastLine(entry.model ?? 'unknown', entry.cost, entry.byokCost ?? null)
}

function sessionCostLines(session: SummaryResult['session']): string[] {
  const unknown = session.unknownBYOK > 0 ? ` (${session.unknownBYOK} requests unknown)` : ''

  return [
    `Session total (reported) ${money(session.totalUSD + session.byokUSD)} · ${session.requests} req`,
    `OpenRouter cost ${money(session.totalUSD)}`,
    `BYOK upstream cost (OpenRouter-reported) ${money(session.byokUSD)}${unknown}`,
  ]
}

function summaryLines(summary: SummaryResult): string[] {
  const newest = summary.entries.at(-1)
  const keyLine = keyBudgetLine(summary.wallet)

  const globalLine = globalBudgetLine(summary.wallet)

  return [
    'OpenRouter budget',
    ...sessionCostLines(summary.session),
    ...(newest ? [lastEntryLine(newest)] : []),
    ...(keyLine ? [keyLine] : []),
    ...(globalLine ? [globalLine] : []),
  ]
}

function applySpendUpdate(mutate: Mutate, data: UpdatedEvent): void {
  mutate((draft) => {
    draft.sessions[data.sessionID] = {
      totalUSD: data.totalUSD,
      byokUSD: data.byokUSD,
      unknownBYOK: data.unknownBYOK,
      lastModel: data.lastModel,
      lastCost: data.lastCost,
      lastByokCost: data.lastByokCost,
      requests: data.requests,
    }
  })
}

function applyWallet(mutate: Mutate, wallet: WalletSnapshot | null): void {
  mutate((draft) => {
    draft.wallet = wallet
  })
}

function fetchWallet(rpc: BudgetRpc, mutate: Mutate): Promise<void> {
  return rpc
    .wallet({})
    .then((result) => {
      applyWallet(mutate, result.wallet)
    })
    .catch(() => {
      // Server plugin may not be loaded (e.g. remote server). Sidebar stays quiet.
    })
}

function createWalletSubscriber(rpc: BudgetRpc, mutate: Mutate): () => Promise<void> {
  return async () => {
    try {
      const result = await rpc.wallet({})

      applyWallet(mutate, result.wallet)
    } catch {
      // Keep the last known snapshot.
    }
  }
}

function lastFields(last: SummaryEntry | undefined) {
  if (!last) {
    return { lastModel: null, lastCost: null, lastByokCost: null }
  }

  return { lastModel: last.model, lastCost: last.cost, lastByokCost: last.byokCost ?? null }
}

// After a TUI restart the memory store is empty even though the server has a
// ledger. Pull it once per session so the sidebar is accurate immediately.
function summaryToSession(summary: SummaryResult): SessionSummary {
  const { session } = summary

  return {
    totalUSD: session.totalUSD,
    byokUSD: session.byokUSD,
    unknownBYOK: session.unknownBYOK,
    ...lastFields(summary.entries.at(-1)),
    requests: session.requests,
  }
}

function createHydrator(
  rpc: Pick<BudgetRpc, 'summary'>,
  mutate: Mutate,
): (sessionID: string) => void {
  const hydrated = new Set<string>()
  const hydrating = new Set<string>()

  return (sessionID) => {
    if (!sessionID || hydrated.has(sessionID) || hydrating.has(sessionID)) {
      return
    }

    hydrating.add(sessionID)

    void rpc
      .summary({ sessionID })
      .then((summary) => {
        if (!summary.entries.length) {
          return
        }

        const session = summaryToSession(summary)

        mutate((draft) => {
          draft.sessions[sessionID] = session
        })
      })
      .catch(() => undefined)
      .finally(() => {
        hydrated.add(sessionID)
        hydrating.delete(sessionID)
      })
  }
}

function createRefresher(
  deps: { rpc: BudgetRpc; context: TuiContext },
  setSummary: (update: (prev: SummaryResult) => SummaryResult) => SummaryResult,
): () => Promise<void> {
  return async () => {
    try {
      const result = await deps.rpc.refresh({})

      setSummary((prev) => ({ ...prev, wallet: result.wallet }))
    } catch (error) {
      deps.context.ui.toast.show({
        message: `Wallet refresh failed: ${String(error)}`,
        variant: 'error',
      })
    }
  }
}

async function getSummary(
  deps: { rpc: BudgetRpc; context: TuiContext },
  sessionID?: string,
): Promise<SummaryResult> {
  try {
    return deps.rpc.summary({ sessionID: sessionID ?? '' })
  } catch (error) {
    deps.context.ui.toast.show({
      message: `OpenRouter budget unavailable: ${String(error)}`,
      variant: 'error',
    })

    throw new Error(`OpenRouter budget unavailable: ${String(error)}`)
  }
}

function createDialogOpener(deps: { rpc: BudgetRpc; context: TuiContext }): () => Promise<void> {
  return async () => {
    const route = deps.context.ui.router.current()
    const sessionID = route.type === 'session' ? route.sessionID : undefined
    const initial: SummaryResult = await getSummary(deps, sessionID)

    const [summary, setSummary] = createSignal<SummaryResult>(initial)
    const refresh = createRefresher(deps, setSummary)

    deps.context.ui.dialog.set({ size: 'xlarge', centered: true })

    deps.context.ui.dialog.show(
      () => <CostDialog summary={summary()} onRefresh={() => void refresh()} />,
      () => {},
    )
  }
}

function sessionLine(session: SessionSummary): string | null {
  if (session.lastModel === null) {
    return null
  }

  return lastLine(session.lastModel, session.lastCost, session.lastByokCost)
}

function SidebarBlock(props: {
  session: SessionSummary | undefined
  wallet: WalletSnapshot | null
}) {
  const context = usePlugin()
  const fg = context.theme.text.base
  const keyLine = keyBudgetLine(props.wallet)
  const globalLine = globalBudgetLine(props.wallet)

  return (
    <box>
      <text fg={fg}>OpenRouter</text>
      <SessionLine session={props.session} fg={fg} />
      {props.session ? <SessionDetails session={props.session} fg={fg} /> : null}
      {keyLine ? <text fg={fg}>{keyLine}</text> : null}
      {globalLine ? <text fg={fg}>{globalLine}</text> : null}
    </box>
  )
}

function SessionLine(props: { session: SessionSummary | undefined; fg: string }) {
  if (!props.session) {
    return <text fg={props.fg}>waiting for first request…</text>
  }

  return <text fg={props.fg}>{sessionTotalLine(props.session, props.session.requests)}</text>
}

function SessionDetails(props: { session: SessionSummary; fg: string }) {
  return (
    <>
      <text fg={props.fg}>{splitLine(props.session)}</text>
      <LastLine session={props.session} fg={props.fg} />
    </>
  )
}

function LastLine(props: { session: SessionSummary; fg: string }) {
  const line = sessionLine(props.session)

  return line ? <text fg={props.fg}>{line}</text> : null
}

function SummaryBlock(props: { summary: SummaryResult; fg: string }) {
  return (
    <box>
      {summaryLines(props.summary).map((line) => (
        <text fg={props.fg}>{line}</text>
      ))}
    </box>
  )
}

function rowFirst(entry: SummaryEntry): string {
  const time = new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false })
  const modelKind = `${entry.model ?? 'unknown'} [${entry.kind}]`
  const cost = typeof entry.cost === 'number' ? money(entry.cost) : '—'
  const byok = typeof entry.byokCost === 'number' ? money(entry.byokCost) : 'unknown'

  return `${time}  ${modelKind.padEnd(46)}OpenRouter ${cost} · BYOK ${byok}`
}

function rowSecond(entry: SummaryEntry): string {
  return `          in ${count(entry.promptTokens ?? 0)} → out ${count(entry.completionTokens ?? 0)}`
}

function RequestRow(props: { entry: SummaryEntry; fg: string }) {
  return (
    <box>
      <text fg={props.fg}>{rowFirst(props.entry)}</text>
      <text fg={props.fg}>{rowSecond(props.entry)}</text>
    </box>
  )
}

function RequestList(props: { entries: readonly SummaryEntry[]; fg: string }) {
  if (!props.entries.length) {
    return <text fg={props.fg}>No OpenRouter requests captured in this session yet.</text>
  }

  return (
    <box>
      {props.entries.toReversed().map((entry) => (
        <RequestRow entry={entry} fg={props.fg} />
      ))}
    </box>
  )
}

function WalletDetails(props: { wallet: WalletSnapshot | null; fg: string }) {
  return (
    <box>
      {walletDetailLines(props.wallet).map((line) => (
        <text fg={props.fg}>{line}</text>
      ))}
    </box>
  )
}

function CostDialog(props: { summary: SummaryResult; onRefresh: () => void }) {
  const context = usePlugin()

  // Layer lives and dies with this dialog component.
  context.keymap.layer(() => ({
    commands: [
      {
        id: 'openrouter-budget.dialog.refresh',
        title: 'Refresh wallet',
        bind: 'r',
        run: () => props.onRefresh(),
      },
    ],
  }))

  const fg = context.theme.text.base

  return (
    <box>
      <SummaryBlock summary={props.summary} fg={fg} />
      <text> </text>
      <text fg={fg}>Requests (newest first)</text>
      <RequestList entries={props.summary.entries} fg={fg} />
      <text> </text>
      <WalletDetails wallet={props.summary.wallet} fg={fg} />
      <text> </text>
      <text fg={fg}>
        [r] refresh wallet · [Esc] close · Full history: https://openrouter.ai/activity
      </text>
    </box>
  )
}

export default Plugin.define({
  id: 'openrouter-budget.tui',
  setup(context) {
    const rpc = context.client.rpc(CostContract)

    const [state, mutate] = context.storage.memory('openrouter-budget', {
      initial: { sessions: {}, wallet: null } as StoreState,
    })

    const hydrate = createHydrator(rpc, mutate)
    const stopUpdated = rpc.events.on('updated', (event) => applySpendUpdate(mutate, event.data))
    const stopWallet = rpc.events.on('wallet.updated', createWalletSubscriber(rpc, mutate))

    void fetchWallet(rpc, mutate)

    const stopSlot = context.ui.slot({
      append: 'sidebar.content',
      render: ({ sessionID }) => {
        // Reactive: follows the prompt's selected model, so switching providers
        // shows/hides the block immediately.
        const model = context.ui.model.current()

        if (model?.providerID !== 'openrouter') {
          return <box />
        }

        const session = state.sessions[sessionID]

        if (!session) {
          hydrate(sessionID)
        }

        return <SidebarBlock session={session} wallet={state.wallet} />
      },
    })

    const openCostDialog = createDialogOpener({ rpc, context })

    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'openrouter-budget.show',
          title: 'OpenRouter budget',
          group: 'OpenRouter',
          palette: true,
          slash: { name: 'openrouter-budget' },
          suggested: true,
          run: () => void openCostDialog(),
        },
      ],
      bindings: ['openrouter-budget.show'],
    }))

    return () => {
      stopUpdated()
      stopWallet()
      stopSlot()
    }
  },
})
