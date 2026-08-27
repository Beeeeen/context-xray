#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { discover } from './discover.js'
import { discoverStatics, staticTotal } from './statics.js'
import { diffReports, renderDiff } from './diff.js'
import { weighAll } from './weigh.js'
import { renderTerminal } from './report/terminal.js'
import type { ServerSpec, XrayOptions, XrayReport } from './types.js'

const VERSION = '0.2.0'

const HELP = `
  context-xray ${VERSION}
  See what your agent setup costs you: the context-window tokens your MCP
  servers and instruction files add to every request, before you type a word.

  USAGE
    context-xray                        find and weigh everything configured
    context-xray --config <file>        weigh the servers in one config file
    context-xray --server <name>        only the named server(s); repeatable
    context-xray -- <command> [...]     weigh one stdio server directly
    context-xray --url <url>            weigh one streamable-HTTP server

  OUTPUT
    --json                  machine-readable report on stdout
    --save <file>           also write the JSON report to a file
    --top <n>               tools to list per server (default 3)
    --no-static             skip CLAUDE.md / rules / skills weighing

  CI
    --budget <tokens>       exit 3 when the per-request total exceeds this
    --diff <file>           compare against a saved --json/--save report

  MEASUREMENT
    --precise               use the free Anthropic count_tokens API for exact
                            numbers (needs ANTHROPIC_API_KEY; nothing is sent
                            anywhere except the tool definitions being counted)
    --timeout <ms>          per-server timeout (default 15000)
    --concurrency <n>       servers weighed at once (default 4)

  COST PROJECTION
    --requests-per-day <n>  assumed request volume (default 200)
    --price <usd>           $ per million input tokens (default 3.00)

  EXIT CODES
    0 all measured   1 some servers failed   2 usage error   3 over budget

  Configs searched: Claude Desktop, Claude Code, Cursor, Windsurf, VS Code,
  Zed, Cline, Roo Code, Gemini CLI, Codex CLI. Servers appearing in several
  hosts are measured once. Instruction files weighed: CLAUDE.md, AGENTS.md,
  GEMINI.md, .cursorrules, .cursor/rules, .windsurfrules,
  copilot-instructions.md, and the Claude Code skills listing.

  context-xray never calls your tools. It connects, reads the tool list, and
  disconnects. Environment values from your configs are passed to the servers
  they belong to and are never printed. Instruction files are read locally and
  only their token weight is reported.
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
  budget?: number
  diffAgainst?: string
  saveTo?: string
  noStatic: boolean
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
    noStatic: false,
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
      case '--no-static':
        out.noStatic = true
        break
      case '--precise':
        out.options.precise = true
        break
      case '--diff':
        out.diffAgainst = next()
        if (!out.diffAgainst) return { ...out, error: '--diff needs the path of a saved --json report' }
        break
      case '--save':
        out.saveTo = next()
        if (!out.saveTo) return { ...out, error: '--save needs a file path' }
        break
      case '--budget': {
        const v = num('--budget')
        if (v === null) return out
        out.budget = Math.floor(v)
        break
      }
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

  // Instruction files only belong to the machine-wide audit; pointing the
  // tool at one server or one config is a question about that server alone.
  const staticFiles =
    parsed.direct || parsed.config || parsed.noStatic ? [] : discoverStatics()
  const staticTokens = staticTotal(staticFiles)

  const measured = servers.filter((s) => s.ok)
  const methods = new Set(measured.map((s) => s.method))
  const totalTaxTokens = measured.reduce((sum, s) => sum + s.taxTokens, 0)
  const report: XrayReport = {
    servers,
    totalTaxTokens,
    staticFiles,
    staticTokens,
    grandTotalTokens: totalTaxTokens + staticTokens,
    method: methods.size === 1 ? (methods.has('counted') ? 'counted' : 'estimate') : methods.size === 0 ? 'estimate' : 'mixed',
    options: { requestsPerDay: parsed.options.requestsPerDay, pricePerMTok: parsed.options.pricePerMTok },
    configsSearched,
    durationMs: Date.now() - t0,
    xrayVersion: VERSION,
  }

  if (parsed.saveTo) {
    writeFileSync(parsed.saveTo, JSON.stringify(report, null, 2) + '\n')
  }

  if (parsed.diffAgainst) {
    let baseline: XrayReport
    try {
      baseline = JSON.parse(readFileSync(parsed.diffAgainst, 'utf8')) as XrayReport
      if (!Array.isArray(baseline.servers) || typeof baseline.totalTaxTokens !== 'number') {
        throw new Error('not a context-xray report')
      }
    } catch (e) {
      process.stderr.write(`context-xray: cannot read baseline ${parsed.diffAgainst}: ${(e as Error).message}\n`)
      process.exit(2)
    }
    const diff = diffReports(baseline, report)
    process.stdout.write(parsed.json ? JSON.stringify(diff, null, 2) + '\n' : renderDiff(diff))
  } else if (parsed.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(renderTerminal(report, parsed.top))
  }

  // 0 all measured; 1 some servers failed; 3 over budget (the CI signal wins).
  if (parsed.budget !== undefined && report.grandTotalTokens > parsed.budget) {
    process.stderr.write(
      `context-xray: over budget -- ${report.grandTotalTokens.toLocaleString('en-US')} tokens per request against a budget of ${parsed.budget.toLocaleString('en-US')}\n`,
    )
    process.exit(3)
  }
  process.exit(measured.length === servers.length ? 0 : 1)
}

main().catch((e: unknown) => {
  process.stderr.write(`context-xray: internal error: ${(e as Error).stack ?? String(e)}\n`)
  process.exit(2)
})
