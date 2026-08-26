import { McpClient, StdioTransport, HttpTransport, type Transport } from './client/index.js'
import { estimateTokens, countToolTokens, wireFormat } from './estimate.js'
import type { ServerSpec, ServerWeight, ToolDef, ToolWeight, XrayOptions } from './types.js'

function buildTransport(spec: ServerSpec): Transport {
  if (spec.kind === 'http') {
    return new HttpTransport({ url: spec.url!, headers: spec.headers })
  }
  return new StdioTransport({
    command: spec.command!,
    args: spec.args ?? [],
    env: spec.env,
    cwd: spec.cwd,
  })
}

function weighTool(tool: ToolDef): ToolWeight {
  const whole = JSON.stringify(wireFormat(tool))
  const description = tool.description ?? ''
  const schema = JSON.stringify(tool.inputSchema ?? {})
  return {
    name: tool.name ?? '(unnamed)',
    tokens: estimateTokens(whole),
    descriptionTokens: estimateTokens(description),
    schemaTokens: estimateTokens(schema),
  }
}

const failed = (spec: ServerSpec, error: string): ServerWeight => ({
  spec,
  ok: false,
  error,
  tools: [],
  toolCount: 0,
  resourceCount: 0,
  promptCount: 0,
  toolTokens: 0,
  instructionTokens: 0,
  taxTokens: 0,
  method: 'estimate',
})

/** Connect to one server and measure what it adds to every request. */
export async function weighServer(spec: ServerSpec, options: XrayOptions): Promise<ServerWeight> {
  if (spec.unlaunchable) return failed(spec, `not launched: ${spec.unlaunchable}`)

  const transport = buildTransport(spec)
  const client = new McpClient(transport, options.timeoutMs)

  try {
    await client.start()
  } catch (e) {
    return failed(spec, (e as Error).message)
  }

  let handshake
  const t0 = Date.now()
  try {
    handshake = await client.initialize()
  } catch (e) {
    await client.close()
    const stderrTail = transport.stderr.slice(-3).join(' | ')
    return failed(spec, `${(e as Error).message}${stderrTail ? ` -- stderr: ${stderrTail}` : ''}`)
  }
  const connectMs = Date.now() - t0

  if (handshake.raw.error) {
    await client.close()
    return failed(spec, `initialize failed: ${handshake.raw.error.code} ${handshake.raw.error.message}`)
  }
  client.notifyInitialized()

  const { tools } = await client.listTools().catch(() => ({ tools: [] as ToolDef[] }))
  const resources = await client.listAll('resources/list', 'resources').then((r) => r.items).catch(() => [])
  const prompts = await client.listAll('prompts/list', 'prompts').then((r) => r.items).catch(() => [])

  const instructions =
    typeof (handshake.raw.result as Record<string, unknown> | undefined)?.['instructions'] === 'string'
      ? ((handshake.raw.result as Record<string, unknown>)['instructions'] as string)
      : ''

  const toolWeights = tools.map(weighTool).sort((a, b) => b.tokens - a.tokens)
  let toolTokens = toolWeights.reduce((sum, t) => sum + t.tokens, 0)
  let method: ServerWeight['method'] = 'estimate'

  // Ground truth when asked for and possible. The per-tool split stays an
  // estimate (the API prices the whole array), but the headline number -- the
  // per-request tax -- becomes exact, scaled through the individual tools so
  // the split still adds up.
  if (options.precise && options.apiKey && tools.length > 0) {
    try {
      const counted = await countToolTokens(options.apiKey, tools)
      if (counted > 0 && toolTokens > 0) {
        const scale = counted / toolTokens
        for (const t of toolWeights) t.tokens = Math.round(t.tokens * scale)
        toolTokens = counted
        method = 'counted'
      }
    } catch {
      // The estimate still stands; precision is an upgrade, not a requirement.
    }
  }

  const instructionTokens = estimateTokens(instructions)

  await client.close()
  return {
    spec,
    ok: true,
    connectMs,
    serverInfo: handshake.serverInfo,
    protocolVersion: handshake.protocolVersion,
    tools: toolWeights,
    toolCount: tools.length,
    resourceCount: resources.length,
    promptCount: prompts.length,
    toolTokens,
    instructionTokens,
    taxTokens: toolTokens + instructionTokens,
    method,
  }
}

/** Weigh every server with bounded concurrency, preserving input order. */
export async function weighAll(specs: ServerSpec[], options: XrayOptions): Promise<ServerWeight[]> {
  const results: ServerWeight[] = new Array(specs.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency, specs.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= specs.length) return
      results[i] = await weighServer(specs[i]!, options)
    }
  })
  await Promise.all(workers)
  return results
}
