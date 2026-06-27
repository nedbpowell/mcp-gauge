#!/usr/bin/env node

import { program } from 'commander';
import { createRequire } from 'module';
import { runInit, runUninstall } from './cli/init.js';
import { startProxy } from './proxy/proxy.js';
import { startDashboard } from './dashboard/server.js';
import { readLaunchConfig, readPort } from './store.js';
import { ClientName } from './types.js';
import { formatCodexUsageSummary, getCodexUsageSummary } from './codex/usage.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

program
  .name('mcp-gauge')
  .description('See exactly which MCP tools are eating your context window.')
  .version(version);

// ── mcp-gauge init ─────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Install mcp-gauge into your Claude Desktop or Codex config')
  .option('--client <client>', 'Target client: claude or codex')
  .action((opts: { client?: ClientName }) => {
    runInit(parseClientOption(opts.client));
  });

// ── mcp-gauge uninstall ───────────────────────────────────────────────────────
program
  .command('uninstall')
  .description('Remove mcp-gauge and restore your original client config')
  .option('--client <client>', 'Target client: claude or codex')
  .action((opts: { client?: ClientName }) => {
    runUninstall(parseClientOption(opts.client));
  });

// ── mcp-gauge proxy ───────────────────────────────────────────────────────────
// This is what Claude Code actually launches (not called by users directly)
program
  .command('proxy')
  .description('Start the MCP proxy (launched automatically by your MCP client)')
  .option('--port <number>', 'Dashboard port (default: 3456, falls back to OS-assigned)')
  .option('--client <client>', 'Client state to use: claude or codex')
  .action(async (opts: { port?: string; client?: ClientName }) => {
    const client = parseClientOption(opts.client) ?? 'claude';
    const upstreamConfigs = readLaunchConfig(client);

    if (Object.keys(upstreamConfigs).length === 0 && client !== 'codex') {
      process.stderr.write('[mcp-gauge] No server configs found in ~/.mcp-gauge/launch.json\n');
      process.exit(1);
    }

    const preferredPort = opts.port ? parseInt(opts.port, 10) : 3456;

    // Start the dashboard HTTP server in the same process
    // (it runs alongside the stdio proxy without conflict)
    await startDashboard(preferredPort, client);

    // Start the MCP proxy — this blocks, communicating over stdio
    await startProxy(upstreamConfigs, client);
  });

// ── mcp-gauge status ──────────────────────────────────────────────────────────
program
  .command('status')
  .description('Print current token budget to the terminal')
  .option('--client <client>', 'Client state to use: claude or codex')
  .action(async (opts: { client?: ClientName }) => {
    const client = parseClientOption(opts.client) ?? 'claude';
    const port = readPort(client);
    const res = await fetch(`http://localhost:${port}/api/state`).catch(() => null);
    if (!res) {
      if (client === 'codex') {
        const usage = await getCodexUsageSummary();
        console.log();
        console.log(formatCodexUsageSummary(usage));
        console.log('\n  MCP proxy is not running, so only Codex log usage is shown.\n');
        return;
      }
      console.error('mcp-gauge proxy is not running. Start your MCP client first.');
      process.exit(1);
    }
    const state = await res.json() as {
      activeTokens: number;
      savedTokens: number;
      modelLimit: number;
      servers: Array<{
        name: string;
        tools: Array<{ name: string; tokenCost: number; disabled: boolean; totalCallCount: number }>;
      }>;
    };

    const pct = Math.round((state.activeTokens / state.modelLimit) * 100);
    console.log(`\n⚡ Token Budget: ${state.activeTokens.toLocaleString()} / ${state.modelLimit.toLocaleString()} (${pct}% used by tools)`);
    console.log(`   Saved: ${state.savedTokens.toLocaleString()} tokens by disabling unused tools\n`);

    for (const server of state.servers) {
      console.log(`  ${server.name}`);
      for (const tool of server.tools) {
        const status = tool.disabled ? '✗' : tool.totalCallCount === 0 ? '⚠' : '✓';
        console.log(`    ${status} ${tool.name.padEnd(40)} ${tool.tokenCost.toString().padStart(5)} tokens`);
      }
    }
    if (client === 'codex') {
      const usage = await getCodexUsageSummary();
      console.log();
      console.log(formatCodexUsageSummary(usage));
    }
    console.log(`\n  Open http://localhost:${port} for the full dashboard\n`);
  });

// ── mcp-gauge codex-usage ────────────────────────────────────────────────────
program
  .command('codex-usage')
  .description('Summarize Codex model and tool usage from local session logs')
  .option('--days <number>', 'Days of Codex logs to scan (default: 7)')
  .option('--cwd <path>', 'Only include sessions from this exact cwd')
  .option('--json', 'Print machine-readable JSON')
  .action(async (opts: { days?: string; cwd?: string; json?: boolean }) => {
    const usage = await getCodexUsageSummary({
      days: opts.days ? parsePositiveInt(opts.days, '--days') : undefined,
      cwd: opts.cwd,
    });

    if (opts.json) {
      console.log(JSON.stringify(usage, null, 2));
      return;
    }

    console.log();
    console.log(formatCodexUsageSummary(usage));
    console.log();
  });

program.parse();

function parseClientOption(client?: string): ClientName | undefined {
  if (client === undefined) return undefined;
  if (client === 'claude' || client === 'codex') return client;

  console.error(`Unknown client: ${client}. Expected "claude" or "codex".`);
  process.exit(1);
}

function parsePositiveInt(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`${optionName} must be a positive integer.`);
    process.exit(1);
  }
  return parsed;
}
