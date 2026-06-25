"use strict";
/**
 * MCP Proxy Server
 *
 * Architecture:
 *   Claude Code  ──stdio──►  THIS PROXY  ──stdio──►  real MCP server 1
 *                                        ──stdio──►  real MCP server 2
 *                                        ──stdio──►  real MCP server N
 *
 * The proxy:
 *  1. Spawns each real server as a child process
 *  2. Intercepts tools/list responses to measure token cost
 *  3. Filters out disabled tools before returning to Claude Code
 *  4. Intercepts tools/call requests to log usage
 *  5. Pushes state updates to the dashboard via WebSocket
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stateEmitter = void 0;
exports.getBudgetState = getBudgetState;
exports.startProxy = startProxy;
exports.updateToolState = updateToolState;
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const index_js_2 = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js_2 = require("@modelcontextprotocol/sdk/client/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const events_1 = __importDefault(require("events"));
const tokens_js_1 = require("../tokens.js");
const store_js_1 = require("../store.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: PKG_VERSION } = require('../../package.json');
// ─── State ────────────────────────────────────────────────────────────────────
// Shared in-memory state — the dashboard reads this via the state emitter
const serverStats = new Map();
exports.stateEmitter = new events_1.default();
const MODEL_LIMIT = 200_000; // Claude's context window
const SESSION_STARTED = new Date();
function getBudgetState() {
    const servers = Array.from(serverStats.values());
    const totalTokens = servers.reduce((sum, s) => sum + s.totalTokens, 0);
    const activeTokens = servers.reduce((sum, s) => {
        return sum + s.tools
            .filter((t) => !t.disabled)
            .reduce((ts, t) => ts + t.tokenCost, 0);
    }, 0);
    return {
        totalTokens,
        activeTokens,
        savedTokens: totalTokens - activeTokens,
        modelLimit: MODEL_LIMIT,
        servers,
        lastUpdatedAt: new Date(),
        sessionStartedAt: SESSION_STARTED,
    };
}
function emitStateUpdate() {
    exports.stateEmitter.emit('update', getBudgetState());
}
async function connectToServer(serverName, config) {
    const mergedEnv = Object.fromEntries(Object.entries({ ...process.env, ...config.env }).filter(([, v]) => v !== undefined));
    const transport = new stdio_js_2.StdioClientTransport({
        command: config.command,
        args: config.args,
        env: mergedEnv,
    });
    const client = new index_js_2.Client({ name: 'mcp-gauge-proxy', version: PKG_VERSION }, { capabilities: {} });
    await client.connect(transport);
    // Fetch tool list immediately and measure token costs
    await refreshServerTools(serverName, client);
    return { client, serverName };
}
async function refreshServerTools(serverName, client) {
    const persisted = (0, store_js_1.readPersistedData)();
    let tools = [];
    try {
        const result = await client.listTools();
        tools = result.tools;
    }
    catch {
        // Server doesn't support tools — that's fine
        serverStats.set(serverName, {
            name: serverName,
            totalTokens: 0,
            toolCount: 0,
            disabledCount: 0,
            tools: [],
            connected: true,
        });
        return;
    }
    // Measure each tool's token cost concurrently
    const trackedTools = await Promise.all(tools.map(async (tool) => {
        const key = (0, store_js_1.toolKey)(serverName, tool.name);
        const tokenCost = await (0, tokens_js_1.measureToolCost)({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        });
        return {
            name: tool.name,
            serverName,
            tokenCost,
            callCount: 0,
            totalCallCount: persisted.toolCallCounts[key] ?? 0,
            lastCalledAt: persisted.lastSeenAt[key]
                ? new Date(persisted.lastSeenAt[key])
                : null,
            disabled: persisted.disabledTools[key] ?? false,
            definition: {
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
            },
        };
    }));
    const totalTokens = trackedTools.reduce((sum, t) => sum + t.tokenCost, 0);
    const disabledCount = trackedTools.filter((t) => t.disabled).length;
    serverStats.set(serverName, {
        name: serverName,
        totalTokens,
        toolCount: trackedTools.length,
        disabledCount,
        tools: trackedTools,
        connected: true,
    });
    emitStateUpdate();
}
// ─── The proxy server itself ──────────────────────────────────────────────────
async function startProxy(serverConfigs) {
    // Connect to all real servers in parallel
    const connections = new Map();
    await Promise.allSettled(Object.entries(serverConfigs).map(async ([name, config]) => {
        try {
            const conn = await connectToServer(name, config);
            connections.set(name, conn);
        }
        catch (err) {
            // Mark server as disconnected but don't crash the proxy
            serverStats.set(name, {
                name,
                totalTokens: 0,
                toolCount: 0,
                disabledCount: 0,
                tools: [],
                connected: false,
            });
            process.stderr.write(`[mcp-gauge] Failed to connect to ${name}: ${err}\n`);
        }
    }));
    // Create the proxy MCP server (this is what Claude Code talks to)
    const server = new index_js_1.Server({ name: 'mcp-gauge', version: PKG_VERSION }, {
        capabilities: {
            tools: {},
        },
    });
    // ── tools/list ──────────────────────────────────────────────────────────────
    // Aggregate tools from all servers, filter disabled ones, return to Claude
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
        const persisted = (0, store_js_1.readPersistedData)();
        // Build a routing table: toolName -> serverName
        // Detect collisions across servers
        const nameCount = new Map();
        for (const [serverName, conn] of connections.entries()) {
            const stats = serverStats.get(serverName);
            if (!stats)
                continue;
            for (const tracked of stats.tools) {
                const key = (0, store_js_1.toolKey)(serverName, tracked.name);
                if (persisted.disabledTools[key])
                    continue;
                nameCount.set(tracked.name, (nameCount.get(tracked.name) ?? 0) + 1);
            }
        }
        const allTools = [];
        for (const [serverName, conn] of connections.entries()) {
            const stats = serverStats.get(serverName);
            if (!stats)
                continue;
            for (const tracked of stats.tools) {
                const key = (0, store_js_1.toolKey)(serverName, tracked.name);
                if (persisted.disabledTools[key])
                    continue;
                // Only namespace if there's a collision
                const hasCollision = (nameCount.get(tracked.name) ?? 0) > 1;
                const exposedName = hasCollision
                    ? `${serverName}__${tracked.name}`
                    : tracked.name;
                allTools.push({
                    name: exposedName,
                    description: tracked.definition.description,
                    inputSchema: (tracked.definition.inputSchema ?? {}),
                });
            }
        }
        return { tools: allTools };
    });
    // ── tools/call ──────────────────────────────────────────────────────────────
    // Route the call to the correct upstream server, log usage
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
        const { name: incomingName, arguments: args } = request.params;
        // Determine serverName and toolName
        // Could be namespaced (collision case) or plain (no collision)
        let serverName;
        let toolName;
        if (incomingName.includes('__')) {
            const separatorIndex = incomingName.indexOf('__');
            serverName = incomingName.slice(0, separatorIndex);
            toolName = incomingName.slice(separatorIndex + 2);
        }
        else {
            // Find which server owns this tool name
            toolName = incomingName;
            for (const [sName, stats] of serverStats.entries()) {
                if (stats.tools.some((t) => t.name === toolName)) {
                    serverName = sName;
                    break;
                }
            }
        }
        if (!serverName) {
            throw new Error(`Unknown tool: ${incomingName}`);
        }
        const conn = connections.get(serverName);
        if (!conn) {
            throw new Error(`Server not connected: ${serverName}`);
        }
        (0, store_js_1.incrementCallCount)(serverName, toolName);
        const stats = serverStats.get(serverName);
        if (stats) {
            const tool = stats.tools.find((t) => t.name === toolName);
            if (tool) {
                tool.callCount += 1;
                tool.totalCallCount += 1;
                tool.lastCalledAt = new Date();
            }
        }
        emitStateUpdate();
        return conn.client.callTool({ name: toolName, arguments: args ?? {} });
    });
    // Start accepting connections from Claude Code over stdio
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('[mcp-gauge] Proxy running\n');
}
// ─── Live tool toggle (called by dashboard) ───────────────────────────────────
function updateToolState(serverName, toolName, disabled) {
    const stats = serverStats.get(serverName);
    if (!stats)
        return;
    const tool = stats.tools.find(t => t.name === toolName);
    if (!tool)
        return;
    tool.disabled = disabled;
    // Recalculate server totals
    stats.disabledCount = stats.tools.filter(t => t.disabled).length;
    emitStateUpdate();
}
