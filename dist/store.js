"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getClaudeConfigPath = getClaudeConfigPath;
exports.readClaudeConfig = readClaudeConfig;
exports.writeClaudeConfig = writeClaudeConfig;
exports.backupClaudeConfig = backupClaudeConfig;
exports.restoreClaudeConfig = restoreClaudeConfig;
exports.readPersistedData = readPersistedData;
exports.writePersistedData = writePersistedData;
exports.toolKey = toolKey;
exports.incrementCallCount = incrementCallCount;
exports.setToolDisabled = setToolDisabled;
exports.readLaunchConfig = readLaunchConfig;
exports.writeLaunchConfig = writeLaunchConfig;
exports.readPort = readPort;
exports.writePort = writePort;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const DATA_DIR = path_1.default.join(os_1.default.homedir(), '.mcp-gauge');
const DATA_FILE = path_1.default.join(DATA_DIR, 'data.json');
const CONFIG_BACKUP = path_1.default.join(DATA_DIR, 'claude_config_backup.json');
const LAUNCH_FILE = path_1.default.join(DATA_DIR, 'launch.json');
const PORT_FILE = path_1.default.join(DATA_DIR, 'port');
// ─── Claude Config ────────────────────────────────────────────────────────────
function getClaudeConfigPath() {
    // Claude Desktop on macOS
    const mac = path_1.default.join(os_1.default.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    if (fs_1.default.existsSync(mac))
        return mac;
    // Claude Desktop on Linux
    const linux = path_1.default.join(os_1.default.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
    if (fs_1.default.existsSync(linux))
        return linux;
    // Default: assume macOS path (will produce a clear error if missing)
    return mac;
}
function readClaudeConfig() {
    const configPath = getClaudeConfigPath();
    if (!fs_1.default.existsSync(configPath)) {
        throw new Error(`Claude Desktop config not found.\nExpected at: ${configPath}\nMake sure Claude Desktop is installed and has been opened at least once.`);
    }
    const raw = fs_1.default.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
}
function writeClaudeConfig(config) {
    const configPath = getClaudeConfigPath();
    fs_1.default.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
function backupClaudeConfig() {
    ensureDataDir();
    const current = fs_1.default.readFileSync(getClaudeConfigPath(), 'utf-8');
    fs_1.default.writeFileSync(CONFIG_BACKUP, current, 'utf-8');
}
function restoreClaudeConfig() {
    if (!fs_1.default.existsSync(CONFIG_BACKUP)) {
        throw new Error('No backup found. Cannot restore.');
    }
    const backup = fs_1.default.readFileSync(CONFIG_BACKUP, 'utf-8');
    fs_1.default.writeFileSync(getClaudeConfigPath(), backup, 'utf-8');
    console.log('✅ Restored original Claude config from backup.');
}
// ─── Persisted Tool Data ──────────────────────────────────────────────────────
function ensureDataDir() {
    if (!fs_1.default.existsSync(DATA_DIR)) {
        fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
    }
}
function readPersistedData() {
    ensureDataDir();
    if (!fs_1.default.existsSync(DATA_FILE)) {
        return { toolCallCounts: {}, disabledTools: {}, lastSeenAt: {} };
    }
    try {
        return JSON.parse(fs_1.default.readFileSync(DATA_FILE, 'utf-8'));
    }
    catch {
        return { toolCallCounts: {}, disabledTools: {}, lastSeenAt: {} };
    }
}
function writePersistedData(data) {
    ensureDataDir();
    fs_1.default.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}
function toolKey(serverName, toolName) {
    return `${serverName}::${toolName}`;
}
function incrementCallCount(serverName, toolName) {
    const data = readPersistedData();
    const key = toolKey(serverName, toolName);
    data.toolCallCounts[key] = (data.toolCallCounts[key] ?? 0) + 1;
    data.lastSeenAt[key] = new Date().toISOString();
    writePersistedData(data);
}
function setToolDisabled(serverName, toolName, disabled) {
    const data = readPersistedData();
    const key = toolKey(serverName, toolName);
    if (disabled) {
        data.disabledTools[key] = true;
    }
    else {
        delete data.disabledTools[key];
    }
    writePersistedData(data);
}
// ─── Launch Config ────────────────────────────────────────────────────────────
function readLaunchConfig() {
    if (!fs_1.default.existsSync(LAUNCH_FILE))
        return {};
    try {
        const data = JSON.parse(fs_1.default.readFileSync(LAUNCH_FILE, 'utf-8'));
        return (data.upstreamConfigs ?? {});
    }
    catch {
        return {};
    }
}
function writeLaunchConfig(upstreamConfigs) {
    ensureDataDir();
    fs_1.default.writeFileSync(LAUNCH_FILE, JSON.stringify({ upstreamConfigs }, null, 2));
}
// ─── Port File ────────────────────────────────────────────────────────────────
function readPort() {
    try {
        const raw = fs_1.default.readFileSync(PORT_FILE, 'utf-8').trim();
        const n = parseInt(raw, 10);
        return isNaN(n) ? 3456 : n;
    }
    catch {
        return 3456;
    }
}
function writePort(port) {
    ensureDataDir();
    fs_1.default.writeFileSync(PORT_FILE, port.toString());
}
