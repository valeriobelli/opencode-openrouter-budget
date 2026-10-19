import { Rpc } from '@opencode/plugin/rpc'

/** Wallet/key snapshot from OpenRouter. `reason` explains missing data. */
export interface Wallet {
  at: number
  label?: string
  keyUsage?: number
  keyLimit?: number | null
  keyLimitRemaining?: number | null
  keyLimitReset?: string | null
  creditsTotal?: number
  creditsUsage?: number
  creditsRemaining?: number
  creditsUnavailable?: boolean
  reason?: string
}

/** One captured OpenRouter response. */
export interface CostEntry {
  ts: number
  kind: string
  model: string | null
  cost: number | null
  promptTokens: number | null
  completionTokens: number | null
  generationID: string | null
}

/** Per-session spend ledger. Persisted under `spend/<sessionID>`. */
export interface SessionLedger {
  sessionID: string
  startedAt: number
  totalUSD: number
  entries: CostEntry[]
}

const walletSchema = {
  type: ['object', 'null'] as const,
  properties: {
    at: { type: 'number' },
    label: { type: 'string' },
    keyUsage: { type: 'number' },
    keyLimit: { type: ['number', 'null'] },
    keyLimitRemaining: { type: ['number', 'null'] },
    keyLimitReset: { type: ['string', 'null'] },
    creditsTotal: { type: 'number' },
    creditsUsage: { type: 'number' },
    creditsRemaining: { type: 'number' },
    creditsUnavailable: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['at'],
  additionalProperties: false,
}

const entrySchema = {
  type: 'object',
  properties: {
    ts: { type: 'number' },
    kind: { type: 'string' },
    model: { type: ['string', 'null'] },
    cost: { type: ['number', 'null'] },
    promptTokens: { type: ['number', 'null'] },
    completionTokens: { type: ['number', 'null'] },
    generationID: { type: ['string', 'null'] },
  },
  required: ['ts', 'kind', 'model', 'cost', 'promptTokens', 'completionTokens', 'generationID'],
  additionalProperties: false,
}

/** Shared contract between src/index.ts (server) and src/tui.tsx (CLI). */
export const CostContract = Rpc.define({
  id: 'openrouter-budget',
  methods: {
    summary: {
      input: {
        type: 'object',
        properties: {
          sessionID: { type: 'string', description: 'Session to report. Empty means no session.' },
        },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          session: {
            type: 'object',
            properties: {
              sessionID: { type: 'string' },
              startedAt: { type: 'number' },
              totalUSD: { type: 'number' },
              requests: { type: 'number' },
            },
            required: ['sessionID', 'startedAt', 'totalUSD', 'requests'],
            additionalProperties: false,
          },
          entries: { type: 'array', items: entrySchema },
          wallet: walletSchema,
        },
        required: ['session', 'entries', 'wallet'],
        additionalProperties: false,
      },
    },
    wallet: {
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object',
        properties: { wallet: walletSchema },
        required: ['wallet'],
        additionalProperties: false,
      },
    },
    refresh: {
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object',
        properties: { wallet: walletSchema },
        required: ['wallet'],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          totalUSD: { type: 'number' },
          lastModel: { type: ['string', 'null'] },
          lastCost: { type: ['number', 'null'] },
          requests: { type: 'number' },
        },
        required: ['sessionID', 'totalUSD', 'lastModel', 'lastCost', 'requests'],
        additionalProperties: false,
      },
    },
    'wallet.updated': {
      schema: {
        type: 'object',
        properties: { at: { type: 'number' } },
        required: ['at'],
        additionalProperties: false,
      },
    },
  },
})
