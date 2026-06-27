export interface ServerConfig {
    command: string;
    args: string[];
    env?: Record<string, string>;
    originalBlock?: string;
    [key: string]: unknown;
}
export interface ClaudeConfig {
    mcpServers: Record<string, ServerConfig>;
    [key: string]: unknown;
}
export type ClientName = 'claude' | 'codex';
export interface ToolDefinition {
    name: string;
    description?: string;
    inputSchema?: object;
}
export interface TrackedTool {
    name: string;
    serverName: string;
    tokenCost: number;
    callCount: number;
    totalCallCount: number;
    lastCalledAt: Date | null;
    disabled: boolean;
    definition: ToolDefinition;
}
export interface ServerStats {
    name: string;
    totalTokens: number;
    toolCount: number;
    disabledCount: number;
    tools: TrackedTool[];
    connected: boolean;
}
export interface BudgetState {
    totalTokens: number;
    activeTokens: number;
    savedTokens: number;
    modelLimit: number;
    servers: ServerStats[];
    lastUpdatedAt: Date;
    sessionStartedAt: Date;
}
export interface PersistedData {
    toolCallCounts: Record<string, number>;
    disabledTools: Record<string, boolean>;
    lastSeenAt: Record<string, string>;
}
