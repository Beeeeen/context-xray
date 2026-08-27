/**
 * Just enough TOML to read Codex CLI's `~/.codex/config.toml`: table headers,
 * string / string-array / inline-table values, comments. Anything the subset
 * does not understand is skipped line by line rather than failing the file —
 * a config we half-read still yields the `[mcp_servers.*]` blocks we came for.
 */
export function parseTomlSubset(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let current = root

  const enter = (dottedKey: string): Record<string, unknown> => {
    let node = root
    for (const part of splitDotted(dottedKey)) {
      const next = node[part]
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        node = next as Record<string, unknown>
      } else {
        const fresh: Record<string, unknown> = {}
        node[part] = fresh
        node = fresh
      }
    }
    return node
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (!line) continue

    if (line.startsWith('[') && line.endsWith(']') && !line.startsWith('[[')) {
      current = enter(line.slice(1, -1).trim())
      continue
    }

    const eq = findUnquoted(line, '=')
    if (eq < 1) continue
    const key = unquoteKey(line.slice(0, eq).trim())
    const value = parseValue(line.slice(eq + 1).trim())
    if (key && value !== undefined) current[key] = value
  }
  return root
}

function stripComment(line: string): string {
  let inString: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inString) {
      if (ch === '\\' && inString === '"') i++
      else if (ch === inString) inString = null
    } else if (ch === '"' || ch === "'") {
      inString = ch
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

function findUnquoted(s: string, needle: string): number {
  let inString: '"' | "'" | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (ch === '\\' && inString === '"') i++
      else if (ch === inString) inString = null
    } else if (ch === '"' || ch === "'") inString = ch
    else if (ch === needle) return i
  }
  return -1
}

function splitDotted(key: string): string[] {
  const parts: string[] = []
  let buf = ''
  let inString: '"' | "'" | null = null
  for (const ch of key) {
    if (inString) {
      if (ch === inString) inString = null
      else buf += ch
    } else if (ch === '"' || ch === "'") inString = ch
    else if (ch === '.') {
      parts.push(buf.trim())
      buf = ''
    } else buf += ch
  }
  parts.push(buf.trim())
  return parts.filter(Boolean)
}

function unquoteKey(key: string): string {
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    return key.slice(1, -1)
  }
  return key
}

function parseValue(raw: string): unknown {
  if (!raw) return undefined
  if (raw.startsWith('"') || raw.startsWith("'")) return parseString(raw)
  if (raw.startsWith('[')) return parseArray(raw)
  if (raw.startsWith('{')) return parseInlineTable(raw)
  if (raw === 'true') return true
  if (raw === 'false') return false
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function parseString(raw: string): string | undefined {
  const quote = raw[0] as '"' | "'"
  let out = ''
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i]
    if (quote === '"' && ch === '\\') {
      const next = raw[++i]
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : (next ?? '')
    } else if (ch === quote) {
      return out
    } else out += ch
  }
  return undefined
}

/** Split a bracketed/braced body on top-level commas, respecting nesting and strings. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let buf = ''
  let inString: '"' | "'" | null = null
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (inString) {
      buf += ch
      if (ch === '\\' && inString === '"') buf += body[++i] ?? ''
      else if (ch === inString) inString = null
    } else if (ch === '"' || ch === "'") {
      inString = ch
      buf += ch
    } else if (ch === '[' || ch === '{') {
      depth++
      buf += ch
    } else if (ch === ']' || ch === '}') {
      depth--
      buf += ch
    } else if (ch === ',' && depth === 0) {
      parts.push(buf.trim())
      buf = ''
    } else buf += ch
  }
  if (buf.trim()) parts.push(buf.trim())
  return parts
}

function parseArray(raw: string): unknown[] | undefined {
  if (!raw.endsWith(']')) return undefined
  return splitTopLevel(raw.slice(1, -1))
    .map(parseValue)
    .filter((v) => v !== undefined)
}

function parseInlineTable(raw: string): Record<string, unknown> | undefined {
  if (!raw.endsWith('}')) return undefined
  const out: Record<string, unknown> = {}
  for (const pair of splitTopLevel(raw.slice(1, -1))) {
    const eq = findUnquoted(pair, '=')
    if (eq < 1) continue
    const key = unquoteKey(pair.slice(0, eq).trim())
    const value = parseValue(pair.slice(eq + 1).trim())
    if (key && value !== undefined) out[key] = value
  }
  return out
}
