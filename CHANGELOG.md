# Changelog

## 0.2.0 — 2026-08-27

The whole context bill, not just MCP:

- **Agent files weighed.** CLAUDE.md (global/project/local), AGENTS.md, GEMINI.md,
  `.cursorrules`, `.cursor/rules/*.mdc` (glob-scoped rules listed but not
  counted, because that is how they load), `.windsurfrules`,
  `.github/copilot-instructions.md`, and the Claude Code skills listing
  (name+description counted per request; bodies shown as load-on-demand).
  Skip with `--no-static`.
- **Five new hosts discovered:** Zed (`context_servers`, nested `command`
  object), Cline, Roo Code, Gemini CLI (incl. `httpUrl` remotes), and Codex
  CLI (`~/.codex/config.toml`, via a built-in TOML subset reader — still zero
  dependencies).
- **`--budget <tokens>`** exits 3 when the per-request total crosses the line:
  a one-flag CI gate.
- **`--diff <file>`** compares against a saved report: servers added/removed,
  tools that appeared or got heavier, instruction files that grew.
  **`--save <file>`** writes the baseline. v0.1 baselines are accepted.
- Report totals now split MCP vs agent files; JSON reports carry
  `staticFiles`, `staticTokens`, `grandTotalTokens`, and `xrayVersion`.

## 0.1.0 — 2026-08-26

Initial release: discover MCP servers across Claude Desktop, Claude Code,
Cursor, Windsurf, VS Code; weigh every tool definition; `--precise` counting
via the free Anthropic `count_tokens` endpoint; cost projection.
