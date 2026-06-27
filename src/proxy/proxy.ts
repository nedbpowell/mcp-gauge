/**
 * MCP Proxy Server
 *
 * The proxy starts real stdio MCP servers as child processes, measures and
 * filters tools, then forwards prompts and resources so clients keep the same
 * non-tool MCP surface while mcp-gauge is installed.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  Tool,
  Prompt,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';
import EventEmitter from 'events';
import { createRequire } from 'module';

import { ClientName, ServerConfig, TrackedTool, ServerStats, BudgetState } from '../types.js';
import { measureToolCost } from '../tokens.js';
import {
  readPersistedData,
  incrementCallCount,
  toolKey,
} from '../store.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../../package.json') as { version: string };

const MODEL_LIMIT = 200_000;
const SESSION_STARTED = new Date();
const RESOURCE_PROXY_PREFIX = 'mcp-gauge+resource://';

const serverStats = new Map<string, ServerStats>();
export const stateEmitter = new EventEmitter();

let runtimeClient: ClientName = 'claude';

interface UpstreamConnection {
  client: Client;
  serverName: string;
  capabilities: ServerCapabilities;
}

interface PromptRoute {
  serverName: string;
  promptName: string;
}

interface ResourceRoute {
  serverName: string;
  uri: string;
}

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
  await refreshServerTools(serverName, client);

  return {
    client,
    serverName,
    capabilities: client.getServerCapabilities() ?? {},
  };
}

async function refreshServerTools(
  serverName: string,
  client: Client
): Promise<void> {
  const persisted = readPersistedData(runtimeClient);

  let tools: Tool[] = [];
  try {
    const result = await client.listTools();
    tools = result.tools;
  } catch {
    serverStats.set(serverName, {
      name: serverName,
      totalTokens: 0,
      toolCount: 0,
      disabledCount: 0,
      tools: [],
      connected: true,
    });
    emitStateUpdate();
    return;
  }

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

export async function startProxy(
  serverConfigs: Record<string, ServerConfig>,
  clientName: ClientName = 'claude'
): Promise<void> {
  runtimeClient = clientName;
  serverStats.clear();

  const connections = new Map<string, UpstreamConnection>();

  await Promise.allSettled(
    Object.entries(serverConfigs).map(async ([name, config]) => {
      try {
        const conn = await connectToServer(name, config);
        connections.set(name, conn);
      } catch (err) {
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

  const server = new Server(
    { name: 'mcp-gauge', version: PKG_VERSION },
    { capabilities: aggregateCapabilities(connections) }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const persisted = readPersistedData(runtimeClient);
    const nameCount = new Map<string, number>();

    for (const serverName of connections.keys()) {
      const stats = serverStats.get(serverName);
      if (!stats) continue;
      for (const tracked of stats.tools) {
        const key = toolKey(serverName, tracked.name);
        if (persisted.disabledTools[key]) continue;
        nameCount.set(tracked.name, (nameCount.get(tracked.name) ?? 0) + 1);
      }
    }

    const allTools: Tool[] = [];
    for (const serverName of connections.keys()) {
      const stats = serverStats.get(serverName);
      if (!stats) continue;

      for (const tracked of stats.tools) {
        const key = toolKey(serverName, tracked.name);
        if (persisted.disabledTools[key]) continue;

        const hasCollision = (nameCount.get(tracked.name) ?? 0) > 1;
        const exposedName = hasCollision
          ? namespaceName(serverName, tracked.name)
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: incomingName, arguments: args } = request.params;
    const route = findToolRoute(incomingName, connections);

    if (!route) {
      throw new Error(`Unknown tool: ${incomingName}`);
    }

    const conn = connections.get(route.serverName);
    if (!conn) {
      throw new Error(`Server not connected: ${route.serverName}`);
    }

    incrementCallCount(route.serverName, route.toolName, runtimeClient);

    const stats = serverStats.get(route.serverName);
    if (stats) {
      const tool = stats.tools.find((t: TrackedTool) => t.name === route.toolName);
      if (tool) {
        tool.callCount += 1;
        tool.totalCallCount += 1;
        tool.lastCalledAt = new Date();
      }
    }

    emitStateUpdate();

    return conn.client.callTool({ name: route.toolName, arguments: args ?? {} });
  });

  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    return { prompts: await listPrompts(connections, request.params) };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const route = await findPromptRoute(request.params.name, connections);
    if (!route) {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    const conn = connections.get(route.serverName);
    if (!conn) {
      throw new Error(`Server not connected: ${route.serverName}`);
    }
    return conn.client.getPrompt({
      ...request.params,
      name: route.promptName,
    });
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    return { resources: await listResources(connections, request.params) };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    return { resourceTemplates: await listResourceTemplates(connections, request.params) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const route = await findResourceRoute(request.params.uri, connections);
    if (!route) {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }
    const conn = connections.get(route.serverName);
    if (!conn) {
      throw new Error(`Server not connected: ${route.serverName}`);
    }
    return conn.client.readResource({
      ...request.params,
      uri: route.uri,
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('[mcp-gauge] Proxy running\n');
}

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
  stats.disabledCount = stats.tools.filter(t => t.disabled).length;

  emitStateUpdate();
}

function aggregateCapabilities(connections: Map<string, UpstreamConnection>): ServerCapabilities {
  const capabilities: ServerCapabilities = {};
  for (const conn of connections.values()) {
    if (conn.capabilities.tools) capabilities.tools = {};
    if (conn.capabilities.prompts) capabilities.prompts = {};
    if (conn.capabilities.resources) capabilities.resources = {};
  }
  return capabilities;
}

function namespaceName(serverName: string, name: string): string {
  return `${serverName}__${name}`;
}

function splitNamespacedName(name: string): { serverName: string; itemName: string } | null {
  const separatorIndex = name.indexOf('__');
  if (separatorIndex === -1) return null;
  return {
    serverName: name.slice(0, separatorIndex),
    itemName: name.slice(separatorIndex + 2),
  };
}

function findToolRoute(
  incomingName: string,
  connections: Map<string, UpstreamConnection>
): { serverName: string; toolName: string } | null {
  const namespaced = splitNamespacedName(incomingName);
  if (namespaced && connections.has(namespaced.serverName)) {
    return { serverName: namespaced.serverName, toolName: namespaced.itemName };
  }

  for (const [serverName, stats] of serverStats.entries()) {
    if (stats.tools.some((t: TrackedTool) => t.name === incomingName)) {
      return { serverName, toolName: incomingName };
    }
  }

  return null;
}

async function listPrompts(
  connections: Map<string, UpstreamConnection>,
  params: Parameters<Client['listPrompts']>[0]
): Promise<Prompt[]> {
  const promptGroups: Array<{ serverName: string; prompt: Prompt }> = [];

  for (const conn of connections.values()) {
    if (!conn.capabilities.prompts) continue;
    try {
      const result = await conn.client.listPrompts(params);
      for (const prompt of result.prompts) {
        promptGroups.push({ serverName: conn.serverName, prompt });
      }
    } catch {
      // Ignore upstreams that advertised prompts but fail this request.
    }
  }

  const nameCount = countBy(promptGroups.map(({ prompt }) => prompt.name));
  return promptGroups.map(({ serverName, prompt }) => {
    const hasCollision = (nameCount.get(prompt.name) ?? 0) > 1;
    return {
      ...prompt,
      name: hasCollision ? namespaceName(serverName, prompt.name) : prompt.name,
    };
  });
}

async function findPromptRoute(
  incomingName: string,
  connections: Map<string, UpstreamConnection>
): Promise<PromptRoute | null> {
  const namespaced = splitNamespacedName(incomingName);
  if (namespaced && connections.has(namespaced.serverName)) {
    return { serverName: namespaced.serverName, promptName: namespaced.itemName };
  }

  const matches: PromptRoute[] = [];
  for (const conn of connections.values()) {
    if (!conn.capabilities.prompts) continue;
    try {
      const result = await conn.client.listPrompts();
      if (result.prompts.some((prompt) => prompt.name === incomingName)) {
        matches.push({ serverName: conn.serverName, promptName: incomingName });
      }
    } catch {
      // Ignore failed prompt lists while looking for a route.
    }
  }

  return matches.length === 1 ? matches[0] : null;
}

async function listResources(
  connections: Map<string, UpstreamConnection>,
  params: Parameters<Client['listResources']>[0]
): Promise<Resource[]> {
  const resourceGroups: Array<{ serverName: string; resource: Resource }> = [];

  for (const conn of connections.values()) {
    if (!conn.capabilities.resources) continue;
    try {
      const result = await conn.client.listResources(params);
      for (const resource of result.resources) {
        resourceGroups.push({ serverName: conn.serverName, resource });
      }
    } catch {
      // Ignore upstreams that advertised resources but fail this request.
    }
  }

  const uriCount = countBy(resourceGroups.map(({ resource }) => resource.uri));
  return resourceGroups.map(({ serverName, resource }) => {
    const hasCollision = (uriCount.get(resource.uri) ?? 0) > 1;
    return {
      ...resource,
      uri: hasCollision ? proxyResourceUri(serverName, resource.uri) : resource.uri,
    };
  });
}

async function listResourceTemplates(
  connections: Map<string, UpstreamConnection>,
  params: Parameters<Client['listResourceTemplates']>[0]
): Promise<ResourceTemplate[]> {
  const templates: ResourceTemplate[] = [];

  for (const conn of connections.values()) {
    if (!conn.capabilities.resources) continue;
    try {
      const result = await conn.client.listResourceTemplates(params);
      templates.push(...result.resourceTemplates);
    } catch {
      // Resource templates are optional within the resources capability.
    }
  }

  return templates;
}

async function findResourceRoute(
  incomingUri: string,
  connections: Map<string, UpstreamConnection>
): Promise<ResourceRoute | null> {
  const proxied = parseProxyResourceUri(incomingUri);
  if (proxied && connections.has(proxied.serverName)) {
    return proxied;
  }

  const staticMatches = await findStaticResourceRoutes(incomingUri, connections);
  if (staticMatches.length === 1) return staticMatches[0];
  if (staticMatches.length > 1) {
    throw new Error(`Ambiguous resource URI: ${incomingUri}`);
  }

  const templateMatches = await findTemplateResourceRoutes(incomingUri, connections);
  if (templateMatches.length === 1) return templateMatches[0];
  if (templateMatches.length > 1) {
    throw new Error(`Ambiguous resource template URI: ${incomingUri}`);
  }

  return null;
}

async function findStaticResourceRoutes(
  uri: string,
  connections: Map<string, UpstreamConnection>
): Promise<ResourceRoute[]> {
  const matches: ResourceRoute[] = [];
  for (const conn of connections.values()) {
    if (!conn.capabilities.resources) continue;
    try {
      const result = await conn.client.listResources();
      if (result.resources.some((resource) => resource.uri === uri)) {
        matches.push({ serverName: conn.serverName, uri });
      }
    } catch {
      // Ignore failed resource lists while looking for a route.
    }
  }
  return matches;
}

async function findTemplateResourceRoutes(
  uri: string,
  connections: Map<string, UpstreamConnection>
): Promise<ResourceRoute[]> {
  const matches: ResourceRoute[] = [];
  for (const conn of connections.values()) {
    if (!conn.capabilities.resources) continue;
    try {
      const result = await conn.client.listResourceTemplates();
      for (const template of result.resourceTemplates) {
        if (templateMatchesUri(template.uriTemplate, uri)) {
          matches.push({ serverName: conn.serverName, uri });
          break;
        }
      }
    } catch {
      // Ignore failed template lists while looking for a route.
    }
  }
  return matches;
}

function templateMatchesUri(uriTemplate: string, uri: string): boolean {
  try {
    return new UriTemplate(uriTemplate).match(uri) !== null;
  } catch {
    return false;
  }
}

function proxyResourceUri(serverName: string, uri: string): string {
  return `${RESOURCE_PROXY_PREFIX}${encodeURIComponent(serverName)}/${encodeURIComponent(uri)}`;
}

function parseProxyResourceUri(uri: string): ResourceRoute | null {
  if (!uri.startsWith(RESOURCE_PROXY_PREFIX)) return null;
  const rest = uri.slice(RESOURCE_PROXY_PREFIX.length);
  const separatorIndex = rest.indexOf('/');
  if (separatorIndex === -1) return null;
  return {
    serverName: decodeURIComponent(rest.slice(0, separatorIndex)),
    uri: decodeURIComponent(rest.slice(separatorIndex + 1)),
  };
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
