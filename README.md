# mcp-gauge ⚡

**See exactly which MCP tools are eating your context window. Disable the deadweight.**

MCP tool definitions load into your client context window before any work happens. With a few servers connected, you can burn 30–70% of your context window on tools you've never even called.

mcp-gauge sits between Claude Desktop or Codex and your MCP servers, measures every tool's token cost, tracks which ones you actually use, and lets you disable the rest — live, with one click.

## Install

### Claude Desktop

```bash
npm install -g mcp-gauge
mcp-gauge init
```

Restart Claude Desktop, then run `mcp-gauge status` to get your dashboard URL.

### Codex

If global npm installs work on your machine:

```bash
npm install -g mcp-gauge
mcp-gauge init --client codex
```

If `npm install -g` fails with permissions errors, or `mcp-gauge` is not found after install, use a user-local npm prefix:

```bash
mkdir -p ~/.npm-global ~/.npm-cache
npm config set prefix ~/.npm-global
npm install -g --cache ~/.npm-cache mcp-gauge
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
mcp-gauge init --client codex
```

Restart Codex, then run `mcp-gauge status --client codex` to get your dashboard URL.

> **Why global install?** mcp-gauge rewrites your client config to point at the proxy binary. If the binary path changes (e.g. npx cache cleared), your MCP access can break silently. A global install keeps the path stable.

## What you'll see

```
⚡ Token Budget: 17,400 / 200,000 (8.7% used by tools)
   Saved: 6,200 tokens by disabling unused tools

  github
    ✓ search_code                              840 tokens  (called 47x)
    ⚠ list_branches                            320 tokens  (never called)
    ✗ get_file_contents                        510 tokens  (disabled)
  slack
    ✓ send_message                             680 tokens  (called 12x)
    ⚠ list_channels                          1,200 tokens  (never called)
```

For Codex, mcp-gauge also summarizes your local Codex session logs:

```text
Codex Usage (7d)
  Sessions: 22 (22 with token data)
  Tokens: 117,592,599 total, 117,070,096 input, 522,503 output
  Latest context: 35% used
  Rate limits: primary 73%, secondary 27%
  Top projects:
    mcp-gauge                            11,264,531 tokens · 1 sessions
  Failure hotspots:
    mcp-gauge                    exec_command       12 failed
  Suggestions:
    - mcp-gauge has repeated exec_command failures; give an exact repo path, ask Codex to inspect first, or narrow the task.
```

## Commands

```bash
mcp-gauge init                  # Install into Claude Desktop by default
mcp-gauge init --client codex   # Install into Codex
mcp-gauge status                # Print token budget + dashboard URL in terminal
mcp-gauge status --client codex # Print MCP budget plus compact Codex usage
mcp-gauge codex-usage --days 7  # Detailed Codex usage report from local logs
mcp-gauge uninstall             # Restore your original Claude Desktop config
mcp-gauge uninstall --client codex
```

## How it works

mcp-gauge installs itself as a single MCP proxy server in your Claude Desktop or Codex config. When the client starts, it connects to the proxy instead of your real servers directly. The proxy:

1. Spawns all your real MCP servers as normal
2. Measures each tool definition's token cost
3. Filters out tools you've disabled before returning the list to Claude
4. Logs every tool call so you know what's actually being used
5. Serves a local dashboard with live updates

Your real servers run exactly as before. mcp-gauge adds zero latency to tool calls (it's local stdio, not a network hop).

## Codex usage tracking

Codex support has two parts:

- **MCP proxy tracking:** local stdio MCP servers are proxied, measured, and can be disabled from the dashboard.
- **Codex log insights:** local Codex session logs are read retrospectively to show token usage, context pressure, rate-limit pressure, top projects, expensive sessions, failed tool-call hotspots, and suggestions.

Codex usage tracking works even with zero MCP servers installed. In that case, `mcp-gauge status --client codex` still reports Codex usage from local logs, and the dashboard shows the Codex Usage section.

This log-based view is read-only and retrospective. It cannot disable built-in Codex tools, app tools, or plugin tools; only proxied MCP tools can be toggled by mcp-gauge.

## Adding new MCP servers

After installing mcp-gauge, add the new server in Claude Desktop's settings as usual, then run:

```bash
mcp-gauge init
```

mcp-gauge detects the new server, routes it through the proxy, and removes it from the direct connection so tools don't appear twice. Restart Claude Desktop to apply.

For Codex, add local stdio MCP servers to `~/.codex/config.toml`, then run:

```bash
mcp-gauge init --client codex
```

Codex HTTP MCP servers are left untouched because mcp-gauge currently proxies local stdio servers.

## Disabling tools

Toggle tools on/off in the dashboard. Changes are saved immediately but **take effect after restarting your MCP client** — the dashboard shows a notice when a restart is needed.

## Uninstall

```bash
mcp-gauge uninstall
```

Restores your Claude Desktop config with all servers you've ever added through mcp-gauge — including ones added after the initial install. Restart Claude Desktop to reconnect directly.

For Codex:

```bash
mcp-gauge uninstall --client codex
```

## Privacy

Everything stays on your machine. No telemetry, no cloud, no accounts.

## License

MIT
