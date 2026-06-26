/**
 * MCP Proxy Server
 *
 * Architecture:
 *   MCP client  ──stdio──►  THIS PROXY  ──stdio──►  real MCP server 1
 *                                       ──stdio──►  real MCP server 2
 *                                       ──stdio──►  real MCP server N
 *
 * The proxy:
 *  1. Spawns each real server as a child process
 *  2. Intercepts tools/list responses to measure token cost
 *  3. Filters out disabled tools before returning to the client
 *  4. Intercepts tools/call requests to log usage
 *  5. Pushes state updates to the dashboard via WebSocket
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import EventEmitter from 'events';
import { createRequire } from 'module';

import { ServerConfig, TrackedTool, ServerStats, BudgetState } from '../types.js';
import { measureToolCost } from '../tokens.js';
import {
  readPersistedData,
  incrementCallCount,
  toolKey,
} from '../store.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../../package.json') as { version: string };

// ─── State ────────────────────────────────────────────────────────────────────

// Shared in-memory state — the dashboard reads this via the state emitter
const serverStats = new Map<string, ServerStats>();
export const stateEmitter = new EventEmitter();

const MODEL_LIMIT = 200_000; // Claude's context window
const SESSION_STARTED = new Date();

export function getBudgetState(): BudgetState {
  const servers = Array.from(serverStats.values());
  const totalTokens = servers.reduce((sum: number, s: ServerStats) => sum + s.totalTokens, 0);
  const activeTokens = servers.reduce((sum: number, s: ServerStats) => {
    return sum + s.tools
      .filter((t: TrackedTool) => !t.disabled)
      .reduce((ts: number, t: TrackedTool) => ts + t.tokenCost, 0);
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
  stateEmitter.emit('update', getBudgetState());
}

// ─── Per-server upstream client ───────────────────────────────────────────────

interface UpstreamConnection {
  client: Client;
  serverName: string;
}

async function connectToServer(
  serverName: string,
  config: ServerConfig
): Promise<UpstreamConnection> {
  const mergedEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...config.env }).filter(([, v]) => v !== undefined)
  ) as Record<string, string>;

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: mergedEnv,
  });

  const client = new Client(
    { name: 'mcp-gauge-proxy', version: PKG_VERSION },
    { capabilities: {} }
  );

  await client.connect(transport);

  // Fetch tool list immediately and measure token costs
  await refreshServerTools(serverName, client);

  return { client, serverName };
}

async function refreshServerTools(
  serverName: string,
  client: Client
): Promise<void> {
  const persisted = readPersistedData();

  let tools: Tool[] = [];
  try {
    const result = await client.listTools();
    tools = result.tools;
  } catch {
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
  const trackedTools: TrackedTool[] = await Promise.all(
    tools.map(async (tool): Promise<TrackedTool> => {
      const key = toolKey(serverName, tool.name);
      const tokenCost = await measureToolCost({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as object,
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
          inputSchema: tool.inputSchema as object,
        },
      };
    })
  );

  const totalTokens = trackedTools.reduce((sum: number, t: TrackedTool) => sum + t.tokenCost, 0);
  const disabledCount = trackedTools.filter((t: TrackedTool) => t.disabled).length;

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

export async function startProxy(
  serverConfigs: Record<string, ServerConfig>
): Promise<void> {
  // Connect to all real servers in parallel
  const connections = new Map<string, UpstreamConnection>();

  await Promise.allSettled(
    Object.entries(serverConfigs).map(async ([name, config]) => {
      try {
        const conn = await connectToServer(name, config);
        connections.set(name, conn);
      } catch (err) {
        // Mark server as disconnected but don't crash the proxy
        serverStats.set(name, {
          name,
          totalTokens: 0,
          toolCount: 0,
          disabledCount: 0,
          tools: [],
          connected: false,
        });
        process.stderr.write(
          `[mcp-gauge] Failed to connect to ${name}: ${err}\n`
        );
      }
    })
  );

  // Create the proxy MCP server (this is what Claude Code talks to)
  const server = new Server(
    { name: 'mcp-gauge', version: PKG_VERSION },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ── tools/list ──────────────────────────────────────────────────────────────
  // Aggregate tools from all servers, filter disabled ones, return to Claude
  server.setRequestHandler(ListToolsRequestSchema, async () => {
  const persisted = readPersistedData();
  
  // Build a routing table: toolName -> serverName
  // Detect collisions across servers
  const nameCount = new Map<string, number>();
  for (const [serverName, conn] of connections.entries()) {
    const stats = serverStats.get(serverName);
    if (!stats) continue;
    for (const tracked of stats.tools) {
      const key = toolKey(serverName, tracked.name);
      if (persisted.disabledTools[key]) continue;
      nameCount.set(tracked.name, (nameCount.get(tracked.name) ?? 0) + 1);
    }
  }

  const allTools: Tool[] = [];

  for (const [serverName, conn] of connections.entries()) {
    const stats = serverStats.get(serverName);
    if (!stats) continue;

    for (const tracked of stats.tools) {
      const key = toolKey(serverName, tracked.name);
      if (persisted.disabledTools[key]) continue;

      // Only namespace if there's a collision
      const hasCollision = (nameCount.get(tracked.name) ?? 0) > 1;
      const exposedName = hasCollision
        ? `${serverName}__${tracked.name}`
        : tracked.name;

      allTools.push({
        name: exposedName,
        description: tracked.definition.description,
        inputSchema: (tracked.definition.inputSchema ?? {}) as Tool['inputSchema'],
      });
    }
  }

  return { tools: allTools };
});

  // ── tools/call ──────────────────────────────────────────────────────────────
  // Route the call to the correct upstream server, log usage
 server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name: incomingName, arguments: args } = request.params;

  // Determine serverName and toolName
  // Could be namespaced (collision case) or plain (no collision)
  let serverName: string | undefined;
  let toolName: string;

  if (incomingName.includes('__')) {
    const separatorIndex = incomingName.indexOf('__');
    serverName = incomingName.slice(0, separatorIndex);
    toolName = incomingName.slice(separatorIndex + 2);
  } else {
    // Find which server owns this tool name
    toolName = incomingName;
    for (const [sName, stats] of serverStats.entries()) {
      if (stats.tools.some((t: TrackedTool) => t.name === toolName)) {
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

  incrementCallCount(serverName, toolName);

  const stats = serverStats.get(serverName);
  if (stats) {
    const tool = stats.tools.find((t: TrackedTool) => t.name === toolName);
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
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('[mcp-gauge] Proxy running\n');
}

// ─── Live tool toggle (called by dashboard) ───────────────────────────────────

export function updateToolState(
  serverName: string,
  toolName: string,
  disabled: boolean
): void {
  const stats = serverStats.get(serverName);
  if (!stats) return;

  const tool = stats.tools.find(t => t.name === toolName);
  if (!tool) return;

  tool.disabled = disabled;

  // Recalculate server totals
  stats.disabledCount = stats.tools.filter(t => t.disabled).length;

  emitStateUpdate();
}
