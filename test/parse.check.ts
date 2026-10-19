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

console.log('parse tests passed')
