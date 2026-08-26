#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { discover } from './discover.js'
import { weighAll } from './weigh.js'
import { renderTerminal } from './report/terminal.js'
import type { ServerSpec, XrayOptions, XrayReport } from './types.js'

const VERSION = '0.1.0'

const HELP = `
  context-xray ${VERSION}
  See what your MCP servers cost you: the context-window tokens they add to
  every single request, before you type a word.

  USAGE
    context-xray                        find and weigh every configured server
    context-xray --config <file>        weigh the servers in one config file
    context-xray --server <name>        only the named server(s); repeatable
    context-xray -- <command> [...]     weigh one stdio server directly
    context-xray --url <url>            weigh one streamable-HTTP server

  OUTPUT
    --json                  machine-readable report on stdout
    --top <n>               tools to list per server (default 3)

  MEASUREMENT
    --precise               use the free Anthropic count_tokens API for exact
                            numbers (needs ANTHROPIC_API_KEY; nothing is sent
                            anywhere except the tool definitions being counted)
    --timeout <ms>          per-server timeout (default 15000)
    --concurrency <n>       servers weighed at once (default 4)

  COST PROJECTION
    --requests-per-day <n>  assumed request volume (default 200)
    --price <usd>           $ per million input tokens (default 3.00)

  Configs searched: Claude Desktop, Claude Code (~/.claude.json and ./.mcp.json),
  Cursor, Windsurf, VS Code. Servers appearing in several hosts are measured once.

  context-xray never calls your tools. It connects, reads the tool list, and
  disconnects. Environment values from your configs are passed to the servers
  they belong to and are never printed.
`

interface Parsed {
  options: XrayOptions
  json: boolean
  top: number
  config?: string
  serverFilter: string[]
  direct?: ServerSpec
  help: boolean
  version: boolean
  error?: string
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = {
    options: {
      timeoutMs: 15_000,
      precise: false,
      apiKey: process.env['ANTHROPIC_API_KEY'],
      requestsPerDay: 200,
      pricePerMTok: 3,
      top: 3,
      concurrency: 4,
    },
    json: false,
    top: 3,
    serverFilter: [],
    help: false,
    version: false,
  }
  let url: string | null = null
  let headers: Record<string, string> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') {
      const rest = argv.slice(i + 1)
      if (rest.length === 0) return { ...out, error: '`--` must be followed by the server command' }
      out.direct = { name: rest.join(' '), kind: 'stdio', command: rest[0]!, args: rest.slice(1), sources: ['command line'] }
      break
    }
    const next = () => argv[++i]
    const num = (flag: string) => {
      const v = Number(next())
      if (!Number.isFinite(v) || v <= 0) {
        out.error = `${flag} needs a positive number`
        return null
      }
      return v
    }

    switch (arg) {
      case '-h':
      case '--help':
        out.help = true
        break
      case '-v':
      case '--version':
        out.version = true
        break
      case '--json':
        out.json = true
        break
      case '--precise':
        out.options.precise = true
        break
      case '--config':
        out.config = next()
        break
      case '--server':
        out.serverFilter.push(...(next() ?? '').split(',').filter(Boolean))
        break
      case '--url':
        url = next() ?? null
        break
      case '--header': {
        const raw = next() ?? ''
        const idx = raw.indexOf(':')
        if (idx < 1) return { ...out, error: `--header expects "Name: value", got "${raw}"` }
        headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim()
        break
      }
      case '--top': {
        const v = num('--top')
        if (v === null) return out
        out.top = Math.floor(v)
        break
      }
      case '--timeout': {
        const v = num('--timeout')
        if (v === null) return out
        out.options.timeoutMs = v
        break
      }
      case '--concurrency': {
        const v = num('--concurrency')
        if (v === null) return out
        out.options.concurrency = Math.floor(v)
        break
      }
      case '--requests-per-day': {
        const v = num('--requests-per-day')
        if (v === null) return out
        out.options.requestsPerDay = v
        break
      }
      case '--price': {
        const v = num('--price')
        if (v === null) return out
        out.options.pricePerMTok = v
        break
      }
      default:
        return { ...out, error: `Unknown option "${arg}". Try --help.` }
    }
  }

  if (url) {
    out.direct = { name: url, kind: 'http', url, headers, sources: ['command line'] }
  }
  if (out.options.precise && !out.options.apiKey) {
    return { ...out, error: '--precise needs ANTHROPIC_API_KEY in the environment' }
  }
  return out
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))

  if (parsed.help) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (parsed.version) {
    process.stdout.write(VERSION + '\n')
    process.exit(0)
  }
  if (parsed.error) {
    process.stderr.write(`context-xray: ${parsed.error}\n`)
    process.exit(2)
  }

  let specs: ServerSpec[]
  let configsSearched: string[]

  if (parsed.direct) {
    specs = [parsed.direct]
    configsSearched = []
  } else {
    if (parsed.config && !existsSync(parsed.config)) {
      process.stderr.write(`context-xray: no such config file: ${parsed.config}\n`)
      process.exit(2)
    }
    const found = discover(parsed.config)
    specs = found.specs
    configsSearched = found.configsSearched

    if (parsed.serverFilter.length > 0) {
      specs = specs.filter((s) => parsed.serverFilter.includes(s.name))
      const missing = parsed.serverFilter.filter((f) => !specs.some((s) => s.name === f))
      if (missing.length > 0) {
        process.stderr.write(`context-xray: no server named ${missing.map((m) => `"${m}"`).join(', ')} in the discovered configs\n`)
        process.exit(2)
      }
    }
  }

  if (specs.length === 0) {
    process.stderr.write(
      configsSearched.length === 0
        ? 'context-xray: no MCP config files found. Point it at one with --config <file>, or at a server with `context-xray -- <command>`.\n'
        : `context-xray: searched ${configsSearched.length} config file(s) but found no MCP servers in them.\n`,
    )
    process.exit(2)
  }

  const t0 = Date.now()
  const servers = await weighAll(specs, parsed.options)

  const measured = servers.filter((s) => s.ok)
  const methods = new Set(measured.map((s) => s.method))
  const report: XrayReport = {
    servers,
    totalTaxTokens: measured.reduce((sum, s) => sum + s.taxTokens, 0),
    method: methods.size === 1 ? (methods.has('counted') ? 'counted' : 'estimate') : methods.size === 0 ? 'estimate' : 'mixed',
    options: { requestsPerDay: parsed.options.requestsPerDay, pricePerMTok: parsed.options.pricePerMTok },
    configsSearched,
    durationMs: Date.now() - t0,
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(renderTerminal(report, parsed.top))
  }
  // 0 when everything asked for was measured; 1 when some servers failed.
  process.exit(measured.length === servers.length ? 0 : 1)
}

main().catch((e: unknown) => {
  process.stderr.write(`context-xray: internal error: ${(e as Error).stack ?? String(e)}\n`)
  process.exit(2)
})
