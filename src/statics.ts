import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { estimateTokens } from './estimate.js'
import type { StaticFile } from './types.js'

/** Refuse to weigh anything absurd — an instruction file is prose, not a dataset. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

function readCapped(path: string): string | null {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

interface Candidate {
  path: string
  label: string
  host: string
  kind: StaticFile['kind']
}

function instructionCandidates(home: string, cwd: string): Candidate[] {
  const c = (path: string, label: string, host: string): Candidate => ({ path, label, host, kind: 'instructions' })
  return [
    c(join(home, '.claude', 'CLAUDE.md'), 'CLAUDE.md (global)', 'Claude Code'),
    c(join(cwd, 'CLAUDE.md'), 'CLAUDE.md (project)', 'Claude Code'),
    c(join(cwd, 'CLAUDE.local.md'), 'CLAUDE.local.md', 'Claude Code'),
    c(join(cwd, '.claude', 'CLAUDE.md'), '.claude/CLAUDE.md', 'Claude Code'),
    c(join(cwd, 'AGENTS.md'), 'AGENTS.md (project)', 'Codex / agents'),
    c(join(home, '.codex', 'AGENTS.md'), 'AGENTS.md (global)', 'Codex CLI'),
    c(join(cwd, 'GEMINI.md'), 'GEMINI.md (project)', 'Gemini CLI'),
    c(join(home, '.gemini', 'GEMINI.md'), 'GEMINI.md (global)', 'Gemini CLI'),
    c(join(cwd, '.github', 'copilot-instructions.md'), 'copilot-instructions.md', 'GitHub Copilot'),
  ]
}

function ruleCandidates(home: string, cwd: string): Candidate[] {
  const c = (path: string, label: string, host: string): Candidate => ({ path, label, host, kind: 'rules' })
  return [
    c(join(cwd, '.cursorrules'), '.cursorrules', 'Cursor'),
    c(join(cwd, '.windsurfrules'), '.windsurfrules', 'Windsurf'),
    c(join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md'), 'global_rules.md', 'Windsurf'),
  ]
}

/**
 * A Cursor .mdc rule only always-loads when its frontmatter says so; rules
 * scoped by globs or left to the agent load conditionally. We report both but
 * only always-on rules join the every-request total.
 */
function mdcAlwaysApplies(content: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!m) return true // no frontmatter: legacy always-on rule
  return /^\s*alwaysApply\s*:\s*true\s*$/m.test(m[1]!)
}

function cursorRuleFiles(cwd: string): StaticFile[] {
  const dir = join(cwd, '.cursor', 'rules')
  let entries: string[]
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.mdc') || f.endsWith('.md'))
  } catch {
    return []
  }
  const out: StaticFile[] = []
  for (const f of entries) {
    const path = join(dir, f)
    const content = readCapped(path)
    if (content === null) continue
    const always = mdcAlwaysApplies(content)
    out.push({
      path,
      label: `.cursor/rules/${basename(f)}`,
      host: 'Cursor',
      kind: 'rules',
      tokens: estimateTokens(content),
      alwaysLoaded: always,
      ...(always ? {} : { note: 'conditional (globs / agent-requested)' }),
    })
  }
  return out
}

interface FrontmatterInfo {
  name: string
  description: string
  bodyTokens: number
}

function readSkillFrontmatter(path: string, fallbackName: string): FrontmatterInfo | null {
  const content = readCapped(path)
  if (content === null) return null
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content)
  const fm = m?.[1] ?? ''
  const body = m?.[2] ?? content
  const pick = (key: string) => new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm').exec(fm)?.[1]?.trim() ?? ''
  return {
    name: pick('name') || fallbackName,
    description: pick('description'),
    bodyTokens: estimateTokens(body),
  }
}

/**
 * Claude Code skills bill in two parts: every skill's name + description sits
 * in the tool listing on every request; the SKILL.md body only loads when the
 * skill is invoked. One aggregated row per scope keeps the report honest about
 * both numbers.
 */
function skillsListing(root: string, label: string): StaticFile | null {
  const dir = join(root, 'skills')
  let entries: string[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return null
  }

  let listingTokens = 0
  let bodyTokens = 0
  let count = 0
  for (const name of entries) {
    const info = readSkillFrontmatter(join(dir, name, 'SKILL.md'), name)
    if (!info) continue
    count++
    listingTokens += estimateTokens(`- ${info.name}: ${info.description}`)
    bodyTokens += info.bodyTokens
  }
  if (count === 0) return null
  return {
    path: dir,
    label,
    host: 'Claude Code',
    kind: 'skills-listing',
    tokens: listingTokens,
    alwaysLoaded: true,
    note: `${count} skill${count === 1 ? '' : 's'}; bodies ~${bodyTokens.toLocaleString('en-US')} tok load on demand`,
  }
}

/**
 * The other half of the context bill: instruction files the hosts on this
 * machine inject on their own — no MCP involved. Everything is read locally
 * and only weighed; contents never leave the process.
 */
export function discoverStatics(home = homedir(), cwd = process.cwd()): StaticFile[] {
  const out: StaticFile[] = []

  for (const cand of [...instructionCandidates(home, cwd), ...ruleCandidates(home, cwd)]) {
    if (!existsSync(cand.path)) continue
    const content = readCapped(cand.path)
    if (content === null || content.trim() === '') continue
    out.push({
      path: cand.path,
      label: cand.label,
      host: cand.host,
      kind: cand.kind,
      tokens: estimateTokens(content),
      alwaysLoaded: true,
    })
  }

  out.push(...cursorRuleFiles(cwd))

  const globalSkills = skillsListing(join(home, '.claude'), 'skills listing (global)')
  if (globalSkills) out.push(globalSkills)
  const projectSkills = skillsListing(join(cwd, '.claude'), 'skills listing (project)')
  if (projectSkills) out.push(projectSkills)

  return out.sort((a, b) => b.tokens - a.tokens)
}

/** Sum of the files that actually load on every request. */
export function staticTotal(files: StaticFile[]): number {
  return files.filter((f) => f.alwaysLoaded).reduce((sum, f) => sum + f.tokens, 0)
}
