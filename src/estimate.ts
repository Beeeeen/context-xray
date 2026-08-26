import type { ToolDef } from './types.js'

/**
 * Serialise a tool the way hosts actually send it to the model. The wire
 * field is `input_schema`; measuring the camelCase MCP field would count the
 * wrong bytes.
 */
export function wireFormat(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? { type: 'object' },
  }
}

/**
 * Keyless token estimate. Modern tokenizers average a little under 4
 * characters per token on English prose but much less on JSON, which is dense
 * in punctuation and braces that tokenize one-per-character. Weighting the two
 * classes separately keeps the estimate honest across schema-heavy payloads
 * without shipping a tokenizer.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let structural = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // Punctuation and symbols: {}[]":,  etc. tokenize far denser than prose.
    if (
      (c >= 0x21 && c <= 0x2f) ||
      (c >= 0x3a && c <= 0x40) ||
      (c >= 0x5b && c <= 0x60) ||
      (c >= 0x7b && c <= 0x7e)
    ) {
      structural++
    }
  }
  const prose = text.length - structural
  return Math.max(1, Math.round(prose / 4.2 + structural / 1.8))
}

const API_URL = 'https://api.anthropic.com/v1/messages/count_tokens'
const COUNT_MODEL = 'claude-sonnet-5'

async function countTokensCall(apiKey: string, tools: Array<Record<string, unknown>>): Promise<number> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: COUNT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      ...(tools.length > 0 ? { tools } : {}),
    }),
  })
  if (!res.ok) {
    throw new Error(`count_tokens returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const body = (await res.json()) as { input_tokens?: number }
  if (typeof body.input_tokens !== 'number') throw new Error('count_tokens response had no input_tokens')
  return body.input_tokens
}

/**
 * Ground-truth measurement: ask the Anthropic token counter what the request
 * costs with the tools attached, subtract what it costs without them. The
 * counting endpoint is free of charge, so --precise costs nothing to run.
 */
export async function countToolTokens(apiKey: string, tools: ToolDef[]): Promise<number> {
  const [withTools, baseline] = await Promise.all([
    countTokensCall(apiKey, tools.map(wireFormat)),
    countTokensCall(apiKey, []),
  ])
  return Math.max(0, withTools - baseline)
}
