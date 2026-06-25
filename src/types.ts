// ─── Core Types ──────────────────────────────────────────────────────────────

export interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ClaudeConfig {
  mcpServers: Record<string, ServerConfig>;
  [key: string]: unknown; // preserve other top-level keys (globalShortcut, theme, etc.)
}

// One MCP tool as reported by a server
export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: object;
}

// Everything we know about a tool, enriched by the proxy
export interface TrackedTool {
  name: string;
  serverName: string;
  tokenCost: number;          // tokens consumed by this tool's definition
  callCount: number;          // times called in current session
  totalCallCount: number;     // times called all-time (persisted)
  lastCalledAt: Date | null;
  disabled: boolean;
  definition: ToolDefinition;
}

// Per-server summary
export interface ServerStats {
  name: string;
  totalTokens: number;
  toolCount: number;
  disabledCount: number;
  tools: TrackedTool[];
  connected: boolean;
}

// The full state the dashboard reads
export interface BudgetState {
  totalTokens: number;
  activeTokens: number;       // tokens from enabled tools only
  savedTokens: number;        // tokens from disabled tools
  modelLimit: number;
  servers: ServerStats[];
  lastUpdatedAt: Date;
  sessionStartedAt: Date;
}

// Persisted data (written to ~/.mcp-gauge/data.json)
export interface PersistedData {
  toolCallCounts: Record<string, number>; // "serverName::toolName" -> count
  disabledTools: Record<string, boolean>; // "serverName::toolName" -> true
  lastSeenAt: Record<string, string>;     // "serverName::toolName" -> ISO date
}
