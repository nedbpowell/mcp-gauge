# mcp-gauge ⚡

**See exactly which MCP tools are eating your context window. Disable the deadweight.**

MCP tool definitions load into Claude's context window before any work happens. With a few servers connected, you can burn 30–70% of your context window on tools you've never even called.

mcp-gauge sits between Claude Desktop and your MCP servers, measures every tool's token cost, tracks which ones you actually use, and lets you disable the rest — live, with one click.

## Install

```bash
npm install -g mcp-gauge
mcp-gauge init
```

Restart Claude Desktop, then run `mcp-gauge status` to get your dashboard URL.

> **Why global install?** mcp-gauge rewrites your Claude Desktop config to point at the proxy binary. If the binary path changes (e.g. npx cache cleared), Claude Desktop loses all MCP access silently. A global install keeps the path stable.

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

## Commands

```bash
mcp-gauge init        # Install (rewrites your Claude Desktop config)
mcp-gauge status      # Print token budget + dashboard URL in terminal
mcp-gauge uninstall   # Restore your original Claude Desktop config
```

## How it works

mcp-gauge installs itself as a single MCP proxy server in your Claude Desktop config. When Claude Desktop starts, it connects to the proxy instead of your real servers directly. The proxy:

1. Spawns all your real MCP servers as normal
2. Measures each tool definition's token cost
3. Filters out tools you've disabled before returning the list to Claude
4. Logs every tool call so you know what's actually being used
5. Serves a local dashboard with live updates

Your real servers run exactly as before. mcp-gauge adds zero latency to tool calls (it's local stdio, not a network hop).

## Adding new MCP servers

After installing mcp-gauge, add the new server in Claude Desktop's settings as usual, then run:

```bash
mcp-gauge init
```

mcp-gauge detects the new server, routes it through the proxy, and removes it from the direct connection so tools don't appear twice. Restart Claude Desktop to apply.

## Disabling tools

Toggle tools on/off in the dashboard. Changes are saved immediately but **take effect after restarting Claude Desktop** — the dashboard shows a notice when a restart is needed.

## Uninstall

```bash
mcp-gauge uninstall
```

Restores your Claude Desktop config with all servers you've ever added through mcp-gauge — including ones added after the initial install. Restart Claude Desktop to reconnect directly.

## Privacy

Everything stays on your machine. No telemetry, no cloud, no accounts.

## License

MIT
