import assert from 'node:assert/strict'
import { decodeCredits, decodeKeyInfo, decodeLegacyAuthKey } from '../src/decode.ts'

// Real response shape captured from GET /api/v1/key (extra fields like
// is_management_key, budgets, and usage_daily are ignored by the decoder).
const keyInfo = decodeKeyInfo({
  data: {
    label: 'sk-or-v1-813...482',
    is_management_key: false,
    is_provisioning_key: false,
    limit: 100,
    limit_reset: 'weekly',
    limit_remaining: 70.559155531,
    include_byok_in_limit: false,
    budgets: [{ scope: 'workspace_default_member', limit_usd: 5000, spend_usd: 448.789 }],
    usage: 332.585486083,
    usage_daily: 12.1,
    usage_weekly: 29.44,
    usage_monthly: 101.3,
    byok_usage: 0,
    is_free_tier: false,
  },
})

assert.ok(keyInfo, 'expected /api/v1/key response to decode')
assert.equal(keyInfo.data.label, 'sk-or-v1-813...482')
assert.equal(keyInfo.data.limit, 100)
assert.equal(keyInfo.data.limit_remaining, 70.559155531)
assert.equal(keyInfo.data.limit_reset, 'weekly')
assert.equal(keyInfo.data.usage, 332.585486083)
assert.equal('is_management_key' in keyInfo.data, false, 'unmodeled fields must be dropped')

// Unlimited key: limit and limit_remaining come back as null
const unlimited = decodeKeyInfo({ data: { label: 'k', limit: null, limit_remaining: null } })

assert.ok(unlimited)
assert.equal(unlimited.data.limit, null)
assert.equal(unlimited.data.limit_remaining, null)

// Legacy /api/v1/auth/key fallback shape
const legacy = decodeLegacyAuthKey({ data: { label: 'legacy', usage: 3.5, limit: 10 } })

assert.ok(legacy)
assert.equal(legacy.data.usage, 3.5)

// GET /api/v1/credits
const credits = decodeCredits({ data: { total_credits: 1010, total_usage: 614.696495934 } })

assert.ok(credits)
assert.equal(credits.data.total_credits, 1010)
assert.equal(credits.data.total_usage, 614.696495934)

// Malformed payloads decode to null instead of throwing
assert.equal(decodeKeyInfo({ data: { usage: 'not-a-number' } }), null)
assert.equal(decodeKeyInfo('nope'), null)
assert.equal(decodeCredits({ data: null }), null)
assert.equal(decodeKeyInfo(null), null)

console.log('decode tests passed')
