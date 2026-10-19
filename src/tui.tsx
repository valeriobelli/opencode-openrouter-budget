import { Plugin, usePlugin } from '@opencode/plugin/tui'
import { createSignal } from 'solid-js'
import { CostContract, type SummaryResult, type WalletSnapshot } from './rpc.js'

const money = (value: number) => `$${value.toFixed(4)}`
const count = (value: number) => value.toLocaleString('en-US')

function keyBudgetLine(wallet: WalletSnapshot | null): string {
  if (!wallet) {
    return ''
  }

  if (typeof wallet.keyLimitRemaining === 'number') {
    const reset = wallet.keyLimitReset ? ` (${wallet.keyLimitReset})` : ''

    return `$${wallet.keyLimitRemaining.toFixed(2)} key left${reset}`
  }

  if (typeof wallet.keyLimit === 'number' && typeof wallet.keyUsage === 'number') {
    return `$${Math.max(0, wallet.keyLimit - wallet.keyUsage).toFixed(2)} key left`
  }

  return ''
}

// Global account credits: shown only when the key can read them (e.g. the
// workspace admin). Member keys get no data here and render nothing.
function globalBudgetLine(wallet: WalletSnapshot | null): string | null {
  return typeof wallet?.creditsRemaining === 'number'
    ? `Global: $${wallet.creditsRemaining.toFixed(2)} left`
    : null
}

function walletDetailLines(wallet: WalletSnapshot | null): string[] {
  if (!wallet) {
    return ['Wallet: no data yet']
  }

  const lines: string[] = []
  const parts: string[] = []

  if (wallet.label) {
    parts.push(`Key: ${wallet.label}`)
  }

  if (typeof wallet.keyUsage === 'number') {
    parts.push(`lifetime usage $${wallet.keyUsage.toFixed(2)}`)
  }

  if (parts.length > 0) {
    lines.push(parts.join(' · '))
  }

  if (typeof wallet.creditsRemaining === 'number') {
    lines.push(
      `Credits: $${wallet.creditsRemaining.toFixed(2)} remaining ($${(wallet.creditsUsage ?? 0).toFixed(2)} used of $${(wallet.creditsTotal ?? 0).toFixed(2)})`,
    )
  }

  if (wallet.creditsUnavailable) {
    lines.push('Credits: not readable with this key (management key required)')
  }

  if (wallet.reason) {
    lines.push(`Note: ${wallet.reason}`)
  }

  lines.push(`Fetched: ${new Date(wallet.at).toLocaleTimeString('en-US', { hour12: false })}`)

  return lines
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

  const s = props.summary
  const fg = context.theme.text.base

  // Sidebar block, mirrored so the dialog is a standalone replacement when the
  // sidebar does not fit on screen.
  const block: string[] = ['OpenRouter budget']

  block.push(`Session ${money(s.session.totalUSD)} · ${s.session.requests} req`)
  const newest = [...s.entries].at(-1)

  if (newest) {
    const cost = typeof newest.cost === 'number' ? ` · ${money(newest.cost)}` : ''

    block.push(`Last: ${newest.model ?? 'unknown'}${cost}`)
  }

  const keyLine = keyBudgetLine(s.wallet)

  if (keyLine) {
    block.push(keyLine)
  }

  const globalLine = globalBudgetLine(s.wallet)

  if (globalLine) {
    block.push(globalLine)
  }

  // Two-line rows: time, model [kind], and an aligned cost column; token
  // counts on the indented second line so nothing ever wraps.
  const rows = [...s.entries].reverse().map((entry) => {
    const time = new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false })
    const modelKind = `${entry.model ?? 'unknown'} [${entry.kind}]`
    const cost = typeof entry.cost === 'number' ? money(entry.cost) : '—'

    return {
      first: `${time}  ${modelKind.padEnd(46)}${cost}`,
      second: `          in ${count(entry.promptTokens ?? 0)} → out ${count(entry.completionTokens ?? 0)}`,
    }
  })

  return (
    <box>
      {block.map((line) => (
        <text fg={fg}>{line}</text>
      ))}
      <text> </text>
      <text fg={fg}>Requests (newest first)</text>
      {rows.length > 0 ? (
        <box>
          {rows.map((row) => (
            <box>
              <text fg={fg}>{row.first}</text>
              <text fg={fg}>{row.second}</text>
            </box>
          ))}
        </box>
      ) : (
        <text fg={fg}>No OpenRouter requests captured in this session yet.</text>
      )}
      <text> </text>
      {walletDetailLines(s.wallet).map((line) => (
        <text fg={fg}>{line}</text>
      ))}
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
      initial: {
        sessions: {} as Record<
          string,
          { totalUSD: number; lastModel: string | null; lastCost: number | null; requests: number }
        >,
        wallet: null as WalletSnapshot | null,
      },
    })

    const stopUpdated = rpc.events.on('updated', (event) => {
      const data = event.data

      mutate((draft) => {
        draft.sessions[data.sessionID] = {
          totalUSD: data.totalUSD,
          lastModel: data.lastModel,
          lastCost: data.lastCost,
          requests: data.requests,
        }
      })
    })

    const stopWallet = rpc.events.on('wallet.updated', async () => {
      try {
        const result = await rpc.wallet({})

        mutate((draft) => {
          draft.wallet = result.wallet
        })
      } catch {
        // Keep the last known snapshot.
      }
    })

    void (async () => {
      try {
        const result = await rpc.wallet({})

        mutate((draft) => {
          draft.wallet = result.wallet
        })
      } catch {
        // Server plugin may not be loaded (e.g. remote server). Sidebar stays quiet.
      }
    })()

    // After a TUI restart the memory store is empty even though the server has
    // a ledger. Pull it once per session so the sidebar is accurate immediately.
    const hydrated = new Set<string>()
    const hydrating = new Set<string>()

    const hydrate = (sessionID: string) => {
      if (!sessionID || hydrated.has(sessionID) || hydrating.has(sessionID)) {
        return
      }

      hydrating.add(sessionID)

      void rpc
        .summary({ sessionID })
        .then((summary) => {
          if (summary.entries.length === 0) {
            return
          }

          const last = summary.entries[summary.entries.length - 1]

          mutate((draft) => {
            draft.sessions[sessionID] = {
              totalUSD: summary.session.totalUSD,
              lastModel: last?.model ?? null,
              lastCost: last?.cost ?? null,
              requests: summary.session.requests,
            }
          })
        })
        .catch(() => undefined)
        .finally(() => {
          hydrated.add(sessionID)
          hydrating.delete(sessionID)
        })
    }

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

        const keyLine = keyBudgetLine(state.wallet)
        const globalLine = globalBudgetLine(state.wallet)
        const fg = context.theme.text.base

        return (
          <box>
            <text fg={fg}>OpenRouter</text>
            {session ? (
              <text
                fg={fg}
              >{`Session $${session.totalUSD.toFixed(4)} · ${session.requests} req`}</text>
            ) : (
              <text fg={fg}>waiting for first request…</text>
            )}
            {session?.lastModel ? (
              <text fg={fg}>
                {`Last: ${session.lastModel}${typeof session.lastCost === 'number' ? ` · ${money(session.lastCost)}` : ''}`}
              </text>
            ) : null}
            {keyLine ? <text fg={fg}>{keyLine}</text> : null}
            {globalLine ? <text fg={fg}>{globalLine}</text> : null}
          </box>
        )
      },
    })

    async function openDialog() {
      const route = context.ui.router.current()
      const sessionID = route.type === 'session' ? route.sessionID : undefined
      let initial: SummaryResult

      try {
        initial = await rpc.summary({ sessionID: sessionID ?? '' })
      } catch (error) {
        context.ui.toast.show({
          message: `OpenRouter budget unavailable: ${String(error)}`,
          variant: 'error',
        })

        return
      }

      const [summary, setSummary] = createSignal<SummaryResult>(initial)

      const onRefresh = async () => {
        try {
          const result = await rpc.refresh({})

          setSummary((prev) => ({ ...prev, wallet: result.wallet }))
        } catch (error) {
          context.ui.toast.show({
            message: `Wallet refresh failed: ${String(error)}`,
            variant: 'error',
          })
        }
      }

      context.ui.dialog.set({ size: 'xlarge', centered: true })

      context.ui.dialog.show(
        () => <CostDialog summary={summary()} onRefresh={() => void onRefresh()} />,
        () => {},
      )
    }

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
          run: () => void openDialog(),
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
