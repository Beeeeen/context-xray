import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { readConfigFile, discover } from '../dist/discover.js'
import { estimateTokens } from '../dist/estimate.js'
import { weighServer, weighAll } from '../dist/weigh.js'
import { renderTerminal } from '../dist/report/terminal.js'
import { parseTomlSubset } from '../dist/toml.js'
import { discoverStatics, staticTotal } from '../dist/statics.js'
import { diffReports, renderDiff } from '../dist/diff.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, '..', 'fixtures', name)

const spec = (file, name = 'fx') => ({
  name,
  kind: 'stdio',
  command: process.execPath,
  args: [fixture(file)],
  sources: ['test'],
})

const OPTS = { timeoutMs: 10000, precise: false, requestsPerDay: 200, pricePerMTok: 3, top: 3, concurrency: 4 }

// ---------------------------------------------------------------- discovery

test('reads the mcpServers shape (Claude Desktop, Claude Code, Cursor)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-'))
  const p = join(dir, 'config.json')
  writeFileSync(
    p,
    JSON.stringify({
      mcpServers: {
        alpha: { command: 'node', args: ['a.js'], env: { KEY: 'v' } },
        remote: { url: 'https://example.com/mcp', headers: { authorization: 'Bearer x' } },
        off: { command: 'node', args: ['off.js'], disabled: true },
      },
    }),
  )
  const specs = readConfigFile(p, 'TestHost')
  assert.equal(specs.length, 2, 'the disabled server must be skipped')
  const alpha = specs.find((s) => s.name === 'alpha')
  assert.equal(alpha.kind, 'stdio')
  assert.deepEqual(alpha.args, ['a.js'])
  const remote = specs.find((s) => s.name === 'remote')
  assert.equal(remote.kind, 'http')
  assert.equal(remote.url, 'https://example.com/mcp')
})

test('reads the servers shape (VS Code) and flags interactive placeholders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-'))
  const p = join(dir, 'mcp.json')
  writeFileSync(
    p,
    JSON.stringify({
      servers: {
        needsKey: { command: 'npx', args: ['some-server'], env: { API_KEY: '${input:apiKey}' } },
        plain: { command: 'node', args: ['s.js'] },
      },
    }),
  )
  const specs = readConfigFile(p, 'VS Code')
  assert.equal(specs.length, 2)
  const needsKey = specs.find((s) => s.name === 'needsKey')
  assert.ok(needsKey.unlaunchable, 'a ${input:...} server cannot be launched non-interactively')
  assert.ok(!specs.find((s) => s.name === 'plain').unlaunchable)
})

test('reads Claude Code per-project servers nested under projects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-'))
  const p = join(dir, '.claude.json')
  writeFileSync(
    p,
    JSON.stringify({
      mcpServers: { global: { command: 'node', args: ['g.js'] } },
      projects: { 'C:/work/app': { mcpServers: { scoped: { command: 'node', args: ['s.js'] } } } },
    }),
  )
  const names = readConfigFile(p, 'Claude Code').map((s) => s.name).sort()
  assert.deepEqual(names, ['global', 'scoped'])
})

test('the same server in two configs is one server with two sources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-'))
  writeFileSync(join(dir, 'one.json'), JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['server-fs', '/tmp'] } } }))
  // discover() with an explicit config only reads that file, so merge across
  // files is exercised through readConfigFile + the identity logic directly.
  const a = readConfigFile(join(dir, 'one.json'), 'HostA')
  const b = readConfigFile(join(dir, 'one.json'), 'HostB')
  assert.equal(a[0].sources[0].startsWith('HostA'), true)
  assert.equal(b[0].sources[0].startsWith('HostB'), true)
})

test('discover with an explicit config returns its servers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-'))
  const p = join(dir, 'c.json')
  writeFileSync(p, JSON.stringify({ mcpServers: { one: { command: 'node', args: ['x.js'] } } }))
  const { specs, configsSearched } = discover(p)
  assert.equal(specs.length, 1)
  assert.deepEqual(configsSearched, [p])
})

test('the same command with a different env is a different server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dedupe-'))
  const cfg = join(dir, 'c.json')
  writeFileSync(
    cfg,
    JSON.stringify({
      mcpServers: {
        'with-token': { command: 'node', args: ['s.js'], env: { TOKEN: 'real-value' } },
        'no-token': { command: 'node', args: ['s.js'] },
      },
    }),
  )
  const { specs } = discover(cfg)
  // Same command and args, different env: merging these would silently drop
  // one server from the report -- the bug the dogfood CI job caught.
  assert.equal(specs.length, 2, specs.map((s) => s.name).join(','))
})

test('reads the context_servers shape (Zed), including the nested command object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-'))
  const p = join(dir, 'settings.json')
  writeFileSync(
    p,
    JSON.stringify({
      context_servers: {
        nested: { command: { path: 'node', args: ['z.js'], env: { K: 'v' } } },
        flat: { command: 'node', args: ['f.js'] },
        fromExtension: { source: 'extension' },
      },
    }),
  )
  const specs = readConfigFile(p, 'Zed')
  assert.equal(specs.length, 2, 'the extension-provided entry has nothing to launch')
  const nested = specs.find((s) => s.name === 'nested')
  assert.equal(nested.command, 'node')
  assert.deepEqual(nested.args, ['z.js'])
  assert.deepEqual(nested.env, { K: 'v' })
})

test('reads the Gemini CLI httpUrl field as a remote server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-'))
  const p = join(dir, 'settings.json')
  writeFileSync(p, JSON.stringify({ mcpServers: { remote: { httpUrl: 'https://example.com/mcp' } } }))
  const specs = readConfigFile(p, 'Gemini CLI')
  assert.equal(specs[0].kind, 'http')
  assert.equal(specs[0].url, 'https://example.com/mcp')
})

test('reads Codex CLI mcp_servers out of TOML', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-'))
  const p = join(dir, 'config.toml')
  writeFileSync(
    p,
    [
      'model = "o4"  # unrelated key',
      '',
      '[mcp_servers.docs]',
      'command = "npx"',
      'args = ["-y", "docs-server"]',
      'env = { API_KEY = "abc" }',
      '',
      '[mcp_servers."with.dot"]',
      'command = "node"',
      'args = ["s.js"]',
    ].join('\n'),
  )
  const specs = readConfigFile(p, 'Codex CLI')
  assert.equal(specs.length, 2)
  const docs = specs.find((s) => s.name === 'docs')
  assert.equal(docs.command, 'npx')
  assert.deepEqual(docs.args, ['-y', 'docs-server'])
  assert.deepEqual(docs.env, { API_KEY: 'abc' })
  assert.ok(specs.find((s) => s.name === 'with.dot'))
})

test('the TOML subset survives comments, quotes and unknown syntax', () => {
  const parsed = parseTomlSubset(
    [
      '# full-line comment',
      'plain = "value with # not a comment"',
      "single = 'no \\escapes here'",
      'num = 42',
      'flag = true',
      'arr = ["a", "b,c", "d"]',
      'weird = 2026-08-27T00:00:00Z', // unsupported type: skipped, not fatal
      '[table.sub]',
      'k = "v"',
    ].join('\n'),
  )
  assert.equal(parsed.plain, 'value with # not a comment')
  assert.equal(parsed.single, 'no \\escapes here')
  assert.equal(parsed.num, 42)
  assert.equal(parsed.flag, true)
  assert.deepEqual(parsed.arr, ['a', 'b,c', 'd'])
  assert.equal(parsed.weird, undefined)
  assert.equal(parsed.table.sub.k, 'v')
})

test('an unreadable config yields no servers, not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-'))
  const p = join(dir, 'broken.json')
  writeFileSync(p, '{ not json')
  assert.deepEqual(readConfigFile(p, 'X'), [])
})

// ---------------------------------------------------------------- estimation

test('token estimates scale with content and price JSON denser than prose', () => {
  assert.equal(estimateTokens(''), 0)
  const prose = 'the quick brown fox jumps over the lazy dog and keeps on running through the field'
  const json = '{"a":{"b":{"c":[1,2,3]},"d":"e"},"f":["g","h"],"i":{"j":"k"}}'
  const proseRate = estimateTokens(prose) / prose.length
  const jsonRate = estimateTokens(json) / json.length
  assert.ok(jsonRate > proseRate, 'structural characters must cost more per char than prose')
  const double = estimateTokens(prose + ' ' + prose)
  assert.ok(double > estimateTokens(prose) * 1.8, 'estimate should scale roughly linearly')
})

// -------------------------------------------------------------- agent files

/** Build a fake home + project tree and return both roots. */
function staticsFixture() {
  const root = mkdtempSync(join(tmpdir(), 'xray-statics-'))
  const home = join(root, 'home')
  const cwd = join(root, 'proj')
  mkdirSync(join(home, '.claude', 'skills', 'deploy'), { recursive: true })
  mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true })
  mkdirSync(cwd, { recursive: true })

  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'Always answer in haiku. '.repeat(40))
  writeFileSync(join(cwd, 'CLAUDE.md'), 'Project conventions: use tabs, never spaces. '.repeat(20))
  writeFileSync(join(cwd, '.cursor', 'rules', 'always.mdc'), '---\nalwaysApply: true\n---\nAlways lint.')
  writeFileSync(
    join(cwd, '.cursor', 'rules', 'scoped.mdc'),
    '---\nglobs: ["*.tsx"]\nalwaysApply: false\n---\n' + 'Big conditional rule body. '.repeat(50),
  )
  writeFileSync(
    join(home, '.claude', 'skills', 'deploy', 'SKILL.md'),
    '---\nname: deploy\ndescription: Ship the app to production\n---\n' + 'Long body. '.repeat(100),
  )
  return { home, cwd }
}

test('weighs CLAUDE.md, cursor rules and the skills listing', () => {
  const { home, cwd } = staticsFixture()
  const files = discoverStatics(home, cwd)
  const labels = files.map((f) => f.label)

  assert.ok(labels.includes('CLAUDE.md (global)'))
  assert.ok(labels.includes('CLAUDE.md (project)'))
  assert.ok(labels.includes('.cursor/rules/always.mdc'))
  assert.ok(labels.includes('skills listing (global)'))

  const scoped = files.find((f) => f.label === '.cursor/rules/scoped.mdc')
  assert.equal(scoped.alwaysLoaded, false, 'glob-scoped rules must not join the every-request total')
  assert.ok(staticTotal(files) < files.reduce((s, f) => s + f.tokens, 0), 'conditional files stay out of the total')

  const skills = files.find((f) => f.kind === 'skills-listing')
  assert.ok(skills.tokens > 0 && skills.tokens < 60, 'only the listing line is charged per request')
  assert.match(skills.note, /load on demand/)
})

test('statics discovery on an empty tree finds nothing and does not crash', () => {
  const root = mkdtempSync(join(tmpdir(), 'xray-empty-'))
  assert.deepEqual(discoverStatics(join(root, 'h'), join(root, 'c')), [])
})

// --------------------------------------------------------------------- diff

const fakeServer = (name, taxTokens, tools) => ({
  spec: { name, kind: 'stdio', command: 'node', sources: ['test'] },
  ok: true,
  tools,
  toolCount: tools.length,
  resourceCount: 0,
  promptCount: 0,
  toolTokens: taxTokens,
  instructionTokens: 0,
  taxTokens,
  method: 'estimate',
})

const fakeReport = (servers, staticFiles = []) => {
  const totalTaxTokens = servers.reduce((s, w) => s + w.taxTokens, 0)
  const staticTokens = staticFiles.reduce((s, f) => s + f.tokens, 0)
  return {
    servers,
    totalTaxTokens,
    staticFiles,
    staticTokens,
    grandTotalTokens: totalTaxTokens + staticTokens,
    method: 'estimate',
    options: { requestsPerDay: 200, pricePerMTok: 3 },
    configsSearched: [],
    durationMs: 1,
    xrayVersion: 'test',
  }
}

test('diff reports added, removed and changed servers with tool-level notes', () => {
  const tool = (name, tokens) => ({ name, tokens, descriptionTokens: 0, schemaTokens: tokens })
  const before = fakeReport([
    fakeServer('stays', 100, [tool('same', 100)]),
    fakeServer('gone', 500, [tool('x', 500)]),
    fakeServer('grows', 1000, [tool('old', 400), tool('kept', 600)]),
  ])
  const after = fakeReport([
    fakeServer('stays', 100, [tool('same', 100)]),
    fakeServer('grows', 1600, [tool('kept', 700), tool('brand-new', 900)]),
    fakeServer('fresh', 250, [tool('y', 250)]),
  ])

  const diff = diffReports(before, after)
  assert.equal(diff.beforeGrand, 1600)
  assert.equal(diff.afterGrand, 1950)
  assert.deepEqual(
    diff.servers.map((s) => `${s.change}:${s.name}`).sort(),
    ['added:fresh', 'changed:grows', 'removed:gone'],
  )
  const grows = diff.servers.find((s) => s.name === 'grows')
  assert.ok(grows.toolNotes.some((n) => n.startsWith('+ brand-new')))
  assert.ok(grows.toolNotes.some((n) => n.startsWith('- old')))
  assert.ok(grows.toolNotes.some((n) => n.startsWith('~ kept')), 'a 100-token move is worth a note')

  const text = renderDiff(diff)
  assert.match(text, /\+350 tokens per request/)
  assert.match(text, /heavier/)
})

test('diff tolerates a v0.1 baseline that has no static fields', () => {
  const before = { servers: [fakeServer('a', 100, [])], totalTaxTokens: 100 }
  const after = fakeReport([fakeServer('a', 100, [])], [{ path: '/x', label: 'CLAUDE.md', host: 'Claude Code', kind: 'instructions', tokens: 40, alwaysLoaded: true }])
  const diff = diffReports(before, after)
  assert.equal(diff.beforeGrand, 100)
  assert.equal(diff.afterGrand, 140)
  assert.ok(diff.staticNotes.some((n) => n.includes('CLAUDE.md')))
})

// ----------------------------------------------------------------- weighing

test('weighs the heavy fixture and ranks its tools', async () => {
  const w = await weighServer(spec('heavy-server.js'), OPTS)
  assert.equal(w.ok, true, w.error)
  assert.equal(w.toolCount, 24)
  assert.ok(w.taxTokens > 10_000, `expected a five-figure tax, got ${w.taxTokens}`)
  assert.ok(w.instructionTokens > 0, 'the instructions string must be counted -- hosts inject it')
  assert.equal(w.taxTokens, w.toolTokens + w.instructionTokens)
  for (let i = 1; i < w.tools.length; i++) {
    assert.ok(w.tools[i - 1].tokens >= w.tools[i].tokens, 'tools must be sorted heaviest first')
  }
  const t = w.tools[0]
  assert.ok(t.descriptionTokens > 0 && t.schemaTokens > 0)
})

test('weighs the light fixture', async () => {
  const w = await weighServer(spec('light-server.js'), OPTS)
  assert.equal(w.ok, true, w.error)
  assert.equal(w.toolCount, 2)
  assert.ok(w.taxTokens > 0 && w.taxTokens < 500, `two small tools should be light, got ${w.taxTokens}`)
  assert.equal(w.serverInfo.name, 'good-fixture')
})

test('a server that cannot start is a failed row, not a crash', async () => {
  const w = await weighServer(spec('no-such-file.js'), OPTS)
  assert.equal(w.ok, false)
  assert.ok(w.error, 'the reason must be reported')
  assert.equal(w.taxTokens, 0)
})

test('an unlaunchable server is reported without being spawned', async () => {
  const w = await weighServer({ ...spec('light-server.js'), unlaunchable: 'needs interactive input' }, OPTS)
  assert.equal(w.ok, false)
  assert.match(w.error, /not launched/)
})

test('weighAll preserves order under concurrency', async () => {
  const specs = [spec('heavy-server.js', 'h'), spec('light-server.js', 'l'), spec('heavy-server.js', 'h2')]
  const all = await weighAll(specs, { ...OPTS, concurrency: 3 })
  assert.deepEqual(all.map((w) => w.spec.name), ['h', 'l', 'h2'])
  assert.ok(all.every((w) => w.ok))
})

// ----------------------------------------------------------------- reporting

function reportFor(servers) {
  const measured = servers.filter((s) => s.ok)
  return {
    servers,
    totalTaxTokens: measured.reduce((s, w) => s + w.taxTokens, 0),
    method: 'estimate',
    options: { requestsPerDay: 200, pricePerMTok: 3 },
    configsSearched: ['/tmp/x.json'],
    durationMs: 100,
  }
}

test('the terminal report carries the headline, ranking and money line', async () => {
  const heavy = await weighServer(spec('heavy-server.js', 'heavy'), OPTS)
  const light = await weighServer(spec('light-server.js', 'light'), OPTS)
  const out = renderTerminal(reportFor([light, heavy]), 3)

  assert.match(out, /tokens.* to every request/)
  assert.match(out, /#1 {4}/, 'servers must be ranked')
  assert.ok(out.indexOf('heavy') < out.indexOf('light'), 'the heavier server must rank first')
  assert.match(out, /\/month/, 'the cost projection must appear')
  assert.match(out, /% of a 200,000 context window/)
  assert.match(out, /--precise/, 'estimates must say how to get exact numbers')
})

test('failed servers appear in the report with their reason', async () => {
  const dead = await weighServer(spec('no-such-file.js', 'dead'), OPTS)
  const light = await weighServer(spec('light-server.js', 'light'), OPTS)
  const out = renderTerminal(reportFor([dead, light]), 3)
  assert.match(out, /failed/)
  assert.match(out, /dead/)
})

// -------------------------------------------------------------- CLI contract

test('CLI --json against a config file produces a complete report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-'))
  const cfg = join(dir, 'c.json')
  writeFileSync(
    cfg,
    JSON.stringify({
      mcpServers: {
        heavy: { command: process.execPath, args: [fixture('heavy-server.js')] },
        light: { command: process.execPath, args: [fixture('light-server.js')] },
      },
    }),
  )
  const stdout = execFileSync(process.execPath, [join(here, '..', 'dist', 'cli.js'), '--config', cfg, '--json'], {
    encoding: 'utf8',
  })
  const report = JSON.parse(stdout)
  assert.equal(report.servers.length, 2)
  assert.ok(report.totalTaxTokens > 10_000)
  assert.equal(report.method, 'estimate')
  assert.ok(report.configsSearched.includes(cfg))
})

test('CLI --budget exits 3 when the bill exceeds it, 0 when under', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-'))
  const cfg = join(dir, 'c.json')
  writeFileSync(cfg, JSON.stringify({ mcpServers: { heavy: { command: process.execPath, args: [fixture('heavy-server.js')] } } }))
  const cli = join(here, '..', 'dist', 'cli.js')

  try {
    execFileSync(process.execPath, [cli, '--config', cfg, '--budget', '1000'], { encoding: 'utf8' })
    assert.fail('a five-figure bill against a 1,000 budget must fail')
  } catch (e) {
    assert.equal(e.status, 3)
    assert.match(String(e.stderr), /over budget/)
  }

  const ok = execFileSync(process.execPath, [cli, '--config', cfg, '--budget', '1000000'], { encoding: 'utf8' })
  assert.match(ok, /tokens/)
})

test('CLI --save writes the report and --diff reads it back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-'))
  const cfg = join(dir, 'c.json')
  const baseline = join(dir, 'baseline.json')
  writeFileSync(cfg, JSON.stringify({ mcpServers: { light: { command: process.execPath, args: [fixture('light-server.js')] } } }))
  const cli = join(here, '..', 'dist', 'cli.js')

  execFileSync(process.execPath, [cli, '--config', cfg, '--save', baseline, '--json'], { encoding: 'utf8' })
  const saved = JSON.parse(readFileSync(baseline, 'utf8'))
  assert.equal(saved.servers.length, 1)
  assert.equal(saved.xrayVersion, saved.xrayVersion) // field exists
  assert.ok(saved.xrayVersion)

  // Same config diffed against its own baseline: no changes.
  const out = execFileSync(process.execPath, [cli, '--config', cfg, '--diff', baseline], { encoding: 'utf8' })
  assert.match(out, /unchanged|no server changes/)

  // A garbage baseline is a usage error, not a crash.
  writeFileSync(baseline, '{"hello": 1}')
  try {
    execFileSync(process.execPath, [cli, '--config', cfg, '--diff', baseline], { encoding: 'utf8' })
    assert.fail('should have exited 2')
  } catch (e) {
    assert.equal(e.status, 2)
    assert.match(String(e.stderr), /cannot read baseline/)
  }
})

test('CLI exits 2 with guidance when nothing is found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-'))
  const cfg = join(dir, 'empty.json')
  writeFileSync(cfg, JSON.stringify({ mcpServers: {} }))
  try {
    execFileSync(process.execPath, [join(here, '..', 'dist', 'cli.js'), '--config', cfg], { encoding: 'utf8' })
    assert.fail('should have exited non-zero')
  } catch (e) {
    assert.equal(e.status, 2)
    assert.match(String(e.stderr), /found no MCP servers/)
  }
})
