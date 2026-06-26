import fs from 'fs';
import path from 'path';
import os from 'os';
import { PersistedData, ClaudeConfig, ServerConfig } from './types.js';

const DATA_DIR = path.join(os.homedir(), '.mcp-gauge');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const CONFIG_BACKUP = path.join(DATA_DIR, 'claude_config_backup.json');
const CODEX_CONFIG_BACKUP = path.join(DATA_DIR, 'codex_config_backup.toml');
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

// ─── Codex Config ─────────────────────────────────────────────────────────────

interface CodexTableBlock {
  header: string;
  start: number;
  end: number;
}

interface ParsedCodexServer {
  name: string;
  config: Partial<ServerConfig> & Record<string, unknown>;
}

export function getCodexConfigPath(): string {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

export function readCodexConfigText(): string {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Codex config not found.\nExpected at: ${configPath}\nMake sure Codex is installed and has been opened at least once.`
    );
  }
  return fs.readFileSync(configPath, 'utf-8');
}

export function writeCodexConfigText(configText: string): void {
  const configPath = getCodexConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, configText, 'utf-8');
}

export function backupCodexConfig(): void {
  ensureDataDir();
  fs.writeFileSync(CODEX_CONFIG_BACKUP, readCodexConfigText(), 'utf-8');
}

export function getCodexBackupPath(): string {
  return CODEX_CONFIG_BACKUP;
}

export function readCodexStdioServers(configText: string): Record<string, ServerConfig> {
  const servers: Record<string, ServerConfig> = {};
  const parsed = parseCodexServers(configText);

  for (const server of parsed) {
    if (typeof server.config.command !== 'string') continue;
    servers[server.name] = {
      command: server.config.command,
      args: Array.isArray(server.config.args) ? server.config.args : [],
      env: isRecordOfStrings(server.config.env) ? server.config.env : undefined,
    };
  }

  return servers;
}

export function rewriteCodexMcpServers(
  configText: string,
  proxiedServerNames: string[],
  proxyEntry: ServerConfig | null
): string {
  const blocks = findCodexMcpTableBlocks(configText)
    .filter(block => {
      const serverName = codexServerNameFromHeader(block.header);
      return serverName !== null && proxiedServerNames.includes(serverName);
    })
    .sort((a, b) => b.start - a.start);

  let nextText = configText;
  for (const block of blocks) {
    nextText = `${nextText.slice(0, block.start)}${nextText.slice(block.end)}`;
  }

  nextText = nextText.replace(/\s+$/g, '');

  if (proxyEntry) {
    nextText += `${nextText.length > 0 ? '\n\n' : ''}${codexServerToToml('__mcp_gauge_proxy__', proxyEntry)}`;
  }

  return `${nextText}\n`;
}

export function codexServersToToml(servers: Record<string, ServerConfig>): string {
  return Object.entries(servers)
    .map(([name, config]) => codexServerToToml(name, config))
    .join('\n');
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

function parseCodexServers(configText: string): ParsedCodexServer[] {
  const servers = new Map<string, ParsedCodexServer>();
  const blocks = findCodexMcpTableBlocks(configText);

  for (const block of blocks) {
    const serverName = codexServerNameFromHeader(block.header);
    if (serverName === null) continue;

    const server = servers.get(serverName) ?? { name: serverName, config: {} };
    const body = configText.slice(block.start, block.end);

    const tableParts = splitTomlDottedKey(block.header);
    if (tableParts.length === 2) {
      const command = readTomlStringValue(body, 'command');
      const args = readTomlStringArrayValue(body, 'args');
      if (command !== undefined) server.config.command = command;
      if (args !== undefined) server.config.args = args;
    } else if (tableParts.length === 3 && tableParts[2] === 'env') {
      server.config.env = readTomlStringMap(body);
    }

    servers.set(serverName, server);
  }

  return [...servers.values()];
}

function findCodexMcpTableBlocks(configText: string): CodexTableBlock[] {
  const tableRegex = /^[ \t]*\[([^\]\n]+)\][ \t]*(?:#.*)?$/gm;
  const matches: Array<{ header: string; start: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = tableRegex.exec(configText)) !== null) {
    matches.push({ header: match[1].trim(), start: match.index });
  }

  return matches
    .map((current, index) => ({
      ...current,
      end: index + 1 < matches.length ? matches[index + 1].start : configText.length,
    }))
    .filter(block => codexServerNameFromHeader(block.header) !== null);
}

function codexServerNameFromHeader(header: string): string | null {
  const parts = splitTomlDottedKey(header);
  if (parts.length < 2 || parts[0] !== 'mcp_servers') return null;
  return parts[1];
}

function splitTomlDottedKey(key: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of key) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote === '"') {
      escaped = true;
      current += char;
      continue;
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (char === '.' && quote === null) {
      parts.push(unquoteTomlString(current.trim()));
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim().length > 0) {
    parts.push(unquoteTomlString(current.trim()));
  }

  return parts;
}

function readTomlStringValue(body: string, key: string): string | undefined {
  const match = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*(.+?)[ \\t]*(?:#.*)?$`, 'm').exec(body);
  if (!match) return undefined;
  return unquoteTomlString(match[1].trim());
}

function readTomlStringArrayValue(body: string, key: string): string[] | undefined {
  const match = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*\\[(.*?)\\][ \\t]*(?:#.*)?$`, 'ms').exec(body);
  if (!match) return undefined;

  const values: string[] = [];
  const valueRegex = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  let valueMatch: RegExpExecArray | null;
  while ((valueMatch = valueRegex.exec(match[1])) !== null) {
    values.push(unquoteTomlString(valueMatch[0]));
  }
  return values;
}

function readTomlStringMap(body: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lineRegex = /^[ \t]*([^=\s]+)[ \t]*=[ \t]*(.+?)[ \t]*(?:#.*)?$/gm;
  let match: RegExpExecArray | null;

  while ((match = lineRegex.exec(body)) !== null) {
    const key = unquoteTomlString(match[1].trim());
    env[key] = unquoteTomlString(match[2].trim());
  }

  return env;
}

function unquoteTomlString(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function codexServerToToml(name: string, config: ServerConfig): string {
  const lines = [
    `[mcp_servers.${tomlKey(name)}]`,
    `command = ${tomlString(config.command)}`,
    `args = [${config.args.map(tomlString).join(', ')}]`,
  ];

  if (config.env && Object.keys(config.env).length > 0) {
    lines.push('', `[mcp_servers.${tomlKey(name)}.env]`);
    for (const [key, value] of Object.entries(config.env)) {
      lines.push(`${tomlKey(key)} = ${tomlString(value)}`);
    }
  }

  return lines.join('\n');
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return typeof value === 'object' &&
    value !== null &&
    Object.values(value).every(item => typeof item === 'string');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
