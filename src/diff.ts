import type { ServerDelta, ServerWeight, XrayDiff, XrayReport } from './types.js'

/** A tool-level move worth calling out in the diff, in tokens. */
const NOTABLE_TOOL_DELTA = 50

type LooseReport = Partial<XrayReport> & Pick<XrayReport, 'servers' | 'totalTaxTokens'>

const staticOf = (r: LooseReport) => r.staticTokens ?? 0
const grandOf = (r: LooseReport) => r.grandTotalTokens ?? r.totalTaxTokens + staticOf(r)

function toolNotes(before: ServerWeight | undefined, after: ServerWeight | undefined): string[] {
  const notes: string[] = []
  const beforeTools = new Map((before?.tools ?? []).map((t) => [t.name, t.tokens]))
  const afterTools = new Map((after?.tools ?? []).map((t) => [t.name, t.tokens]))

  for (const [name, tokens] of afterTools) {
    const prev = beforeTools.get(name)
    if (prev === undefined) notes.push(`+ ${name} (${tokens.toLocaleString('en-US')} tok)`)
    else if (Math.abs(tokens - prev) >= NOTABLE_TOOL_DELTA)
      notes.push(`~ ${name} (${prev.toLocaleString('en-US')} -> ${tokens.toLocaleString('en-US')} tok)`)
  }
  for (const [name, tokens] of beforeTools) {
    if (!afterTools.has(name)) notes.push(`- ${name} (${tokens.toLocaleString('en-US')} tok)`)
  }
  return notes
}

/**
 * Compare two reports by server name. `before` is a saved --json report —
 * possibly from an older version, so every new field is optional there.
 */
export function diffReports(before: LooseReport, after: XrayReport): XrayDiff {
  const beforeByName = new Map(before.servers.map((s) => [s.spec.name, s]))
  const afterByName = new Map(after.servers.map((s) => [s.spec.name, s]))
  const servers: ServerDelta[] = []

  for (const [name, b] of beforeByName) {
    const a = afterByName.get(name)
    if (!a) {
      servers.push({
        name,
        change: 'removed',
        beforeTokens: b.taxTokens,
        afterTokens: 0,
        beforeTools: b.toolCount,
        afterTools: 0,
        toolNotes: [],
      })
    } else if (a.taxTokens !== b.taxTokens || a.toolCount !== b.toolCount) {
      servers.push({
        name,
        change: 'changed',
        beforeTokens: b.taxTokens,
        afterTokens: a.taxTokens,
        beforeTools: b.toolCount,
        afterTools: a.toolCount,
        toolNotes: toolNotes(b, a),
      })
    }
  }
  for (const [name, a] of afterByName) {
    if (beforeByName.has(name)) continue
    servers.push({
      name,
      change: 'added',
      beforeTokens: 0,
      afterTokens: a.taxTokens,
      beforeTools: 0,
      afterTools: a.toolCount,
      toolNotes: [],
    })
  }
  servers.sort((x, y) => Math.abs(y.afterTokens - y.beforeTokens) - Math.abs(x.afterTokens - x.beforeTokens))

  const staticNotes: string[] = []
  const beforeStatics = new Map((before.staticFiles ?? []).map((f) => [f.path, f]))
  const afterStatics = new Map(after.staticFiles.map((f) => [f.path, f]))
  for (const [path, f] of afterStatics) {
    const prev = beforeStatics.get(path)
    if (!prev) staticNotes.push(`+ ${f.label} (${f.tokens.toLocaleString('en-US')} tok)`)
    else if (prev.tokens !== f.tokens)
      staticNotes.push(`~ ${f.label} (${prev.tokens.toLocaleString('en-US')} -> ${f.tokens.toLocaleString('en-US')} tok)`)
  }
  for (const [path, f] of beforeStatics) {
    if (!afterStatics.has(path)) staticNotes.push(`- ${f.label} (${f.tokens.toLocaleString('en-US')} tok)`)
  }

  return {
    beforeTotal: before.totalTaxTokens,
    afterTotal: after.totalTaxTokens,
    beforeStatic: staticOf(before),
    afterStatic: staticOf(after),
    beforeGrand: grandOf(before),
    afterGrand: grandOf(after),
    servers,
    staticNotes,
  }
}

const signed = (n: number) => (n > 0 ? `+${n.toLocaleString('en-US')}` : n.toLocaleString('en-US'))

export function renderDiff(diff: XrayDiff): string {
  const lines: string[] = ['']
  const delta = diff.afterGrand - diff.beforeGrand
  const verdict =
    delta === 0 ? 'unchanged' : `${signed(delta)} tokens per request ${delta > 0 ? '(heavier)' : '(lighter)'}`
  lines.push(`  context-xray diff  ${verdict}`)
  lines.push(
    `  before ${diff.beforeGrand.toLocaleString('en-US')} tok -> after ${diff.afterGrand.toLocaleString('en-US')} tok` +
      (diff.beforeStatic || diff.afterStatic
        ? `  (MCP ${signed(diff.afterTotal - diff.beforeTotal)}, agent files ${signed(diff.afterStatic - diff.beforeStatic)})`
        : ''),
  )
  lines.push('')

  for (const s of diff.servers) {
    const d = s.afterTokens - s.beforeTokens
    const head =
      s.change === 'added'
        ? `added    ${s.name}  ${signed(d)} tok, ${s.afterTools} tools`
        : s.change === 'removed'
          ? `removed  ${s.name}  ${signed(d)} tok`
          : `changed  ${s.name}  ${signed(d)} tok, tools ${s.beforeTools} -> ${s.afterTools}`
    lines.push(`  ${head}`)
    for (const note of s.toolNotes.slice(0, 6)) lines.push(`             ${note}`)
    if (s.toolNotes.length > 6) lines.push(`             ... ${s.toolNotes.length - 6} more`)
  }
  if (diff.servers.length === 0) lines.push('  no server changes')

  if (diff.staticNotes.length > 0) {
    lines.push('')
    for (const note of diff.staticNotes) lines.push(`  ${note}`)
  }
  lines.push('')
  return lines.join('\n')
}
