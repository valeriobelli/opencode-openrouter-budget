import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseResponseText, parseSSE } from '../src/parse.ts'

const sse = readFileSync(new URL('../fixtures/sse-sample.txt', import.meta.url), 'utf8')

// SSE transcript: usage arrives in the final data chunk
const captured = parseResponseText(sse, 'text/event-stream; charset=utf-8')

assert.ok(captured, 'expected usage to be captured from SSE')
assert.equal(captured.generationID, 'gen-01')
assert.equal(captured.model, 'anthropic/claude-sonnet-4.5')
assert.equal(captured.cost, 0.0042)
assert.equal(captured.promptTokens, 194)
assert.equal(captured.completionTokens, 2)
assert.equal(captured.cachedTokens, 100)
assert.equal(captured.reasoningTokens, 0)

// Plain JSON body (non-streaming)
const json = parseResponseText(
  JSON.stringify({
    id: 'gen-02',
    model: 'openai/gpt-5.2',
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.01 },
  }),
  'application/json',
)

assert.ok(json)
assert.equal(json.model, 'openai/gpt-5.2')
assert.equal(json.cost, 0.01)

// Usage without a cost field still yields tokens, cost stays null
const partial = parseSSE(
  'data: {"id":"gen-03","model":"x","usage":{"prompt_tokens":1,"completion_tokens":1}}',
)

assert.ok(partial)
assert.equal(partial.cost, null)
assert.equal(partial.promptTokens, 1)

// Chunks without usage are ignored
assert.equal(parseSSE('data: {"id":"x","choices":[]}\n\ndata: [DONE]\n'), null)

// Malformed lines never throw
assert.equal(parseSSE('data: {oops'), null)

// Empty input
assert.equal(parseResponseText('', 'text/event-stream'), null)

// BYOK: the upstream cost is a separate charge, reported next to OpenRouter's cost
const byok = parseSSE(
  'data: {"id":"gen-04","model":"openai/gpt-6.1","usage":{"prompt_tokens":33,"completion_tokens":5,"cost":0,"is_byok":true,"cost_details":{"upstream_inference_cost":0.000232}}}',
)

assert.ok(byok)
assert.equal(byok.cost, 0)
assert.equal(byok.byokCost, 0.000232)

// Non-BYOK: the upstream figure is already inside cost, so it is not an extra charge
const nonByok = parseSSE(
  'data: {"id":"gen-05","model":"x","usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0.01,"is_byok":false,"cost_details":{"upstream_inference_cost":0.009}}}',
)

assert.ok(nonByok)
assert.equal(nonByok.byokCost, 0)

// BYOK without an upstream figure is unknown, not zero
const byokNoCost = parseSSE(
  'data: {"id":"gen-06","model":"x","usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0,"is_byok":true}}',
)

assert.ok(byokNoCost)
assert.equal(byokNoCost.byokCost, null)

// Usage without is_byok (fixture above) is unknown, not zero
assert.equal(captured.byokCost, null)

console.log('parse tests passed')
