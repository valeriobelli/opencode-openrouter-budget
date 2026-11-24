import assert from 'node:assert/strict'
import plugin from '../src/index.ts'
import type { SummaryResult, UpdatedEvent } from '../src/rpc.ts'

// Never reach the network or use a real key from a test.
delete process.env.OPENROUTER_API_KEY
globalThis.fetch = () => Promise.reject(new Error('no network in tests'))

type SetupArg = Parameters<typeof plugin.setup>[0]
type SummaryMethod = (input: { sessionID: string }) => Promise<SummaryResult>
type ResponseEvent = { sessionID: string; kind: string; response: Response }

const sessionID = 'ses_ledger'

// A ledger saved before BYOK tracking: no byokUSD / unknownBYOK, no byokCost on its entry.
const legacy = {
  sessionID,
  startedAt: 1,
  totalUSD: 0.5,
  entries: [
    {
      ts: 1,
      kind: 'primary',
      model: 'a/b',
      cost: 0.5,
      promptTokens: 1,
      completionTokens: 1,
      generationID: 'gen-0',
    },
  ],
}

const store = new Map<string, unknown>([[`spend/${sessionID}`, legacy]])
const waiting: Array<(event: UpdatedEvent) => void> = []
let readSummary: SummaryMethod | undefined

let onResponse: (event: ResponseEvent) => void = () => {}

const fakeCtx = {
  rpc: {
    register: async (_contract: unknown, implementation: { summary: SummaryMethod }) => {
      readSummary = implementation.summary

      return {
        events: {
          emit: async (name: string, data: UpdatedEvent) => {
            if (name === 'updated') {
              waiting.shift()?.(data)
            }
          },
        },
      }
    },
  },
  storage: {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value)
    },
  },
  integration: { connection: { active: async () => undefined, resolve: async () => undefined } },
  session: {
    hook: async (_name: string, handler: (event: ResponseEvent) => void) => {
      onResponse = handler
    },
  },
}

// Partial test stub for OpenCode's Context; setup only reads the four fields above.
const cleanup = await plugin.setup(fakeCtx as unknown as SetupArg)

const summary = () => {
  assert.ok(readSummary, 'expected summary RPC to be registered')

  return readSummary({ sessionID })
}

async function capture(usage: Record<string, unknown>): Promise<UpdatedEvent> {
  const updated = new Promise<UpdatedEvent>((resolve) => waiting.push(resolve))
  const body = `data: ${JSON.stringify({ id: 'gen-x', model: 'openai/m', usage })}\n\ndata: [DONE]\n\n`

  onResponse({
    sessionID,
    kind: 'primary',
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  })

  return updated
}

// A legacy ledger reports its old entries as unknown BYOK, never as a zero.
const before = (await summary()).session

assert.equal(before.totalUSD, 0.5)
assert.equal(before.byokUSD, 0)
assert.equal(before.unknownBYOK, 1)

// BYOK request: OpenRouter's cost stays 0, the upstream cost is added separately.
const byok = await capture({
  cost: 0,
  is_byok: true,
  cost_details: { upstream_inference_cost: 0.25 },
})

assert.equal(byok.totalUSD, 0.5)
assert.equal(byok.byokUSD, 0.25)
assert.equal(byok.unknownBYOK, 1)
assert.equal(byok.lastByokCost, 0.25)

// Non-BYOK request: its upstream figure is already inside cost, so BYOK stays put.
const plain = await capture({
  cost: 0.01,
  is_byok: false,
  cost_details: { upstream_inference_cost: 0.009 },
})

assert.equal(plain.totalUSD, 0.51)
assert.equal(plain.byokUSD, 0.25)
assert.equal(plain.unknownBYOK, 1)
assert.equal(plain.lastByokCost, 0)

// No is_byok in the usage: unknown, counted separately.
const unknown = await capture({ cost: 0.01 })

assert.equal(unknown.unknownBYOK, 2)
assert.equal(unknown.lastByokCost, null)

// The stored ledger carries the totals, so a restart reads the same numbers.
const after = (await summary()).session

assert.equal(after.byokUSD, 0.25)
assert.equal(after.unknownBYOK, 2)
assert.equal(after.requests, 4)

if (typeof cleanup === 'function') {
  await cleanup()
}

console.log('ledger tests passed')
