import { Plugin } from '@opencode/plugin'
import {
  Credential,
  CredentialKey,
  decodeCredits,
  decodeKeyInfo,
  decodeLegacyAuthKey,
} from './decode.ts'
import { parseResponseText } from './parse.ts'
import {
  CostContract,
  type CostEntry,
  type SessionLedger,
  type UpdatedEvent,
  type Wallet,
} from './rpc.ts'
import { Result, Schema } from 'effect'

const OPENROUTER_INTEGRATION = 'openrouter'
const KEY_URL = 'https://openrouter.ai/api/v1/key'
const LEGACY_KEY_URL = 'https://openrouter.ai/api/v1/auth/key'
const CREDITS_URL = 'https://openrouter.ai/api/v1/credits'
const WALLET_INTERVAL_MS = 5 * 60 * 1000
const WALLET_MIN_POLL_MS = 60 * 1000
const WARN_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 1000

interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

interface Integration {
  connection: {
    active(integrationID: string): Promise<unknown>
    resolve(connection: unknown): Promise<unknown>
  }
}

interface ServerDeps {
  readonly storage: Storage
  readonly credential: () => Promise<string | null>
  readonly events: {
    spendUpdated(event: UpdatedEvent): Promise<void>
    walletUpdated(at: number): Promise<void>
  }
}

interface HttpResponseEvent {
  readonly sessionID: string
  readonly kind: string
  response: Response
}

const ledgers = new Map<string, SessionLedger>()
let walletCache: Wallet | null = null
let lastWarnAt = 0

function warn(message: string): void {
  const now = Date.now()

  if (now - lastWarnAt < WARN_INTERVAL_MS) {
    return
  }

  lastWarnAt = now

  console.warn(`[openrouter-budget] ${message}`)
}

const spendKey = (sessionID: string) => `spend/${sessionID}`

async function loadLedger(storage: Storage, sessionID: string): Promise<SessionLedger> {
  const cached = ledgers.get(sessionID)

  if (cached) {
    return cached
  }

  let loaded: unknown

  try {
    loaded = await storage.get(spendKey(sessionID))
  } catch (error) {
    warn(`storage read failed: ${String(error)}`)
  }

  const ledger = (loaded as SessionLedger | undefined) ?? {
    sessionID,
    startedAt: Date.now(),
    totalUSD: 0,
    entries: [],
  }

  ledgers.set(sessionID, ledger)

  return ledger
}

async function saveLedger(storage: Storage, ledger: SessionLedger): Promise<void> {
  try {
    await storage.set(spendKey(ledger.sessionID), JSON.parse(JSON.stringify(ledger)))
  } catch (error) {
    warn(`storage write failed: ${String(error)}`)
  }
}

function processEnvKey(): string | null {
  const decode = Schema.decodeUnknownResult(CredentialKey)
  const envKey = decode(process.env.OPENROUTER_API_KEY)

  return Result.isFailure(envKey) ? null : envKey.success
}

function validCredentialKey(credential: unknown): string | null {
  const decode = Schema.decodeUnknownResult(Credential)
  const decodedCredential = decode(credential)

  return Result.isFailure(decodedCredential) ? null : decodedCredential.success.key
}

async function credentialKey(integration: Integration): Promise<string | null> {
  try {
    const connection = await integration.connection.active(OPENROUTER_INTEGRATION)

    if (connection) {
      const credential = await integration.connection.resolve(connection)
      const key = validCredentialKey(credential)

      if (key !== null) {
        return key
      }
    }
  } catch (error) {
    warn(`credential resolve failed: ${String(error)}`)
  }

  return processEnvKey()
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

function applyLegacyKeyInfo(wallet: Wallet, key: string): Promise<void> {
  return fetchJSON(LEGACY_KEY_URL, key).then((value) => {
    const auth = decodeLegacyAuthKey(value)

    if (auth?.data) {
      wallet.label = auth.data.label
      wallet.keyUsage = auth.data.usage
      wallet.keyLimit = auth.data.limit ?? null
    }
  })
}

interface KeyInfoData {
  label?: string
  usage?: number
  limit?: number | null
  limit_remaining?: number | null
  limit_reset?: string | null
}

function assignKeyFields(wallet: Wallet, data: KeyInfoData): void {
  wallet.label = data.label
  wallet.keyUsage = data.usage
  wallet.keyLimit = data.limit ?? null
  wallet.keyLimitRemaining = data.limit_remaining ?? null
  wallet.keyLimitReset = data.limit_reset ?? null
}

function keyInfoDataOf(value: unknown): KeyInfoData | null {
  const keyInfo = decodeKeyInfo(value)

  if (keyInfo?.data) {
    return keyInfo.data
  }

  return null
}

async function applyKeyInfoFallback(wallet: Wallet, key: string): Promise<void> {
  // /api/v1/key unavailable — fall back to the legacy key endpoint.
  try {
    await applyLegacyKeyInfo(wallet, key)
  } catch (error) {
    wallet.reason = `key info failed: ${String(error)}`
  }
}

async function applyKeyInfo(wallet: Wallet, key: string): Promise<void> {
  try {
    const data = keyInfoDataOf(await fetchJSON(KEY_URL, key))

    if (!data) {
      return
    }

    assignKeyFields(wallet, data)
  } catch {
    await applyKeyInfoFallback(wallet, key)
  }
}

function remainingOf(total: number | undefined, used: number | undefined): number | null {
  if (typeof total !== 'number' || typeof used !== 'number') {
    return null
  }

  return Math.max(0, total - used)
}

function assignCredits(credits: ReturnType<typeof decodeCredits>, wallet: Wallet): void {
  if (credits?.data) {
    wallet.creditsTotal = credits.data.total_credits
    wallet.creditsUsage = credits.data.total_usage
  }

  const remaining = remainingOf(wallet.creditsTotal, wallet.creditsUsage)

  if (remaining !== null) {
    wallet.creditsRemaining = remaining
  }
}

async function applyCredits(wallet: Wallet, key: string): Promise<void> {
  try {
    assignCredits(decodeCredits(await fetchJSON(CREDITS_URL, key)), wallet)
  } catch {
    wallet.creditsUnavailable = true
  }
}

function walletFresh(wallet: Wallet, now: number): boolean {
  return now - wallet.at < WALLET_MIN_POLL_MS
}

function freshCache(force: boolean, now: number): Wallet | null {
  if (force || walletCache === null) {
    return null
  }

  return walletFresh(walletCache, now) ? walletCache : null
}

function describeWallet(wallet: Wallet): string {
  return (
    `[openrouter-budget] wallet keyRemaining=${wallet.keyLimitRemaining ?? '?'} ` +
    `creditsRemaining=${wallet.creditsRemaining ?? '?'} reason=${wallet.reason ?? 'none'}`
  )
}

async function pollWallet(deps: ServerDeps, force = false): Promise<Wallet | null> {
  const now = Date.now()
  const fresh = freshCache(force, now)

  if (!fresh) {
    return fresh
  }

  const key = await deps.credential()

  if (!key) {
    walletCache = {
      at: now,
      reason:
        'No OpenRouter credential available. Connect OpenRouter (/connect) or set OPENROUTER_API_KEY.',
    }
  } else {
    const next: Wallet = { at: now }

    await applyKeyInfo(next, key)
    await applyCredits(next, key)
    walletCache = next
  }

  try {
    await deps.storage.set('wallet', JSON.parse(JSON.stringify(walletCache)))
  } catch {
    // Non-fatal: memory cache still serves reads.
  }

  console.log(describeWallet(walletCache))
  await deps.events.walletUpdated(walletCache.at)

  return walletCache
}

async function summaryFor(deps: ServerDeps, sessionID: string) {
  if (!sessionID) {
    return {
      session: { sessionID: '', startedAt: 0, totalUSD: 0, requests: 0 },
      entries: [],
      wallet: walletCache,
    }
  }

  const ledger = await loadLedger(deps.storage, sessionID)

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
}

function recordEntry(ledger: SessionLedger, entry: CostEntry): void {
  ledger.entries.push(entry)

  if (ledger.entries.length > MAX_ENTRIES) {
    ledger.entries.splice(0, ledger.entries.length - MAX_ENTRIES)
  }

  if (typeof entry.cost === 'number') {
    ledger.totalUSD = Math.round((ledger.totalUSD + entry.cost) * 1e6) / 1e6
  }
}

function entryOf(
  kind: string,
  captured: NonNullable<ReturnType<typeof parseResponseText>>,
): CostEntry {
  return {
    ts: Date.now(),
    kind,
    model: captured.model,
    cost: captured.cost,
    promptTokens: captured.promptTokens,
    completionTokens: captured.completionTokens,
    generationID: captured.generationID,
  }
}

function describeCapture(entry: CostEntry, ledger: SessionLedger, sessionID: string): string {
  return (
    `[openrouter-budget] ${entry.kind} model=${entry.model ?? 'unknown'} cost=${entry.cost ?? '?'} ` +
    `session=${sessionID.slice(0, 8)} total=$${ledger.totalUSD.toFixed(4)}`
  )
}

async function consume(
  deps: ServerDeps,
  sessionID: string,
  kind: string,
  clone: ReadableStream<Uint8Array>,
  contentType: string,
): Promise<void> {
  let text: string

  try {
    text = await new Response(clone).text()
  } catch {
    // Aborted/interrupted requests carry no usage worth recording.
    return
  }

  const captured = parseResponseText(text, contentType)

  if (!captured) {
    return
  }

  const ledger = await loadLedger(deps.storage, sessionID)
  const entry = entryOf(kind, captured)

  recordEntry(ledger, entry)

  await saveLedger(deps.storage, ledger)

  console.log(describeCapture(entry, ledger, sessionID))

  try {
    await deps.events.spendUpdated({
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

interface StreamSplit {
  main: ReadableStream<Uint8Array>
  clone: ReadableStream<Uint8Array>
  contentType: string
}

function splitStream(response: Response): StreamSplit | null {
  const body = response.body

  if (!body) {
    return null
  }

  let main: ReadableStream<Uint8Array>
  let clone: ReadableStream<Uint8Array>

  try {
    ;[main, clone] = body.tee()
  } catch (error) {
    warn(`tee failed: ${String(error)}`)

    return null
  }

  return { main, clone, contentType: response.headers.get('content-type') ?? '' }
}

function onResponse(deps: ServerDeps, event: HttpResponseEvent): void {
  const split = splitStream(event.response)

  if (!split) {
    return
  }

  // Replace first, parse second: the model stream is never at risk.
  event.response = new Response(split.main, {
    status: event.response.status,
    statusText: event.response.statusText,
    headers: event.response.headers,
  })

  void consume(deps, event.sessionID, event.kind, split.clone, split.contentType)
}

export default Plugin.define({
  id: 'openrouter-budget',
  async setup(ctx) {
    let deps: ServerDeps

    const registration = await ctx.rpc.register(CostContract, {
      summary: async (input) =>
        summaryFor(deps, (input as { sessionID?: string })?.sessionID ?? ''),
      wallet: async () => ({ wallet: walletCache }),
      refresh: async () => ({ wallet: await pollWallet(deps, true) }),
    })

    deps = {
      storage: ctx.storage,
      credential: () => credentialKey(ctx.integration),
      events: {
        spendUpdated: (event) => registration.events.emit('updated', event),
        walletUpdated: (at) => registration.events.emit('wallet.updated', { at }),
      },
    }

    try {
      walletCache = (await ctx.storage.get('wallet')) as Wallet | null
    } catch {
      // Start fresh.
    }

    void pollWallet(deps, true).catch(() => undefined)

    const timer = setInterval(
      () => void pollWallet(deps).catch(() => undefined),
      WALLET_INTERVAL_MS,
    )

    await ctx.session.hook('http.response', (event) => onResponse(deps, event), {
      providerID: 'openrouter',
    })

    return () => {
      clearInterval(timer)
      ledgers.clear()
    }
  },
})
