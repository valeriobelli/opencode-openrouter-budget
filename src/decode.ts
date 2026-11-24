import { Schema } from 'effect'

// Decoders for OpenRouter wallet endpoints. Decoding is lenient by design:
// unknown fields are ignored (the responses carry plenty we do not model) and
// every field is optional, so shape drift degrades to "missing data" instead
// of a hard failure. A response that does not match at all decodes to null
// and the caller falls back.

const KeyInfoResponse = Schema.Struct({
  data: Schema.Struct({
    label: Schema.optional(Schema.String),
    usage: Schema.optional(Schema.Number),
    limit: Schema.optional(Schema.NullOr(Schema.Number)),
    limit_remaining: Schema.optional(Schema.NullOr(Schema.Number)),
    limit_reset: Schema.optional(Schema.NullOr(Schema.String)),
    // Does BYOK spend count toward this key's own credit limit?
    include_byok_in_limit: Schema.optional(Schema.Boolean),
    // The budget that blocks requests first; has its own BYOK setting.
    effective_budget: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          scope: Schema.optional(Schema.String),
          include_byok: Schema.optional(Schema.Boolean),
          limit_usd: Schema.optional(Schema.Number),
          remaining_usd: Schema.optional(Schema.Number),
        }),
      ),
    ),
  }),
})

const LegacyAuthKeyResponse = Schema.Struct({
  data: Schema.Struct({
    label: Schema.optional(Schema.String),
    usage: Schema.optional(Schema.Number),
    limit: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
})

const CreditsResponse = Schema.Struct({
  data: Schema.Struct({
    total_credits: Schema.optional(Schema.Number),
    total_usage: Schema.optional(Schema.Number),
  }),
})

export const CredentialKey = Schema.NonEmptyString

export const Credential = Schema.Struct({
  key: CredentialKey,
})

export type KeyInfo = typeof KeyInfoResponse.Type
export type LegacyAuthKey = typeof LegacyAuthKeyResponse.Type
export type Credits = typeof CreditsResponse.Type

export function decodeKeyInfo(value: unknown): KeyInfo | null {
  try {
    return Schema.decodeUnknownSync(KeyInfoResponse)(value)
  } catch {
    return null
  }
}

export function decodeLegacyAuthKey(value: unknown): LegacyAuthKey | null {
  try {
    return Schema.decodeUnknownSync(LegacyAuthKeyResponse)(value)
  } catch {
    return null
  }
}

export function decodeCredits(value: unknown): Credits | null {
  try {
    return Schema.decodeUnknownSync(CreditsResponse)(value)
  } catch {
    return null
  }
}
