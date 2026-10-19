import { Rpc } from '@opencode/plugin/rpc'
import { Schema } from 'effect'

// Schemas are the single source of truth: the RPC contract validates against
// them and the exported types below are derived from them.
//
// Contract schemas are wrapped in Schema.toStandardSchemaV1: OpenCode's RPC
// accepts Standard Schema v1 (or JSON Schema) for portable contracts, and the
// facade preserves the full effect type so Rpc.Input/Output still resolve
// through Schema.Top instead of collapsing to unknown.

type DeepMutable<T> = T extends readonly (infer E)[]
  ? DeepMutable<E>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T

export const WalletSchema = Schema.Struct({
  at: Schema.Number,
  label: Schema.optional(Schema.String),
  keyUsage: Schema.optional(Schema.Number),
  keyLimit: Schema.optional(Schema.NullOr(Schema.Number)),
  keyLimitRemaining: Schema.optional(Schema.NullOr(Schema.Number)),
  keyLimitReset: Schema.optional(Schema.NullOr(Schema.String)),
  creditsTotal: Schema.optional(Schema.Number),
  creditsUsage: Schema.optional(Schema.Number),
  creditsRemaining: Schema.optional(Schema.Number),
  creditsUnavailable: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
})

export const CostEntrySchema = Schema.Struct({
  ts: Schema.Number,
  kind: Schema.String,
  model: Schema.NullOr(Schema.String),
  cost: Schema.NullOr(Schema.Number),
  promptTokens: Schema.NullOr(Schema.Number),
  completionTokens: Schema.NullOr(Schema.Number),
  generationID: Schema.NullOr(Schema.String),
})

export const SessionLedgerSchema = Schema.Struct({
  sessionID: Schema.String,
  startedAt: Schema.Number,
  totalUSD: Schema.Number,
  entries: Schema.Array(CostEntrySchema),
})

const SummaryInput = Schema.Struct({
  sessionID: Schema.optional(Schema.String),
})

const SummaryOutput = Schema.Struct({
  session: Schema.Struct({
    sessionID: Schema.String,
    startedAt: Schema.Number,
    totalUSD: Schema.Number,
    requests: Schema.Number,
  }),
  entries: Schema.Array(CostEntrySchema),
  wallet: Schema.NullOr(WalletSchema),
})

const WalletOutput = Schema.Struct({
  wallet: Schema.NullOr(WalletSchema),
})

const EmptyInput = Schema.Struct({})

const UpdatedEvent = Schema.Struct({
  sessionID: Schema.String,
  totalUSD: Schema.Number,
  lastModel: Schema.NullOr(Schema.String),
  lastCost: Schema.NullOr(Schema.Number),
  requests: Schema.Number,
})

const WalletUpdatedEvent = Schema.Struct({
  at: Schema.Number,
})

/** Shared contract between src/index.ts (server) and src/tui.tsx (CLI). */
export const CostContract = Rpc.define({
  id: 'openrouter-budget',
  methods: {
    summary: {
      input: Schema.toStandardSchemaV1(SummaryInput),
      output: Schema.toStandardSchemaV1(SummaryOutput),
    },
    wallet: {
      input: Schema.toStandardSchemaV1(EmptyInput),
      output: Schema.toStandardSchemaV1(WalletOutput),
    },
    refresh: {
      input: Schema.toStandardSchemaV1(EmptyInput),
      output: Schema.toStandardSchemaV1(WalletOutput),
    },
  },
  events: {
    updated: {
      schema: Schema.toStandardSchemaV1(UpdatedEvent),
    },
    'wallet.updated': {
      schema: Schema.toStandardSchemaV1(WalletUpdatedEvent),
    },
  },
})

export type Wallet = DeepMutable<typeof WalletSchema.Type>
export type WalletSnapshot = typeof WalletSchema.Type
export type CostEntry = DeepMutable<typeof CostEntrySchema.Type>
export type SessionLedger = DeepMutable<typeof SessionLedgerSchema.Type>
export type SummaryResult = typeof SummaryOutput.Type
export type UpdatedEvent = typeof UpdatedEvent.Type
