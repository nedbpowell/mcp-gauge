#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const init_js_1 = require("./cli/init.js");
const proxy_js_1 = require("./proxy/proxy.js");
const server_js_1 = require("./dashboard/server.js");
const store_js_1 = require("./store.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json');
commander_1.program
    .name('mcp-gauge')
    .description('See exactly which MCP tools are eating your context window.')
    .version(version);
// ── mcp-gauge init ─────────────────────────────────────────────────────────────
commander_1.program
    .command('init')
    .description('Install mcp-gauge into your Claude Desktop config')
    .action(() => {
    (0, init_js_1.runInit)();
});
// ── mcp-gauge uninstall ───────────────────────────────────────────────────────
commander_1.program
    .command('uninstall')
    .description('Remove mcp-gauge and restore your original Claude Desktop config')
    .action(() => {
    (0, init_js_1.runUninstall)();
});
// ── mcp-gauge proxy ───────────────────────────────────────────────────────────
// This is what Claude Code actually launches (not called by users directly)
commander_1.program
    .command('proxy')
    .description('Start the MCP proxy (launched automatically by Claude Code)')
    .option('--port <number>', 'Dashboard port (default: 3456, falls back to OS-assigned)')
    .action(async (opts) => {
    const upstreamConfigs = (0, store_js_1.readLaunchConfig)();
    if (Object.keys(upstreamConfigs).length === 0) {
        process.stderr.write('[mcp-gauge] No server configs found in ~/.mcp-gauge/launch.json\n');
        process.exit(1);
    }
    const preferredPort = opts.port ? parseInt(opts.port, 10) : 3456;
    // Start the dashboard HTTP server in the same process
    // (it runs alongside the stdio proxy without conflict)
    await (0, server_js_1.startDashboard)(preferredPort);
    // Start the MCP proxy — this blocks, communicating over stdio
    await (0, proxy_js_1.startProxy)(upstreamConfigs);
});
// ── mcp-gauge status ──────────────────────────────────────────────────────────
commander_1.program
    .command('status')
    .description('Print current token budget to the terminal')
    .action(async () => {
    const port = (0, store_js_1.readPort)();
    const res = await fetch(`http://localhost:${port}/api/state`).catch(() => null);
    if (!res) {
        console.error('mcp-gauge proxy is not running. Start Claude Code first.');
        process.exit(1);
    }
    const state = await res.json();
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
commander_1.program.parse();
