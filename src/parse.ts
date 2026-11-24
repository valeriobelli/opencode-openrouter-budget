/**
 * Pure extraction of OpenRouter usage data from a completed response body.
 * Deliberately import-free so it can run in plain Bun for tests.
 */

export interface CapturedUsage {
  generationID: string | null
  model: string | null
  cost: number | null
  /** What the upstream provider charged on the user's own key; null when unknown. */
  byokCost: number | null
  promptTokens: number | null
  completionTokens: number | null
  cachedTokens: number | null
  reasoningTokens: number | null
}

function numberOr(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

interface TokenCounts {
  prompt: number | null
  completion: number | null
  cached: number | null
  reasoning: number | null
}

function tokenCounts(usageRecord: Record<string, unknown>): TokenCounts {
  const promptDetails = (usageRecord.prompt_tokens_details ?? {}) as Record<string, unknown>
  const completionDetails = (usageRecord.completion_tokens_details ?? {}) as Record<string, unknown>

  return {
    prompt: numberOr(usageRecord.prompt_tokens),
    completion: numberOr(usageRecord.completion_tokens),
    cached: numberOr(promptDetails.cached_tokens),
    reasoning: numberOr(completionDetails.reasoning_tokens),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// OpenRouter reports upstream_inference_cost on non-BYOK requests too, where it is already
// inside `cost`; only an explicit is_byok decides whether it is a separate charge.
function byokCostOf(usageRecord: Record<string, unknown>): number | null {
  if (usageRecord.is_byok === false) {
    return 0
  }

  if (usageRecord.is_byok !== true) {
    return null
  }

  const details = isRecord(usageRecord.cost_details) ? usageRecord.cost_details : {}

  return numberOr(details.upstream_inference_cost)
}

function extract(chunk: unknown): CapturedUsage | null {
  if (!isRecord(chunk)) {
    return null
  }

  const usage = chunk.usage

  if (!isRecord(usage)) {
    return null
  }

  const tokens = tokenCounts(usage)

  return {
    generationID: stringOr(chunk.id),
    model: stringOr(chunk.model),
    cost: numberOr(usage.cost),
    byokCost: byokCostOf(usage),
    promptTokens: tokens.prompt,
    completionTokens: tokens.completion,
    cachedTokens: tokens.cached,
    reasoningTokens: tokens.reasoning,
  }
}

const extractText = (text: string): CapturedUsage | null => {
  try {
    return extract(JSON.parse(text))
  } catch {
    return null
  }
}

function usageChunk(line: string): CapturedUsage | null {
  if (!line.startsWith('data:')) {
    return null
  }

  const payload = line.slice(5).trim()

  if (!payload || payload === '[DONE]') {
    return null
  }

  return extractText(payload)
}

/** Parse an SSE transcript ("data: {...}" lines); return the last chunk carrying usage. */
export function parseSSE(text: string): CapturedUsage | null {
  return text
    .split('\n')
    .reduce((acc, rawLine) => usageChunk(rawLine.trimEnd()) ?? acc, null as CapturedUsage | null)
}

/** Parse a completed response body: SSE stream transcript or plain JSON. */
export function parseResponseText(text: string, contentType: string): CapturedUsage | null {
  if (contentType.includes('text/event-stream')) {
    return parseSSE(text)
  }

  const trimmed = text.trim()

  if (trimmed.startsWith('{')) {
    return extractText(trimmed)
  }

  return parseSSE(text)
}
