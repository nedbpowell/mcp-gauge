import fs from 'fs';
import path from 'path';
import os from 'os';
import { PersistedData, ClaudeConfig, ServerConfig } from './types.js';

const DATA_DIR = path.join(os.homedir(), '.mcp-gauge');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const CONFIG_BACKUP = path.join(DATA_DIR, 'claude_config_backup.json');
const LAUNCH_FILE = path.join(DATA_DIR, 'launch.json');
const PORT_FILE = path.join(DATA_DIR, 'port');

// ─── Claude Config ────────────────────────────────────────────────────────────

export function getClaudeConfigPath(): string {
  // Claude Desktop on macOS
  const mac = path.join(
    os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'
  );
  if (fs.existsSync(mac)) return mac;

  // Claude Desktop on Linux
  const linux = path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
  if (fs.existsSync(linux)) return linux;

  // Default: assume macOS path (will produce a clear error if missing)
  return mac;
}

export function readClaudeConfig(): ClaudeConfig {
  const configPath = getClaudeConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Claude Desktop config not found.\nExpected at: ${configPath}\nMake sure Claude Desktop is installed and has been opened at least once.`
    );
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as ClaudeConfig;
}

export function writeClaudeConfig(config: ClaudeConfig): void {
  const configPath = getClaudeConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function backupClaudeConfig(): void {
  ensureDataDir();
  const current = fs.readFileSync(getClaudeConfigPath(), 'utf-8');
  fs.writeFileSync(CONFIG_BACKUP, current, 'utf-8');
}

export function restoreClaudeConfig(): void {
  if (!fs.existsSync(CONFIG_BACKUP)) {
    throw new Error('No backup found. Cannot restore.');
  }
  const backup = fs.readFileSync(CONFIG_BACKUP, 'utf-8');
  fs.writeFileSync(getClaudeConfigPath(), backup, 'utf-8');
  console.log('✅ Restored original Claude config from backup.');
}

// ─── Persisted Tool Data ──────────────────────────────────────────────────────

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function readPersistedData(): PersistedData {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    return { toolCallCounts: {}, disabledTools: {}, lastSeenAt: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) as PersistedData;
  } catch {
    return { toolCallCounts: {}, disabledTools: {}, lastSeenAt: {} };
  }
}

export function writePersistedData(data: PersistedData): void {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export function toolKey(serverName: string, toolName: string): string {
  return `${serverName}::${toolName}`;
}

export function incrementCallCount(serverName: string, toolName: string): void {
  const data = readPersistedData();
  const key = toolKey(serverName, toolName);
  data.toolCallCounts[key] = (data.toolCallCounts[key] ?? 0) + 1;
  data.lastSeenAt[key] = new Date().toISOString();
  writePersistedData(data);
}

export function setToolDisabled(
  serverName: string,
  toolName: string,
  disabled: boolean
): void {
  const data = readPersistedData();
  const key = toolKey(serverName, toolName);
  if (disabled) {
    data.disabledTools[key] = true;
  } else {
    delete data.disabledTools[key];
  }
  writePersistedData(data);
}

// ─── Launch Config ────────────────────────────────────────────────────────────

export function readLaunchConfig(): Record<string, ServerConfig> {
  if (!fs.existsSync(LAUNCH_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(LAUNCH_FILE, 'utf-8'));
    return (data.upstreamConfigs ?? {}) as Record<string, ServerConfig>;
  } catch {
    return {};
  }
}

export function writeLaunchConfig(upstreamConfigs: Record<string, ServerConfig>): void {
  ensureDataDir();
  fs.writeFileSync(LAUNCH_FILE, JSON.stringify({ upstreamConfigs }, null, 2));
}

// ─── Port File ────────────────────────────────────────────────────────────────

export function readPort(): number {
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf-8').trim();
    const n = parseInt(raw, 10);
    return isNaN(n) ? 3456 : n;
  } catch {
    return 3456;
  }
}

export function writePort(port: number): void {
  ensureDataDir();
  fs.writeFileSync(PORT_FILE, port.toString());
}
