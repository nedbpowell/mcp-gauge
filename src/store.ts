import fs from 'fs';
import path from 'path';
import os from 'os';
import { parse } from 'smol-toml';
import { PersistedData, ClaudeConfig, ServerConfig, ClientName } from './types.js';

const LEGACY_DATA_FILE = 'data.json';
const LEGACY_CLAUDE_CONFIG_BACKUP = 'claude_config_backup.json';
const LEGACY_CODEX_CONFIG_BACKUP = 'codex_config_backup.toml';
const LEGACY_LAUNCH_FILE = 'launch.json';
const LEGACY_PORT_FILE = 'port';

const CODEX_PROXY_SERVER_NAME = '__mcp_gauge_proxy__';

export interface LaunchState {
  upstreamConfigs: Record<string, ServerConfig>;
}

interface CodexTableBlock {
  header: string;
  start: number;
  end: number;
}

interface ParsedCodexServer {
  name: string;
  config: Partial<ServerConfig> & Record<string, unknown>;
  originalBlock?: string;
}

function dataDir(): string {
  return path.join(homeDir(), '.mcp-gauge');
}

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

function clientDataDir(client: ClientName): string {
  return path.join(dataDir(), 'clients', client);
}

function legacyPath(fileName: string): string {
  return path.join(dataDir(), fileName);
}

function scopedPath(client: ClientName, fileName: string): string {
  if (client === 'claude') {
    return legacyPath(fileName);
  }
  return path.join(clientDataDir(client), fileName);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureDataDir(client?: ClientName): void {
  ensureDir(client === 'codex' ? clientDataDir(client) : dataDir());
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function codexFallbackPath(scopedFile: string, legacyFile: string): string | null {
  if (fs.existsSync(scopedFile)) return scopedFile;
  const fallback = legacyPath(legacyFile);
  return fs.existsSync(fallback) ? fallback : null;
}

// Claude Config

export function getClaudeConfigPath(): string {
  const mac = path.join(
    homeDir(),
    'Library',
    'Application Support',
    'Claude',
    'claude_desktop_config.json'
  );
  if (fs.existsSync(mac)) return mac;

  const linux = path.join(homeDir(), '.config', 'Claude', 'claude_desktop_config.json');
  if (fs.existsSync(linux)) return linux;

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
  fs.writeFileSync(legacyPath(LEGACY_CLAUDE_CONFIG_BACKUP), current, 'utf-8');
}

// Codex Config

export function getCodexConfigPath(): string {
  return path.join(homeDir(), '.codex', 'config.toml');
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
  ensureDataDir('codex');
  fs.writeFileSync(scopedPath('codex', 'config_backup.toml'), readCodexConfigText(), 'utf-8');
}

export function getCodexBackupPath(): string {
  return scopedPath('codex', 'config_backup.toml');
}

export function readCodexBackupText(): string | null {
  const scoped = scopedPath('codex', 'config_backup.toml');
  const backupPath = codexFallbackPath(scoped, LEGACY_CODEX_CONFIG_BACKUP);
  return backupPath ? fs.readFileSync(backupPath, 'utf-8') : null;
}

export function readCodexStdioServers(configText: string): Record<string, ServerConfig> {
  const servers: Record<string, ServerConfig> = {};
  const parsed = parseCodexServers(removeDuplicateCodexProxyBlocks(configText));

  for (const server of parsed) {
    if (typeof server.config.command !== 'string') continue;
    servers[server.name] = {
      ...server.config,
      command: server.config.command,
      args: Array.isArray(server.config.args) ? server.config.args : [],
      env: isRecordOfStrings(server.config.env) ? server.config.env : undefined,
      originalBlock: server.originalBlock,
    };
  }

  return servers;
}

export function rewriteCodexMcpServers(
  configText: string,
  proxiedServerNames: string[],
  proxyEntry: ServerConfig | null
): string {
  const namesToRemove = proxyEntry
    ? [...proxiedServerNames, CODEX_PROXY_SERVER_NAME]
    : proxiedServerNames;
  let nextText = removeCodexServerBlocks(configText, namesToRemove).replace(/\s+$/g, '');

  if (proxyEntry) {
    nextText += `${nextText.length > 0 ? '\n\n' : ''}${codexServerToToml(CODEX_PROXY_SERVER_NAME, proxyEntry)}`;
  }

  return `${nextText}\n`;
}

export function restoreCodexMcpServers(
  configText: string,
  servers: Record<string, ServerConfig>
): string {
  const serverNames = Object.keys(servers);
  const blocks = serverNames.map((name) => {
    const originalBlock = servers[name].originalBlock;
    return typeof originalBlock === 'string' && originalBlock.trim().length > 0
      ? originalBlock.trim()
      : codexServerToToml(name, servers[name]);
  });

  let nextText = removeCodexServerBlocks(
    configText,
    [CODEX_PROXY_SERVER_NAME, ...serverNames]
  ).replace(/\s+$/g, '');

  if (blocks.length > 0) {
    nextText += `${nextText.length > 0 ? '\n\n' : ''}${blocks.join('\n\n')}`;
  }

  return `${nextText}\n`;
}

export function codexServersToToml(servers: Record<string, ServerConfig>): string {
  return Object.entries(servers)
    .map(([name, config]) => {
      if (typeof config.originalBlock === 'string' && config.originalBlock.trim().length > 0) {
        return config.originalBlock.trim();
      }
      return codexServerToToml(name, config);
    })
    .join('\n\n');
}

// Persisted Tool Data

export function readPersistedData(client: ClientName = 'claude'): PersistedData {
  ensureDataDir(client);
  const filePath = scopedPath(client, LEGACY_DATA_FILE);
  const fallbackPath = client === 'codex' ? legacyPath(LEGACY_DATA_FILE) : filePath;
  const data = readJsonFile<PersistedData>(filePath) ?? readJsonFile<PersistedData>(fallbackPath);
  return data ?? { toolCallCounts: {}, disabledTools: {}, lastSeenAt: {} };
}

export function writePersistedData(data: PersistedData, client: ClientName = 'claude'): void {
  ensureDataDir(client);
  fs.writeFileSync(scopedPath(client, LEGACY_DATA_FILE), JSON.stringify(data, null, 2), 'utf-8');
}

export function toolKey(serverName: string, toolName: string): string {
  return `${serverName}::${toolName}`;
}

export function incrementCallCount(
  serverName: string,
  toolName: string,
  client: ClientName = 'claude'
): void {
  const data = readPersistedData(client);
  const key = toolKey(serverName, toolName);
  data.toolCallCounts[key] = (data.toolCallCounts[key] ?? 0) + 1;
  data.lastSeenAt[key] = new Date().toISOString();
  writePersistedData(data, client);
}

export function setToolDisabled(
  serverName: string,
  toolName: string,
  disabled: boolean,
  client: ClientName = 'claude'
): void {
  const data = readPersistedData(client);
  const key = toolKey(serverName, toolName);
  if (disabled) {
    data.disabledTools[key] = true;
  } else {
    delete data.disabledTools[key];
  }
  writePersistedData(data, client);
}

// Launch Config

export function readLaunchState(client: ClientName = 'claude'): LaunchState {
  const filePath = scopedPath(client, LEGACY_LAUNCH_FILE);
  const fallbackPath = client === 'codex' ? legacyPath(LEGACY_LAUNCH_FILE) : filePath;
  const data = readJsonFile<LaunchState & {
    upstreamConfigs?: Record<string, ServerConfig>;
    codexServerBlocks?: Record<string, string>;
  }>(filePath) ?? readJsonFile<LaunchState & {
    upstreamConfigs?: Record<string, ServerConfig>;
    codexServerBlocks?: Record<string, string>;
  }>(fallbackPath);

  const upstreamConfigs = data?.upstreamConfigs ?? {};
  if (data?.codexServerBlocks) {
    for (const [name, block] of Object.entries(data.codexServerBlocks)) {
      if (upstreamConfigs[name] && upstreamConfigs[name].originalBlock === undefined) {
        upstreamConfigs[name].originalBlock = block;
      }
    }
  }

  return { upstreamConfigs };
}

export function readLaunchConfig(client: ClientName = 'claude'): Record<string, ServerConfig> {
  return readLaunchState(client).upstreamConfigs;
}

export function writeLaunchState(state: LaunchState, client: ClientName = 'claude'): void {
  ensureDataDir(client);
  fs.writeFileSync(scopedPath(client, LEGACY_LAUNCH_FILE), JSON.stringify(state, null, 2), 'utf-8');
}

export function writeLaunchConfig(
  upstreamConfigs: Record<string, ServerConfig>,
  client: ClientName = 'claude'
): void {
  writeLaunchState({ upstreamConfigs }, client);
}

// Port File

export function readPort(client: ClientName = 'claude'): number {
  const filePath = scopedPath(client, LEGACY_PORT_FILE);
  const fallbackPath = client === 'codex' ? legacyPath(LEGACY_PORT_FILE) : filePath;
  for (const candidate of [filePath, fallbackPath]) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8').trim();
      const n = parseInt(raw, 10);
      if (!isNaN(n)) return n;
    } catch {
      // Try the next candidate.
    }
  }
  return 3456;
}

export function writePort(port: number, client: ClientName = 'claude'): void {
  ensureDataDir(client);
  fs.writeFileSync(scopedPath(client, LEGACY_PORT_FILE), port.toString());
}

function parseCodexServers(configText: string): ParsedCodexServer[] {
  const parsedConfig = parse(configText) as {
    mcp_servers?: Record<string, Record<string, unknown>>;
  };
  const blocks = extractCodexServerBlocks(configText);
  const servers = parsedConfig.mcp_servers ?? {};

  return Object.entries(servers).map(([name, config]) => ({
    name,
    config,
    originalBlock: blocks[name],
  }));
}

function extractCodexServerBlocks(configText: string): Record<string, string> {
  const groupedBlocks = new Map<string, string[]>();
  for (const block of findCodexMcpTableBlocks(configText)) {
    const serverName = codexServerNameFromHeader(block.header);
    if (serverName === null) continue;
    const serverBlocks = groupedBlocks.get(serverName) ?? [];
    serverBlocks.push(configText.slice(block.start, block.end).trim());
    groupedBlocks.set(serverName, serverBlocks);
  }

  const blocks: Record<string, string> = {};
  for (const [serverName, serverBlocks] of groupedBlocks.entries()) {
    blocks[serverName] = serverBlocks.join('\n\n');
  }
  return blocks;
}

function removeCodexServerBlocks(configText: string, serverNames: string[]): string {
  const names = new Set(serverNames);
  const blocks = findCodexMcpTableBlocks(configText)
    .filter((block) => {
      const serverName = codexServerNameFromHeader(block.header);
      return serverName !== null && names.has(serverName);
    })
    .sort((a, b) => b.start - a.start);

  let nextText = configText;
  for (const block of blocks) {
    nextText = `${nextText.slice(0, block.start)}${nextText.slice(block.end)}`;
  }
  return nextText;
}

function removeDuplicateCodexProxyBlocks(configText: string): string {
  const proxyBlocks = findCodexMcpTableBlocks(configText)
    .filter((block) => codexServerNameFromHeader(block.header) === CODEX_PROXY_SERVER_NAME);

  if (proxyBlocks.length <= 1) return configText;

  let nextText = configText;
  for (const block of proxyBlocks.slice(1).sort((a, b) => b.start - a.start)) {
    nextText = `${nextText.slice(0, block.start)}${nextText.slice(block.end)}`;
  }

  return nextText;
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
    .filter((block) => codexServerNameFromHeader(block.header) !== null);
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
    Object.values(value).every((item) => typeof item === 'string');
}
