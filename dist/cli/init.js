"use strict";
/**
 * mcp-gauge init / uninstall
 *
 * init:
 *   - Reads the existing Claude Desktop config
 *   - Replaces all MCP servers with the proxy entry (backing up first)
 *   - Safe to re-run: picks up any newly added servers
 *
 * uninstall:
 *   - Rebuilds the config from the backup + the full launch.json server list,
 *     so servers added after the initial install are not lost
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runInit = runInit;
exports.runUninstall = runUninstall;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const chalk_1 = __importDefault(require("chalk"));
const store_js_1 = require("../store.js");
const PROXY_SERVER_NAME = '__mcp_gauge_proxy__';
function runInit() {
    console.log(chalk_1.default.bold('\n⚡ mcp-gauge init\n'));
    // ── 1. Read existing config ──────────────────────────────────────────────
    let config;
    try {
        config = (0, store_js_1.readClaudeConfig)();
    }
    catch (err) {
        console.error(chalk_1.default.red(`✗ ${err}`));
        process.exit(1);
    }
    const servers = config.mcpServers ?? {};
    const serverNames = Object.keys(servers).filter(n => n !== PROXY_SERVER_NAME);
    // ── 2. Already installed — pick up any newly added servers ───────────────
    if (servers[PROXY_SERVER_NAME]) {
        const existingLaunch = (0, store_js_1.readLaunchConfig)();
        const newServers = serverNames.filter(n => !existingLaunch[n]);
        if (newServers.length === 0) {
            console.log(chalk_1.default.yellow('mcp-gauge is already installed and up to date.'));
            console.log('Run ' + chalk_1.default.cyan('mcp-gauge status') + ' to see your token budget.\n');
            process.exit(0);
        }
        // Add new servers to launch config
        const updatedLaunch = { ...existingLaunch };
        newServers.forEach(name => { updatedLaunch[name] = servers[name]; });
        (0, store_js_1.writeLaunchConfig)(updatedLaunch);
        // Remove the now-proxied servers from mcpServers so they don't appear
        // both directly connected AND via the proxy (which would cause duplicates)
        const updatedConfig = {
            ...config,
            mcpServers: { [PROXY_SERVER_NAME]: servers[PROXY_SERVER_NAME] },
        };
        (0, store_js_1.writeClaudeConfig)(updatedConfig);
        console.log(chalk_1.default.green(`✓ Added ${newServers.length} new server(s) to mcp-gauge:\n`));
        newServers.forEach(name => console.log(`  ${chalk_1.default.dim('•')} ${name}`));
        console.log(`\nRestart Claude Desktop to pick up the new server(s).\n`);
        process.exit(0);
    }
    if (serverNames.length === 0) {
        console.log(chalk_1.default.yellow('No MCP servers found in your Claude Desktop config.'));
        console.log('Add some servers first, then run mcp-gauge init again.\n');
        process.exit(0);
    }
    console.log(`Found ${chalk_1.default.bold(serverNames.length)} MCP server(s):\n`);
    serverNames.forEach(name => console.log(`  ${chalk_1.default.dim('•')} ${name}`));
    console.log();
    // ── 3. Verify mcp-gauge is globally installed ────────────────────────────
    // npx caches packages in a temporary directory that gets cleared automatically.
    // If we bake that path into the Claude config, the proxy stops working when
    // the cache expires. Require a global install instead.
    let gaugeCommand;
    try {
        gaugeCommand = (0, child_process_1.execSync)('which mcp-gauge', { encoding: 'utf-8' }).trim();
    }
    catch {
        console.error(chalk_1.default.red('✗ mcp-gauge must be installed globally to work correctly.\n'));
        console.log('  Running via npx bakes a temporary cache path into your Claude config,');
        console.log('  which breaks the proxy when the cache is cleared.\n');
        console.log('  Install globally first:\n');
        console.log('    ' + chalk_1.default.cyan('npm install -g mcp-gauge') + '\n');
        console.log('  Then run: ' + chalk_1.default.cyan('mcp-gauge init') + '\n');
        process.exit(1);
    }
    // ── 4. Backup original config ────────────────────────────────────────────
    (0, store_js_1.backupClaudeConfig)();
    console.log(chalk_1.default.dim(`✓ Backed up original config to ~/.mcp-gauge/claude_config_backup.json`));
    // ── 5. Write launch config (upstream server list, read by proxy at start) ─
    const upstreamConfigs = {};
    serverNames.forEach(name => { upstreamConfigs[name] = servers[name]; });
    (0, store_js_1.writeLaunchConfig)(upstreamConfigs);
    // ── 6. Rewrite config — merge so other top-level keys are preserved ───────
    const proxyEntry = {
        command: gaugeCommand,
        args: ['proxy'],
    };
    const newConfig = {
        ...config, // preserves globalShortcut, theme, etc.
        mcpServers: {
            [PROXY_SERVER_NAME]: proxyEntry,
        },
    };
    (0, store_js_1.writeClaudeConfig)(newConfig);
    // ── 7. Done ───────────────────────────────────────────────────────────────
    console.log(chalk_1.default.green('\n✓ mcp-gauge installed successfully!\n'));
    console.log('What happens next:');
    console.log(`  1. ${chalk_1.default.bold('Restart Claude Desktop')} — the proxy starts automatically`);
    console.log(`  2. Run ${chalk_1.default.cyan('mcp-gauge status')} to find your dashboard URL`);
    console.log(`  3. Disable unused tools with one click\n`);
    console.log(chalk_1.default.dim(`To add new servers later: add them in Claude Desktop, then re-run ${chalk_1.default.white('mcp-gauge init')}`));
    console.log(chalk_1.default.dim(`To uninstall: ${chalk_1.default.white('mcp-gauge uninstall')}\n`));
}
function runUninstall() {
    console.log(chalk_1.default.bold('\nmcp-gauge uninstall\n'));
    const backupPath = path_1.default.join(process.env.HOME ?? '~', '.mcp-gauge', 'claude_config_backup.json');
    if (!fs_1.default.existsSync(backupPath)) {
        console.error(chalk_1.default.red('✗ No backup found. Cannot restore original config.'));
        process.exit(1);
    }
    // Rebuild from backup + full launch.json server list.
    // The backup only has servers that existed at init time; launch.json has
    // everything including servers added later via `mcp-gauge init` re-runs.
    // Using launch.json ensures servers added after the initial install survive.
    let backup;
    try {
        backup = JSON.parse(fs_1.default.readFileSync(backupPath, 'utf-8'));
    }
    catch {
        console.error(chalk_1.default.red('✗ Backup file is corrupt. Cannot restore.'));
        process.exit(1);
    }
    const allServers = (0, store_js_1.readLaunchConfig)();
    const restored = {
        ...backup,
        mcpServers: Object.keys(allServers).length > 0
            ? allServers
            : backup.mcpServers, // fall back to backup if launch.json is missing/empty
    };
    fs_1.default.writeFileSync((0, store_js_1.getClaudeConfigPath)(), JSON.stringify(restored, null, 2), 'utf-8');
    console.log(chalk_1.default.green('✓ Restored original Claude Desktop config.'));
    console.log('Restart Claude Desktop to reconnect directly to your MCP servers.\n');
}
