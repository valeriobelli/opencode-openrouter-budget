// @jsxImportSource @opentui/solid
import { Plugin, usePlugin } from '@opencode/plugin/tui'
import { useTerminalDimensions } from '@opentui/solid'
import { For, Show, createMemo, createSignal } from 'solid-js'
import { type Cell, type Line, keyRemaining, layoutDialog, listHeight } from './dialog-layout.ts'
import { balance, money } from './format.ts'
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

function keyBudgetLine(wallet: WalletSnapshot | null): string {
  if (!wallet) {
    return ''
  }

  const remaining = keyRemaining(wallet)

  if (!remaining) {
    return ''
  }

  const reset = wallet.keyLimitReset ? ` (${wallet.keyLimitReset})` : ''

  return `${balance(remaining)} key left${reset}`
}

// Global account credits: shown only when the key can read them (e.g. the
// workspace admin). Member keys get no data here and render nothing.
function globalBudgetLine(wallet: WalletSnapshot | null): string | null {
  if (typeof wallet?.creditsRemaining !== 'number') {
    return null
  }

  return `Global: ${balance(wallet.creditsRemaining)} left`
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
      () => (
        <CostDialog
          summary={summary()}
          onRefresh={() => void refresh()}
          onClose={() => deps.context.ui.dialog.clear()}
        />
      ),
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

// OpenCode's own dialogs keep 3 columns of padding on each side.
const DIALOG_PADDING = 3
// OpenCode 2.4.1 `xlarge` dialog width, used only until the dialog measures itself.
const XLARGE_WIDTH = 116

// The slice of OpenTUI's ScrollBoxRenderable that the dialog drives.
interface Scroller {
  scrollBy(delta: number): void
  scrollTo(position: number): void
}

function tonePalette(theme: TuiContext['theme']) {
  return {
    title: theme.text.base,
    heading: theme.text.muted,
    base: theme.text.base,
    muted: theme.text.muted,
    faint: theme.text.faint,
    warning: theme.text.feedback.warning.base,
  }
}

type Palette = ReturnType<typeof tonePalette>

function CellText(props: { cell: Cell; palette: Palette }) {
  const bold = props.cell.tone === 'title' || props.cell.tone === 'heading'

  return (
    <text fg={props.palette[props.cell.tone]} wrapMode="none">
      {bold ? <strong>{props.cell.text}</strong> : props.cell.text}
    </text>
  )
}

function LineView(props: { line: Line; palette: Palette }) {
  return (
    <box flexDirection="row" height={1}>
      <For each={props.line}>{(cell) => <CellText cell={cell} palette={props.palette} />}</For>
    </box>
  )
}

function Lines(props: { lines: readonly Line[]; palette: Palette }) {
  return <For each={props.lines}>{(line) => <LineView line={line} palette={props.palette} />}</For>
}

function CostDialog(props: { summary: SummaryResult; onRefresh: () => void; onClose: () => void }) {
  const context = usePlugin()
  const terminal = useTerminalDimensions()
  const palette = tonePalette(context.theme)
  const [measured, setMeasured] = createSignal<number | null>(null)
  const dialogWidth = () => measured() ?? Math.min(XLARGE_WIDTH, terminal().width - 2)
  const layout = createMemo(() =>
    layoutDialog(props.summary, {
      width: dialogWidth() - DIALOG_PADDING * 2,
      now: Date.now(),
    }),
  )
  const height = () => listHeight(layout(), terminal().height)
  let list: Scroller | undefined

  // Lives and dies with this dialog. OpenCode switches to its `modal` input
  // mode while a dialog is open, and a layer without a mode only runs in `base`.
  context.keymap.layer(() => ({
    mode: 'modal',
    commands: [
      {
        id: 'openrouter-budget.dialog.refresh',
        title: 'Refresh wallet',
        bind: 'r',
        run: () => props.onRefresh(),
      },
      { title: 'Scroll requests up', bind: 'up', run: () => list?.scrollBy(-1) },
      { title: 'Scroll requests down', bind: 'down', run: () => list?.scrollBy(1) },
      { title: 'Previous page of requests', bind: 'pageup', run: () => list?.scrollBy(-height()) },
      { title: 'Next page of requests', bind: 'pagedown', run: () => list?.scrollBy(height()) },
      { title: 'Newest request', bind: 'home', run: () => list?.scrollTo(0) },
      {
        title: 'Oldest request',
        bind: 'end',
        run: () => list?.scrollTo(Number.POSITIVE_INFINITY),
      },
    ],
  }))

  return (
    <box
      paddingLeft={DIALOG_PADDING}
      paddingRight={DIALOG_PADDING}
      paddingBottom={1}
      onSizeChange={function () {
        setMeasured(this.width)
      }}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={palette.title} wrapMode="none">
          <strong>OpenRouter budget</strong>
        </text>
        <text fg={palette.muted} wrapMode="none" onMouseUp={() => props.onClose()}>
          esc
        </text>
      </box>
      <text> </text>
      <Lines lines={layout().summary} palette={palette} />
      <text> </text>
      <LineView line={layout().requestsHeading} palette={palette} />
      <Show when={layout().tableHeader}>
        {(header) => <LineView line={header()} palette={palette} />}
      </Show>
      <scrollbox
        ref={(element) => {
          list = element
        }}
        height={height()}
      >
        <Lines lines={layout().requests} palette={palette} />
      </scrollbox>
      <text> </text>
      <Lines lines={layout().footer} palette={palette} />
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
