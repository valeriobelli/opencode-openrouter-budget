import { Plugin } from '@opencode/plugin'
import { parseResponseText } from './parse.js'
import { CostContract, type CostEntry, type SessionLedger, type Wallet } from './rpc.js'

const OPENROUTER_INTEGRATION = 'openrouter'
const WALLET_INTERVAL_MS = 5 * 60 * 1000
const WALLET_MIN_POLL_MS = 60 * 1000
const MAX_ENTRIES = 1000

export default Plugin.define({
  id: 'openrouter-budget',
  async setup(ctx) {
    const ledgers = new Map<string, SessionLedger>()
    let walletCache: Wallet | null = null
    let lastWarnAt = 0

    function warn(message: string) {
      const now = Date.now()

      if (now - lastWarnAt < 24 * 60 * 60 * 1000) {
        return
      }

      lastWarnAt = now
      console.warn(`[openrouter-budget] ${message}`)
    }

    const storageKey = (sessionID: string) => `spend/${sessionID}`

    async function loadLedger(sessionID: string): Promise<SessionLedger> {
      const cached = ledgers.get(sessionID)

      if (cached) {
        return cached
      }

      let loaded: unknown

      try {
        loaded = await ctx.storage.get(storageKey(sessionID))
      } catch (error) {
        warn(`storage read failed: ${String(error)}`)
      }

      const ledger: SessionLedger = (loaded as SessionLedger | undefined) ?? {
        sessionID,
        startedAt: Date.now(),
        totalUSD: 0,
        entries: [],
      }

      ledgers.set(sessionID, ledger)

      return ledger
    }

    async function saveLedger(ledger: SessionLedger) {
      try {
        await ctx.storage.set(storageKey(ledger.sessionID), JSON.parse(JSON.stringify(ledger)))
      } catch (error) {
        warn(`storage write failed: ${String(error)}`)
      }
    }

    async function resolveKey(): Promise<string | null> {
      try {
        const connection = await ctx.integration.connection.active(OPENROUTER_INTEGRATION)

        if (connection) {
          const credential = (await ctx.integration.connection.resolve(connection)) as
            | { type?: string; key?: string }
            | undefined

          if (
            credential?.type === 'key' &&
            typeof credential.key === 'string' &&
            credential.key.length > 0
          ) {
            return credential.key
          }
        }
      } catch (error) {
        warn(`credential resolve failed: ${String(error)}`)
      }

      const envKey = process.env.OPENROUTER_API_KEY

      return typeof envKey === 'string' && envKey.length > 0 ? envKey : null
    }

    async function fetchJSON(url: string, key: string): Promise<unknown> {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      return response.json()
    }

    async function pollWallet(force = false): Promise<Wallet | null> {
      const now = Date.now()

      if (!force && walletCache && now - walletCache.at < WALLET_MIN_POLL_MS) {
        return walletCache
      }

      const key = await resolveKey()

      if (!key) {
        walletCache = {
          at: now,
          reason:
            'No OpenRouter credential available. Connect OpenRouter (/connect) or set OPENROUTER_API_KEY.',
        }
      } else {
        const next: Wallet = { at: now }

        try {
          const keyInfo = (await fetchJSON('https://openrouter.ai/api/v1/key', key)) as {
            data?: {
              label?: unknown
              usage?: unknown
              limit?: unknown
              limit_remaining?: unknown
              limit_reset?: unknown
            }
          }

          if (keyInfo?.data) {
            next.label = typeof keyInfo.data.label === 'string' ? keyInfo.data.label : undefined
            next.keyUsage = typeof keyInfo.data.usage === 'number' ? keyInfo.data.usage : undefined
            next.keyLimit = typeof keyInfo.data.limit === 'number' ? keyInfo.data.limit : null

            next.keyLimitRemaining =
              typeof keyInfo.data.limit_remaining === 'number' ? keyInfo.data.limit_remaining : null

            next.keyLimitReset =
              typeof keyInfo.data.limit_reset === 'string' ? keyInfo.data.limit_reset : null
          }
        } catch {
          // /api/v1/key unavailable — fall back to the legacy key endpoint.
          try {
            const auth = (await fetchJSON('https://openrouter.ai/api/v1/auth/key', key)) as {
              data?: { label?: unknown; usage?: unknown; limit?: unknown }
            }

            if (auth?.data) {
              next.label = typeof auth.data.label === 'string' ? auth.data.label : undefined
              next.keyUsage = typeof auth.data.usage === 'number' ? auth.data.usage : undefined
              next.keyLimit = typeof auth.data.limit === 'number' ? auth.data.limit : null
            }
          } catch (error) {
            next.reason = `key info failed: ${String(error)}`
          }
        }

        try {
          const credits = (await fetchJSON('https://openrouter.ai/api/v1/credits', key)) as {
            data?: { total_credits?: unknown; total_usage?: unknown }
          }

          if (credits?.data) {
            next.creditsTotal =
              typeof credits.data.total_credits === 'number'
                ? credits.data.total_credits
                : undefined

            next.creditsUsage =
              typeof credits.data.total_usage === 'number' ? credits.data.total_usage : undefined

            if (typeof next.creditsTotal === 'number' && typeof next.creditsUsage === 'number') {
              next.creditsRemaining = Math.max(0, next.creditsTotal - next.creditsUsage)
            }
          }
        } catch {
          next.creditsUnavailable = true
        }

        walletCache = next
      }

      try {
        await ctx.storage.set('wallet', JSON.parse(JSON.stringify(walletCache)))
      } catch {
        // Non-fatal: memory cache still serves reads.
      }

      console.log(
        `[openrouter-budget] wallet label=${walletCache.label ?? '?'} keyRemaining=${walletCache.keyLimitRemaining ?? '?'} ` +
          `keyUsage=${walletCache.keyUsage ?? '?'} creditsRemaining=${walletCache.creditsRemaining ?? '?'} ` +
          `reason=${walletCache.reason ?? 'none'}`,
      )
      await registration.events.emit('wallet.updated', { at: walletCache.at })

      return walletCache
    }

    const registration = await ctx.rpc.register(CostContract, {
      summary: async (input) => {
        const sessionID = (input as { sessionID?: string })?.sessionID ?? ''

        if (!sessionID) {
          return {
            session: { sessionID: '', startedAt: 0, totalUSD: 0, requests: 0 },
            entries: [],
            wallet: walletCache,
          }
        }

        const ledger = await loadLedger(sessionID)

        return {
          session: {
            sessionID,
            startedAt: ledger.startedAt,
            totalUSD: ledger.totalUSD,
            requests: ledger.entries.length,
          },
          entries: ledger.entries.slice(-200),
          wallet: walletCache,
        }
      },
      wallet: async () => ({ wallet: walletCache }),
      refresh: async () => ({ wallet: await pollWallet(true) }),
    })

    async function consume(
      sessionID: string,
      kind: string,
      clone: ReadableStream<Uint8Array>,
      contentType: string,
    ) {
      let text: string

      try {
        text = await new Response(clone).text()
      } catch {
        return // Aborted/interrupted requests carry no usage worth recording.
      }

      let captured: ReturnType<typeof parseResponseText>

      try {
        captured = parseResponseText(text, contentType)
      } catch (error) {
        warn(`parse failed: ${String(error)}`)

        return
      }

      if (!captured) {
        return
      }

      const entry: CostEntry = {
        ts: Date.now(),
        kind,
        model: captured.model,
        cost: captured.cost,
        promptTokens: captured.promptTokens,
        completionTokens: captured.completionTokens,
        generationID: captured.generationID,
      }
      const ledger = await loadLedger(sessionID)

      ledger.entries.push(entry)

      if (ledger.entries.length > MAX_ENTRIES) {
        ledger.entries.splice(0, ledger.entries.length - MAX_ENTRIES)
      }

      if (typeof entry.cost === 'number') {
        ledger.totalUSD = Math.round((ledger.totalUSD + entry.cost) * 1e6) / 1e6
      }

      await saveLedger(ledger)

      console.log(
        `[openrouter-budget] ${kind} model=${entry.model ?? 'unknown'} cost=${entry.cost ?? '?'} ` +
          `session=${sessionID.slice(0, 8)} total=$${ledger.totalUSD.toFixed(4)}`,
      )

      try {
        await registration.events.emit('updated', {
          sessionID,
          totalUSD: ledger.totalUSD,
          lastModel: entry.model,
          lastCost: entry.cost,
          requests: ledger.entries.length,
        })
      } catch (error) {
        warn(`event emit failed: ${String(error)}`)
      }
    }

    await ctx.session.hook(
      'http.response',
      (event) => {
        const body = event.response.body

        if (!body) {
          return
        }

        let main: ReadableStream<Uint8Array>
        let clone: ReadableStream<Uint8Array>

        try {
          ;[main, clone] = body.tee()
        } catch (error) {
          warn(`tee failed: ${String(error)}`)

          return
        }

        const contentType = event.response.headers.get('content-type') ?? ''

        // Replace first, parse second: the model stream is never at risk.
        event.response = new Response(main, {
          status: event.response.status,
          statusText: event.response.statusText,
          headers: event.response.headers,
        })
        void consume(event.sessionID, event.kind, clone, contentType)
      },
      { providerID: 'openrouter' },
    )

    try {
      walletCache = (await ctx.storage.get('wallet')) as Wallet | null
    } catch {
      // Start fresh.
    }

    void pollWallet(true).catch(() => {})
    const timer = setInterval(() => void pollWallet().catch(() => {}), WALLET_INTERVAL_MS)

    return () => {
      clearInterval(timer)
      ledgers.clear()
    }
  },
})
