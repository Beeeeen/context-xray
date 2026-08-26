# context-xray

**See what your MCP servers cost you — before you type a word.**

[![CI](https://github.com/Beeeeen/context-xray/actions/workflows/ci.yml/badge.svg)](https://github.com/Beeeeen/context-xray/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/context-xray.svg)](https://www.npmjs.com/package/context-xray)
[![license](https://img.shields.io/npm/l/context-xray.svg)](./LICENSE)

```bash
npx context-xray
```

Every MCP server you configure injects its full tool catalog — every name, every description, every JSON schema — into **every single request** your agent makes. You never see this. It happens before your first word, it is resent on every message, and it never shows up itemised on a bill.

context-xray finds every server configured in Claude Desktop, Claude Code, Cursor, Windsurf and VS Code, connects to each one, and weighs exactly what it charges you:

```
  context-xray  your MCP servers add ~14,443 tokens to every request
  1 config searched, 4 servers found, 4 measured

  rank  server                host               tools    tokens  share
  #1    github                Claude Code           26    ~5,123    35%  ######............
  #2    playwright            Claude Code           24    ~4,785    33%  ######............
  #3    filesystem            Claude Desktop        14    ~2,333    16%  ###...............
  #4    everything            Claude Desktop        16    ~2,202    15%  ###...............

  github  github-mcp-server v0.6.2  26 tools, connected in 3523ms
         513 tok  create_pull_request_review                desc 8, schema 482
         326 tok  list_pull_requests                        desc 10, schema 296
         292 tok  create_pull_request                       desc 11, schema 259
       3,992 tok  … 23 more tools

  playwright  Playwright v1.63.0  24 tools, connected in 3900ms
         429 tok  browser_take_screenshot                   desc 31, schema 376
         324 tok  browser_fill_form                         desc 6, schema 297
       4,032 tok  … 22 more tools

  ------------------------------------------------------------------------
  ~14,443 tokens on every request = 7.2% of a 200,000 context window, before you type a word
  at 200 requests/day and $3.00/MTok input: ~$260/month of uncached input spend

  ! over 10% of the window goes to tool definitions -- disable the servers
    you are not using today
```

Those are real numbers from real servers — that four-server setup is a perfectly ordinary one, and it spends 7% of the context window on standby.

No install, no config, no account, zero dependencies. It reads the configs you already have.

---

## Why this matters

**Context.** The context window is the scarcest resource an agent has. Tool definitions are pure overhead: they crowd out your conversation, your files, your actual work. Long sessions degrade sooner, and "compact" happens earlier, in direct proportion to this number. Most people have never seen it.

**Money.** Input tokens are billed per request. A 14k-token tool catalog at a few hundred requests a day is real spend — caching softens it but does not erase it, and cache writes bill at a premium. The table above is the line item your invoice never shows.

**Model quality.** Models pick tools by reading their descriptions. A 24-tool server whose every schema looks alike does not just cost tokens — it measurably degrades tool selection. The heaviest tools in the ranking are usually also the ones confusing your agent.

## Usage

```bash
# find and weigh everything configured on this machine
npx context-xray

# just one host's config, or one server
npx context-xray --config ~/.claude.json
npx context-xray --server github,playwright

# weigh a server that is not configured anywhere yet
npx context-xray -- npx -y @playwright/mcp@latest
npx context-xray --url http://localhost:3000/mcp
```

| flag | |
|---|---|
| `--precise` | exact counts via the free Anthropic `count_tokens` API (needs `ANTHROPIC_API_KEY`) |
| `--json` | machine-readable report |
| `--requests-per-day <n>` | volume assumption for the cost line (default 200) |
| `--price <usd>` | $/MTok input for the cost line (default 3.00) |
| `--top <n>` | tools listed per server (default 3) |
| `--timeout <ms>` | per-server timeout (default 15000) |

Configs it knows how to read: Claude Desktop, Claude Code (`~/.claude.json`, per-project entries, and `./.mcp.json`), Cursor, Windsurf, and VS Code (both the `mcpServers` and `servers` shapes, including `${input:...}` entries — those are reported as unmeasurable rather than silently skipped). A server configured in several hosts is measured once and attributed to all of them.

## Exact numbers

By default the token counts are estimates from a tokenizer-calibrated character model (JSON weighs heavier than prose, and is marked `~`). For exact numbers:

```bash
ANTHROPIC_API_KEY=sk-... npx context-xray --precise
```

This uses the Anthropic [count_tokens](https://docs.anthropic.com/en/api/messages-count-tokens) endpoint, which is free of charge. Only the tool definitions being counted are sent — never your conversation, never your files.

## What it does and does not do

- It connects, performs the MCP handshake, reads the tool/resource/prompt lists, and disconnects. **It never invokes a tool.**
- Environment values in your configs are passed to the servers they belong to, and are **never printed or transmitted**.
- Servers that fail to start are reported with the reason (and their stderr), not skipped — a server that cannot start is costing you a different way.
- The measured tax covers what hosts inject per request: tool definitions plus server `instructions`. Resources and prompts are listed for information but are not part of the per-request tax.

## Programmatic use

```ts
import { discover, weighAll } from 'context-xray'

const { specs } = discover()
const weights = await weighAll(specs, {
  timeoutMs: 15000, precise: false, requestsPerDay: 200,
  pricePerMTok: 3, top: 3, concurrency: 4,
})
for (const w of weights) console.log(w.spec.name, w.taxTokens)
```

## See also

[**mcp-probe**](https://github.com/Beeeeen/mcp-probe) — the other half of this toolchain: conformance and robustness tests for MCP servers, built to run in CI. context-xray tells you what a server *costs*; mcp-probe tells you whether it *works*.

## License

MIT
