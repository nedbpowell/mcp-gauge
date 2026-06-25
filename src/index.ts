#!/usr/bin/env node

import { program } from 'commander';
import { runInit, runUninstall } from './cli/init.js';
import { startProxy } from './proxy/proxy.js';
import { startDashboard } from './dashboard/server.js';
import { readLaunchConfig, readPort } from './store.js';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json') as { version: string };

program
  .name('mcp-gauge')
  .description('See exactly which MCP tools are eating your context window.')
  .version(version);

// ── mcp-gauge init ─────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Install mcp-gauge into your Claude Desktop config')
  .action(() => {
    runInit();
  });

// ── mcp-gauge uninstall ───────────────────────────────────────────────────────
program
  .command('uninstall')
  .description('Remove mcp-gauge and restore your original Claude Desktop config')
  .action(() => {
    runUninstall();
  });

// ── mcp-gauge proxy ───────────────────────────────────────────────────────────
// This is what Claude Code actually launches (not called by users directly)
program
  .command('proxy')
  .description('Start the MCP proxy (launched automatically by Claude Code)')
  .option('--port <number>', 'Dashboard port (default: 3456, falls back to OS-assigned)')
  .action(async (opts: { port?: string }) => {
    const upstreamConfigs = readLaunchConfig();

    if (Object.keys(upstreamConfigs).length === 0) {
      process.stderr.write('[mcp-gauge] No server configs found in ~/.mcp-gauge/launch.json\n');
      process.exit(1);
    }

    const preferredPort = opts.port ? parseInt(opts.port, 10) : 3456;

    // Start the dashboard HTTP server in the same process
    // (it runs alongside the stdio proxy without conflict)
    await startDashboard(preferredPort);

    // Start the MCP proxy — this blocks, communicating over stdio
    await startProxy(upstreamConfigs);
  });

// ── mcp-gauge status ──────────────────────────────────────────────────────────
program
  .command('status')
  .description('Print current token budget to the terminal')
  .action(async () => {
    const port = readPort();
    const res = await fetch(`http://localhost:${port}/api/state`).catch(() => null);
    if (!res) {
      console.error('mcp-gauge proxy is not running. Start Claude Code first.');
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
    console.log(`\n  Open http://localhost:${port} for the full dashboard\n`);
  });

program.parse();
