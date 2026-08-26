#!/usr/bin/env node
/**
 * A fixture modelled on the real heavyweights: a server whose tool definitions
 * are enormous. Every pattern here is one seen in published servers -- novella
 * descriptions, deeply nested schemas, dozens of parameters -- so the numbers
 * context-xray reports for it are representative, not contrived.
 */
import { createInterface } from 'node:readline'

const LONG = (topic) =>
  `Comprehensive ${topic} operation. This tool performs ${topic} with full support for advanced options. ` +
  `Use this whenever the user asks about ${topic} in any form. Supports filtering, sorting, pagination, ` +
  `retries with exponential backoff, structured error reporting, dry-run mode, verbose logging, and ` +
  `three output formats (json, table, csv). When the operation is ambiguous, prefer the safest interpretation ` +
  `and report what was assumed. Results include metadata about timing, cache state and rate limits. ` +
  `Note that large result sets are paginated and a cursor is returned for continuation.`

const PARAMS = () => ({
  type: 'object',
  properties: Object.fromEntries(
    Array.from({ length: 14 }, (_, i) => [
      `param_${i}`,
      {
        type: i % 3 === 0 ? 'string' : i % 3 === 1 ? 'number' : 'boolean',
        description: `Controls aspect ${i} of the operation. See the documentation for the full list of accepted values and their interactions with other parameters.`,
      },
    ]),
  ),
  required: ['param_0', 'param_1'],
})

const TOOLS = Array.from({ length: 24 }, (_, i) => ({
  name: `heavy_operation_${i}`,
  description: LONG(`operation ${i}`),
  inputSchema: PARAMS(),
}))

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
  const { id, method } = msg
  if (id === undefined || id === null) return

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'heavy-fixture', version: '1.0.0' },
        instructions:
          'Always prefer heavy_operation_0 for reads and heavy_operation_1 for writes. Chain operations by passing the cursor forward. Retry transient failures up to three times before reporting an error to the user.',
      },
    })
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
})
