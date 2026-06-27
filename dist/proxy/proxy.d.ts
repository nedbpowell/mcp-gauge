/**
 * MCP Proxy Server
 *
 * The proxy starts real stdio MCP servers as child processes, measures and
 * filters tools, then forwards prompts and resources so clients keep the same
 * non-tool MCP surface while mcp-gauge is installed.
 */
import EventEmitter from 'events';
import { ClientName, ServerConfig, BudgetState } from '../types.js';
export declare const stateEmitter: EventEmitter<[never]>;
export declare function getBudgetState(): BudgetState;
export declare function startProxy(serverConfigs: Record<string, ServerConfig>, clientName?: ClientName): Promise<void>;
export declare function updateToolState(serverName: string, toolName: string, disabled: boolean): void;
