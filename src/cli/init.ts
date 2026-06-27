/**
 * mcp-gauge init / uninstall
 *
 * init:
 *   - Reads the existing client config
 *   - Replaces all MCP servers with the proxy entry (backing up first)
 *   - Safe to re-run: picks up any newly added servers
 *
 * uninstall:
 *   - Rebuilds the config from the backup + the full launch.json server list,
 *     so servers added after the initial install are not lost
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import {
  backupCodexConfig,
  readClaudeConfig,
  readCodexConfigText,
  readCodexStdioServers,
  writeClaudeConfig,
  writeCodexConfigText,
  backupClaudeConfig,
  getCodexBackupPath,
  getClaudeConfigPath,
  getCodexConfigPath,
  readCodexBackupText,
  readLaunchConfig,
  restoreCodexMcpServers,
  rewriteCodexMcpServers,
  writeLaunchConfig,
} from '../store.js';
import { ClaudeConfig, ClientName, ServerConfig } from '../types.js';

const PROXY_SERVER_NAME = '__mcp_gauge_proxy__';

export function runInit(client: ClientName = detectClient()): void {
  console.log(chalk.bold('\n⚡ mcp-gauge init\n'));
  if (client === 'codex') {
    runCodexInit();
    return;
  }
  runClaudeInit();
}

function runClaudeInit(): void {
  // ── 1. Read existing config ──────────────────────────────────────────────
  let config: ClaudeConfig;
  try {
    config = readClaudeConfig();
  } catch (err) {
    console.error(chalk.red(`✗ ${err}`));
    process.exit(1);
  }

  const servers = config.mcpServers ?? {};
  const serverNames = Object.keys(servers).filter(n => n !== PROXY_SERVER_NAME);

  // ── 2. Already installed — pick up any newly added servers ───────────────
  if (servers[PROXY_SERVER_NAME]) {
    const existingLaunch = readLaunchConfig();
    const newServers = serverNames.filter(n => !existingLaunch[n]);

    if (newServers.length === 0) {
      console.log(chalk.yellow('mcp-gauge is already installed and up to date.'));
      console.log('Run ' + chalk.cyan('mcp-gauge status') + ' to see your token budget.\n');
      process.exit(0);
    }

    // Add new servers to launch config
    const updatedLaunch: Record<string, ServerConfig> = { ...existingLaunch };
    newServers.forEach(name => { updatedLaunch[name] = servers[name]; });
    writeLaunchConfig(updatedLaunch);

    // Remove the now-proxied servers from mcpServers so they don't appear
    // both directly connected AND via the proxy (which would cause duplicates)
    const updatedConfig: ClaudeConfig = {
      ...config,
      mcpServers: { [PROXY_SERVER_NAME]: servers[PROXY_SERVER_NAME] },
    };
    writeClaudeConfig(updatedConfig);

    console.log(chalk.green(`✓ Added ${newServers.length} new server(s) to mcp-gauge:\n`));
    newServers.forEach(name => console.log(`  ${chalk.dim('•')} ${name}`));
    console.log(`\nRestart Claude Desktop to pick up the new server(s).\n`);
    process.exit(0);
  }

  if (serverNames.length === 0) {
    console.log(chalk.yellow('No MCP servers found in your Claude Desktop config.'));
    console.log('Add some servers first, then run mcp-gauge init again.\n');
    process.exit(0);
  }

  console.log(`Found ${chalk.bold(serverNames.length)} MCP server(s):\n`);
  serverNames.forEach(name => console.log(`  ${chalk.dim('•')} ${name}`));
  console.log();

  // ── 3. Verify mcp-gauge is globally installed ────────────────────────────
  // npx caches packages in a temporary directory that gets cleared automatically.
  // If we bake that path into the Claude config, the proxy stops working when
  // the cache expires. Require a global install instead.
  let gaugeCommand: string;
  try {
    gaugeCommand = execSync('which mcp-gauge', { encoding: 'utf-8' }).trim();
  } catch {
    console.error(chalk.red('✗ mcp-gauge must be installed globally to work correctly.\n'));
    console.log('  Running via npx bakes a temporary cache path into your Claude config,');
    console.log('  which breaks the proxy when the cache is cleared.\n');
    console.log('  Install globally first:\n');
    console.log('    ' + chalk.cyan('npm install -g mcp-gauge') + '\n');
    console.log('  Then run: ' + chalk.cyan('mcp-gauge init') + '\n');
    process.exit(1);
  }

  // ── 4. Backup original config ────────────────────────────────────────────
  backupClaudeConfig();
  console.log(chalk.dim(`✓ Backed up original config to ~/.mcp-gauge/claude_config_backup.json`));

  // ── 5. Write launch config (upstream server list, read by proxy at start) ─
  const upstreamConfigs: Record<string, ServerConfig> = {};
  serverNames.forEach(name => { upstreamConfigs[name] = servers[name]; });
  writeLaunchConfig(upstreamConfigs);

  // ── 6. Rewrite config — merge so other top-level keys are preserved ───────
  const proxyEntry: ServerConfig = {
    command: gaugeCommand,
    args: ['proxy'],
  };

  const newConfig: ClaudeConfig = {
    ...config,                       // preserves globalShortcut, theme, etc.
    mcpServers: {
      [PROXY_SERVER_NAME]: proxyEntry,
    },
  };

  writeClaudeConfig(newConfig);

  // ── 7. Done ───────────────────────────────────────────────────────────────
  console.log(chalk.green('\n✓ mcp-gauge installed successfully!\n'));
  console.log('What happens next:');
  console.log(`  1. ${chalk.bold('Restart Claude Desktop')} — the proxy starts automatically`);
  console.log(`  2. Run ${chalk.cyan('mcp-gauge status')} to find your dashboard URL`);
  console.log(`  3. Disable unused tools with one click\n`);
  console.log(chalk.dim(`To add new servers later: add them in Claude Desktop, then re-run ${chalk.white('mcp-gauge init')}`));
  console.log(chalk.dim(`To uninstall: ${chalk.white('mcp-gauge uninstall')}\n`));
}

function runCodexInit(): void {
  let configText: string;
  try {
    configText = readCodexConfigText();
  } catch (err) {
    console.error(chalk.red(`✗ ${err}`));
    process.exit(1);
  }

  const servers = readCodexStdioServers(configText);
  const serverNames = Object.keys(servers).filter(n => n !== PROXY_SERVER_NAME);

  if (servers[PROXY_SERVER_NAME]) {
    const existingLaunch = readLaunchConfig('codex');
    const newServers = serverNames.filter(n => !existingLaunch[n]);
    const proxyEntry: ServerConfig = {
      ...servers[PROXY_SERVER_NAME],
      args: ['proxy', '--client', 'codex'],
    };

    if (newServers.length === 0) {
      writeLaunchConfig(existingLaunch, 'codex');
      writeCodexConfigText(rewriteCodexMcpServers(configText, [], proxyEntry));
      console.log(chalk.yellow('mcp-gauge is already installed and up to date.'));
      console.log('Run ' + chalk.cyan('mcp-gauge status --client codex') + ' to see your token budget.\n');
      process.exit(0);
    }

    const updatedLaunch: Record<string, ServerConfig> = { ...existingLaunch };
    newServers.forEach(name => { updatedLaunch[name] = servers[name]; });
    writeLaunchConfig(updatedLaunch, 'codex');

    writeCodexConfigText(rewriteCodexMcpServers(configText, newServers, proxyEntry));

    console.log(chalk.green(`✓ Added ${newServers.length} new server(s) to mcp-gauge:\n`));
    newServers.forEach(name => console.log(`  ${chalk.dim('•')} ${name}`));
    console.log(`\nRestart Codex to pick up the new server(s).\n`);
    process.exit(0);
  }

  if (serverNames.length === 0) {
    console.log(chalk.yellow('No local MCP servers found in your Codex config.'));
    console.log('Installing mcp-gauge for Codex usage tracking only.\n');
  } else {
    console.log(`Found ${chalk.bold(serverNames.length)} local MCP server(s):\n`);
    serverNames.forEach(name => console.log(`  ${chalk.dim('•')} ${name}`));
    console.log();
  }

  const gaugeCommand = findGlobalGaugeCommand('Codex config');

  backupCodexConfig();
  console.log(chalk.dim(`✓ Backed up original config to ~/.mcp-gauge/codex_config_backup.toml`));

  const upstreamConfigs: Record<string, ServerConfig> = {};
  serverNames.forEach(name => { upstreamConfigs[name] = servers[name]; });
  writeLaunchConfig(upstreamConfigs, 'codex');

  writeCodexConfigText(rewriteCodexMcpServers(configText, serverNames, {
    command: gaugeCommand,
    args: ['proxy', '--client', 'codex'],
  }));

  console.log(chalk.green('\n✓ mcp-gauge installed successfully!\n'));
  console.log('What happens next:');
  console.log(`  1. ${chalk.bold('Restart Codex')} — the proxy starts automatically`);
  console.log(`  2. Run ${chalk.cyan('mcp-gauge status --client codex')} to find your dashboard URL`);
  console.log(`  3. Review Codex usage and disable unused MCP tools when present\n`);
  console.log(chalk.dim(`To add new local servers later: add them in Codex, then re-run ${chalk.white('mcp-gauge init --client codex')}`));
  console.log(chalk.dim(`To uninstall: ${chalk.white('mcp-gauge uninstall --client codex')}\n`));
}

export function runUninstall(client: ClientName = detectClient()): void {
  console.log(chalk.bold('\nmcp-gauge uninstall\n'));
  if (client === 'codex') {
    runCodexUninstall();
    return;
  }
  runClaudeUninstall();
}

function runClaudeUninstall(): void {
  const backupPath = path.join(
    process.env.HOME ?? '~',
    '.mcp-gauge',
    'claude_config_backup.json'
  );

  if (!fs.existsSync(backupPath)) {
    console.error(chalk.red('✗ No backup found. Cannot restore original config.'));
    process.exit(1);
  }

  // Rebuild from backup + full launch.json server list.
  // The backup only has servers that existed at init time; launch.json has
  // everything including servers added later via `mcp-gauge init` re-runs.
  // Using launch.json ensures servers added after the initial install survive.
  let backup: ClaudeConfig;
  try {
    backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8')) as ClaudeConfig;
  } catch {
    console.error(chalk.red('✗ Backup file is corrupt. Cannot restore.'));
    process.exit(1);
  }

  const allServers = readLaunchConfig();

  const restored: ClaudeConfig = {
    ...backup,
    mcpServers: Object.keys(allServers).length > 0
      ? allServers
      : backup.mcpServers,   // fall back to backup if launch.json is missing/empty
  };

  fs.writeFileSync(getClaudeConfigPath(), JSON.stringify(restored, null, 2), 'utf-8');

  console.log(chalk.green('✓ Restored original Claude Desktop config.'));
  console.log('Restart Claude Desktop to reconnect directly to your MCP servers.\n');
}

function runCodexUninstall(): void {
  const backupPath = getCodexBackupPath();

  if (!fs.existsSync(backupPath) && readCodexBackupText() === null) {
    console.error(chalk.red('✗ No backup found. Cannot restore original Codex config.'));
    process.exit(1);
  }

  const configText = readCodexConfigText();
  const allServers = readLaunchConfig('codex');
  const restored = restoreCodexMcpServers(configText, allServers);

  fs.writeFileSync(getCodexConfigPath(), restored, 'utf-8');

  console.log(chalk.green('✓ Restored original Codex config.'));
  console.log('Restart Codex to reconnect directly to your MCP servers.\n');
}

function findGlobalGaugeCommand(configName: string): string {
  try {
    return execSync('which mcp-gauge', { encoding: 'utf-8' }).trim();
  } catch {
    console.error(chalk.red('✗ mcp-gauge must be installed globally to work correctly.\n'));
    console.log(`  Running via npx bakes a temporary cache path into your ${configName},`);
    console.log('  which breaks the proxy when the cache is cleared.\n');
    console.log('  Install globally first:\n');
    console.log('    ' + chalk.cyan('npm install -g mcp-gauge') + '\n');
    console.log('  Then run: ' + chalk.cyan('mcp-gauge init') + '\n');
    process.exit(1);
  }
}

function detectClient(): ClientName {
  const claudeExists = fs.existsSync(getClaudeConfigPath());
  const codexExists = fs.existsSync(getCodexConfigPath());

  if (claudeExists) return 'claude';
  if (codexExists) return 'codex';
  return 'claude';
}
