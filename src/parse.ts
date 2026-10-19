/**
 * Pure extraction of OpenRouter usage data from a completed response body.
 * Deliberately import-free so it can run in plain Bun for tests.
 */

export interface CapturedUsage {
  generationID: string | null
  model: string | null
  cost: number | null
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

function extract(chunk: unknown): CapturedUsage | null {
  if (!chunk || typeof chunk !== 'object') {
    return null
  }

  const record = chunk as Record<string, unknown>
  const usage = record.usage

  if (!usage || typeof usage !== 'object') {
    return null
  }

  const usageRecord = usage as Record<string, unknown>
  const promptDetails = (usageRecord.prompt_tokens_details ?? {}) as Record<string, unknown>
  const completionDetails = (usageRecord.completion_tokens_details ?? {}) as Record<string, unknown>

  return {
    generationID: stringOr(record.id),
    model: stringOr(record.model),
    cost: numberOr(usageRecord.cost),
    promptTokens: numberOr(usageRecord.prompt_tokens),
    completionTokens: numberOr(usageRecord.completion_tokens),
    cachedTokens: numberOr(promptDetails.cached_tokens),
    reasoningTokens: numberOr(completionDetails.reasoning_tokens),
  }
}

/** Parse an SSE transcript ("data: {...}" lines); return the last chunk carrying usage. */
export function parseSSE(text: string): CapturedUsage | null {
  let result: CapturedUsage | null = null

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd()

    if (!line.startsWith('data:')) {
      continue
    }

    const payload = line.slice(5).trim()

    if (!payload || payload === '[DONE]') {
      continue
    }

    try {
      const captured = extract(JSON.parse(payload))

      if (captured) {
        result = captured
      }
    } catch {
      // Malformed line — never throw.
    }
  }

  return result
}

/** Parse a completed response body: SSE stream transcript or plain JSON. */
export function parseResponseText(text: string, contentType: string): CapturedUsage | null {
  if (contentType.includes('text/event-stream')) {
    return parseSSE(text)
  }

  const trimmed = text.trim()

  if (trimmed.startsWith('{')) {
    try {
      return extract(JSON.parse(trimmed))
    } catch {
      return null
    }
  }

  return parseSSE(text)
}
