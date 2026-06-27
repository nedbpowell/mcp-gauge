import { PersistedData, ClaudeConfig, ServerConfig, ClientName } from './types.js';
export interface LaunchState {
    upstreamConfigs: Record<string, ServerConfig>;
}
export declare function getClaudeConfigPath(): string;
export declare function readClaudeConfig(): ClaudeConfig;
export declare function writeClaudeConfig(config: ClaudeConfig): void;
export declare function backupClaudeConfig(): void;
export declare function getCodexConfigPath(): string;
export declare function readCodexConfigText(): string;
export declare function writeCodexConfigText(configText: string): void;
export declare function backupCodexConfig(): void;
export declare function getCodexBackupPath(): string;
export declare function readCodexBackupText(): string | null;
export declare function readCodexStdioServers(configText: string): Record<string, ServerConfig>;
export declare function rewriteCodexMcpServers(configText: string, proxiedServerNames: string[], proxyEntry: ServerConfig | null): string;
export declare function restoreCodexMcpServers(configText: string, servers: Record<string, ServerConfig>): string;
export declare function codexServersToToml(servers: Record<string, ServerConfig>): string;
export declare function readPersistedData(client?: ClientName): PersistedData;
export declare function writePersistedData(data: PersistedData, client?: ClientName): void;
export declare function toolKey(serverName: string, toolName: string): string;
export declare function incrementCallCount(serverName: string, toolName: string, client?: ClientName): void;
export declare function setToolDisabled(serverName: string, toolName: string, disabled: boolean, client?: ClientName): void;
export declare function readLaunchState(client?: ClientName): LaunchState;
export declare function readLaunchConfig(client?: ClientName): Record<string, ServerConfig>;
export declare function writeLaunchState(state: LaunchState, client?: ClientName): void;
export declare function writeLaunchConfig(upstreamConfigs: Record<string, ServerConfig>, client?: ClientName): void;
export declare function readPort(client?: ClientName): number;
export declare function writePort(port: number, client?: ClientName): void;
