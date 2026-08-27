import type { ServerWeight, XrayReport } from '../types.js'

const useColor =
  !process.env['NO_COLOR'] && (process.env['FORCE_COLOR'] === '1' || process.stdout.isTTY === true)

const c = {
  reset: useColor ? '\x1b[0m' : '',
  dim: useColor ? '\x1b[2m' : '',
  bold: useColor ? '\x1b[1m' : '',
  red: useColor ? '\x1b[31m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  gray: useColor ? '\x1b[90m' : '',
}

const CONTEXT_WINDOW = 200_000

const fmt = (n: number) => n.toLocaleString('en-US')

/** Visible width, so ANSI codes do not break the column maths. */
function width(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

function pad(s: string, to: number): string {
  const w = width(s)
  return w >= to ? s : s + ' '.repeat(to - w)
}

function padLeft(s: string, to: number): string {
  const w = width(s)
  return w >= to ? s : ' '.repeat(to - w) + s
}

function bar(fraction: number, widthChars = 18): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * widthChars)
  return '#'.repeat(filled) + '.'.repeat(widthChars - filled)
}

/** "Claude Desktop, Cursor" -- host names only, config paths live in detail. */
function hostsOf(w: ServerWeight): string {
  const hosts = new Set(w.spec.sources.map((s) => s.split(' (')[0] ?? s))
  return [...hosts].join(', ')
}

function tokensLabel(w: ServerWeight): string {
  return `${w.method === 'counted' ? '' : '~'}${fmt(w.taxTokens)}`
}

export function renderTerminal(report: XrayReport, top = 3): string {
  const lines: string[] = []
  const measured = report.servers.filter((s) => s.ok)
  const broken = report.servers.filter((s) => !s.ok)
  const ranked = [...measured].sort((a, b) => b.taxTokens - a.taxTokens)
  const total = report.totalTaxTokens
  const statics = report.staticFiles ?? []
  const staticTokens = report.staticTokens ?? 0
  const grand = report.grandTotalTokens ?? total + staticTokens
  const approx = report.method === 'counted' ? '' : '~'

  lines.push('')
  lines.push(
    `  ${c.bold}context-xray${c.reset}  your ${staticTokens > 0 ? 'agent setup adds' : 'MCP servers add'} ${c.bold}${approx}${fmt(grand)} tokens${c.reset} to every request`,
  )
  const cfgs = report.configsSearched.length
  lines.push(
    `  ${c.gray}${cfgs} config${cfgs === 1 ? '' : 's'} searched, ${report.servers.length} server${report.servers.length === 1 ? '' : 's'} found, ${measured.length} measured${broken.length ? `, ${broken.length} failed` : ''}${c.reset}`,
  )
  lines.push('')

  if (ranked.length > 0) {
    lines.push(
      `  ${c.gray}${pad('rank', 6)}${pad('server', 22)}${pad('host', 18)}${padLeft('tools', 6)}${padLeft('tokens', 10)}${padLeft('share', 7)}${c.reset}`,
    )
    ranked.forEach((w, i) => {
      const share = total > 0 ? w.taxTokens / total : 0
      const name = w.spec.name.length > 20 ? w.spec.name.slice(0, 19) + '…' : w.spec.name
      lines.push(
        `  ${pad(`#${i + 1}`, 6)}${pad(`${c.bold}${name}${c.reset}`, 22 + (c.bold.length + c.reset.length))}${pad(`${c.gray}${hostsOf(w).slice(0, 16)}${c.reset}`, 18 + (c.gray.length + c.reset.length))}${padLeft(String(w.toolCount), 6)}${padLeft(tokensLabel(w), 10)}${padLeft(`${Math.round(share * 100)}%`, 7)}  ${c.cyan}${bar(share)}${c.reset}`,
      )
    })
    lines.push('')
  }

  // Per-server detail: the heaviest tools are where the trimming happens.
  for (const w of ranked) {
    if (w.tools.length === 0) continue
    const info = w.serverInfo?.name ? `${w.serverInfo.name}${w.serverInfo.version ? ` v${w.serverInfo.version}` : ''}` : ''
    lines.push(
      `  ${c.bold}${w.spec.name}${c.reset}  ${c.gray}${info}${info ? '  ' : ''}${w.toolCount} tools${w.instructionTokens ? `, instructions ${approx}${fmt(w.instructionTokens)} tok` : ''}${w.connectMs !== undefined ? `, connected in ${w.connectMs}ms` : ''}${c.reset}`,
    )
    for (const t of w.tools.slice(0, top)) {
      lines.push(
        `    ${padLeft(fmt(t.tokens), 8)} tok  ${pad(t.name.slice(0, 40), 42)}${c.gray}desc ${fmt(t.descriptionTokens)}, schema ${fmt(t.schemaTokens)}${c.reset}`,
      )
    }
    if (w.tools.length > top) {
      const rest = w.tools.slice(top).reduce((s, t) => s + t.tokens, 0)
      lines.push(`    ${padLeft(fmt(rest), 8)} tok  ${c.gray}… ${w.tools.length - top} more tools${c.reset}`)
    }
    lines.push('')
  }

  for (const w of broken) {
    lines.push(`  ${c.red}failed${c.reset}  ${c.bold}${w.spec.name}${c.reset}  ${c.gray}${w.error}${c.reset}`)
  }
  if (broken.length) lines.push('')

  // The other half of the bill: files the hosts inject without any MCP.
  if (statics.length > 0) {
    lines.push(`  ${c.bold}agent files${c.reset}  ${c.gray}instruction files your editors and CLIs load on their own${c.reset}`)
    for (const f of statics) {
      const marker = f.alwaysLoaded ? '' : `${c.gray} (not counted)${c.reset}`
      lines.push(
        `    ${padLeft(`~${fmt(f.tokens)}`, 8)} tok  ${pad(f.label.slice(0, 34), 36)}${c.gray}${f.host}${f.note ? ` -- ${f.note}` : ''}${c.reset}${marker}`,
      )
    }
    lines.push('')
  }

  // The verdict block: window share and money.
  const windowShare = grand / CONTEXT_WINDOW
  const monthlyTokens = grand * report.options.requestsPerDay * 30
  const monthlyUsd = (monthlyTokens / 1_000_000) * report.options.pricePerMTok
  const breakdown =
    staticTokens > 0 ? ` ${c.gray}(MCP ${approx}${fmt(total)} + agent files ~${fmt(staticTokens)})${c.reset}` : ''

  lines.push(`  ${c.gray}${'-'.repeat(72)}${c.reset}`)
  lines.push(
    `  ${c.bold}${approx}${fmt(grand)} tokens${c.reset} on every request${breakdown} = ${c.bold}${(windowShare * 100).toFixed(1)}%${c.reset} of a ${fmt(CONTEXT_WINDOW)} context window, before you type a word`,
  )
  lines.push(
    `  ${c.gray}at ${fmt(report.options.requestsPerDay)} requests/day and $${report.options.pricePerMTok.toFixed(2)}/MTok input: ${c.reset}${c.bold}${approx}$${monthlyUsd.toFixed(monthlyUsd >= 100 ? 0 : 2)}/month${c.reset}${c.gray} of uncached input spend${c.reset}`,
  )
  if (report.method !== 'counted') {
    lines.push(`  ${c.gray}estimated without a tokenizer; set ANTHROPIC_API_KEY and pass --precise for exact counts${c.reset}`)
  }

  // Advice only when there is something to act on.
  const advice: string[] = []
  if (total / CONTEXT_WINDOW > 0.1 && ranked.length > 1) {
    advice.push(
      `over 10% of the window goes to tool definitions -- disable the servers you are not using today (${ranked[0]!.spec.name} alone is ${Math.round(((ranked[0]!.taxTokens) / total) * 100)}%)`,
    )
  }
  const fatTool = ranked.flatMap((w) => w.tools.map((t) => ({ server: w.spec.name, t }))).find((x) => x.t.tokens > 600)
  if (fatTool) {
    advice.push(
      `${fatTool.server}'s "${fatTool.t.name}" costs ${fmt(fatTool.t.tokens)} tokens by itself -- a tool description is a prompt you pay for on every request`,
    )
  }
  if (advice.length > 0) {
    lines.push('')
    for (const a of advice) lines.push(`  ${c.yellow}!${c.reset} ${a}`)
  }
  lines.push('')
  return lines.join('\n')
}
