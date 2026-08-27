import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseTomlSubset } from './toml.js'
import type { ServerSpec } from './types.js'

/**
 * Every place the well-known hosts keep their MCP configuration. Three shapes
 * exist in the wild: `mcpServers` (Claude Desktop, Claude Code, Cursor,
 * Windsurf, Gemini CLI, Cline, Roo Code), `servers` (VS Code), and
 * `context_servers` (Zed). Codex CLI is the odd one out with TOML.
 */
export function knownConfigPaths(platform = process.platform, home = homedir(), cwd = process.cwd()): Array<{ path: string; host: string }> {
  const paths: Array<{ path: string; host: string }> = []
  const push = (path: string, host: string) => paths.push({ path, host })

  // VS Code's user dir also hosts extension state, which is where the Cline
  // family keeps its own MCP config.
  let codeUser: string
  if (platform === 'win32') {
    const appdata = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    codeUser = join(appdata, 'Code', 'User')
    push(join(appdata, 'Claude', 'claude_desktop_config.json'), 'Claude Desktop')
    push(join(appdata, 'Zed', 'settings.json'), 'Zed')
  } else if (platform === 'darwin') {
    codeUser = join(home, 'Library', 'Application Support', 'Code', 'User')
    push(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), 'Claude Desktop')
    push(join(home, '.config', 'zed', 'settings.json'), 'Zed')
  } else {
    codeUser = join(home, '.config', 'Code', 'User')
    push(join(home, '.config', 'Claude', 'claude_desktop_config.json'), 'Claude Desktop')
    push(join(home, '.config', 'zed', 'settings.json'), 'Zed')
  }
  push(join(codeUser, 'mcp.json'), 'VS Code')
  push(join(codeUser, 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), 'Cline')
  push(join(codeUser, 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'), 'Roo Code')

  push(join(home, '.claude.json'), 'Claude Code')
  push(join(cwd, '.mcp.json'), 'Claude Code (project)')
  push(join(home, '.cursor', 'mcp.json'), 'Cursor')
  push(join(cwd, '.cursor', 'mcp.json'), 'Cursor (project)')
  push(join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'Windsurf')
  push(join(cwd, '.vscode', 'mcp.json'), 'VS Code (workspace)')
  push(join(home, '.gemini', 'settings.json'), 'Gemini CLI')
  push(join(home, '.codex', 'config.toml'), 'Codex CLI')
  return paths
}

interface RawEntry {
  command?: unknown
  args?: unknown
  env?: unknown
  cwd?: unknown
  url?: unknown
  serverUrl?: unknown
  httpUrl?: unknown
  headers?: unknown
  type?: unknown
  disabled?: unknown
}

function toSpec(name: string, raw: RawEntry, source: string): ServerSpec | null {
  if (raw.disabled === true) return null

  const sources = [source]
  const url =
    typeof raw.url === 'string'
      ? raw.url
      : typeof raw.serverUrl === 'string'
        ? raw.serverUrl
        : typeof raw.httpUrl === 'string'
          ? raw.httpUrl
          : null
  if (url) {
    return { name, kind: 'http', url, headers: (raw.headers as Record<string, string>) ?? {}, sources }
  }

  // Zed nests the launch under `command: { path, args, env }` instead of the
  // flat shape everyone else uses; flatten it before the common handling.
  let command = raw.command
  let args = raw.args
  let env = raw.env
  if (command && typeof command === 'object' && !Array.isArray(command)) {
    const nested = command as { path?: unknown; args?: unknown; env?: unknown }
    command = nested.path
    args = args ?? nested.args
    env = env ?? nested.env
  }
  if (typeof command !== 'string' || !command) return null

  const argList = Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : []
  const spec: ServerSpec = {
    name,
    kind: 'stdio',
    command,
    args: argList,
    env: (env as Record<string, string>) ?? {},
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    sources,
  }

  // VS Code configs can reference interactive inputs (${input:apiKey}); those
  // servers cannot be launched non-interactively, but they should still show
  // up in the report rather than silently vanish.
  const joined = [command, ...argList, JSON.stringify(spec.env)].join(' ')
  if (joined.includes('${input:')) {
    spec.unlaunchable = 'uses ${input:...} placeholders that need interactive values'
  }
  return spec
}

/** Pull every server out of one config file. Returns [] when unreadable. */
export function readConfigFile(path: string, host: string): ServerSpec[] {
  let parsed: Record<string, unknown>
  try {
    const text = readFileSync(path, 'utf8')
    parsed = path.endsWith('.toml')
      ? parseTomlSubset(text)
      : (JSON.parse(text) as Record<string, unknown>)
  } catch {
    return []
  }
  const out: ServerSpec[] = []
  const source = `${host} (${path})`

  const collect = (block: unknown) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return
    for (const [name, entry] of Object.entries(block as Record<string, RawEntry>)) {
      const spec = toSpec(name, entry ?? {}, source)
      if (spec) out.push(spec)
    }
  }

  collect(parsed['mcpServers'])
  collect(parsed['servers'])
  collect(parsed['context_servers']) // Zed
  collect(parsed['mcp_servers']) // Codex CLI (TOML)

  // Claude Code also nests per-project servers under `projects`.
  const projects = parsed['projects']
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const proj of Object.values(projects as Record<string, Record<string, unknown>>)) {
      collect(proj?.['mcpServers'])
    }
  }
  return out
}

/**
 * Search every known location, merge duplicates (the same server configured
 * in several hosts is one server with several sources), and report which
 * config files were actually found.
 */
export function discover(explicitConfig?: string): { specs: ServerSpec[]; configsSearched: string[] } {
  const candidates = explicitConfig
    ? [{ path: explicitConfig, host: 'config' }]
    : knownConfigPaths()

  const configsSearched: string[] = []
  const byIdentity = new Map<string, ServerSpec>()

  for (const { path, host } of candidates) {
    if (!existsSync(path)) continue
    configsSearched.push(path)
    for (const spec of readConfigFile(path, host)) {
      // Identity is what would actually run, not the display name -- two hosts
      // pointing at the same command are one server. The environment is part
      // of what runs: the same command with a different env (one with a real
      // token, one with a placeholder) is a different server, and merging
      // them would silently drop one from the report.
      const envKey = JSON.stringify(Object.entries(spec.env ?? {}).sort())
      const identity =
        spec.kind === 'http'
          ? `http|${spec.url}`
          : `stdio|${spec.command}|${(spec.args ?? []).join(' ')}|${envKey}|${spec.cwd ?? ''}`
      const existing = byIdentity.get(identity)
      if (existing) existing.sources.push(...spec.sources)
      else byIdentity.set(identity, spec)
    }
  }
  return { specs: [...byIdentity.values()], configsSearched }
}
