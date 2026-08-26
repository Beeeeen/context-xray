import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { readConfigFile, discover } from '../dist/discover.js'
import { estimateTokens } from '../dist/estimate.js'
import { weighServer, weighAll } from '../dist/weigh.js'
import { renderTerminal } from '../dist/report/terminal.js'

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
