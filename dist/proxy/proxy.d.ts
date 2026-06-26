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
import EventEmitter from 'events';
import { ServerConfig, BudgetState } from '../types.js';
export declare const stateEmitter: EventEmitter<[never]>;
export declare function getBudgetState(): BudgetState;
export declare function startProxy(serverConfigs: Record<string, ServerConfig>): Promise<void>;
export declare function updateToolState(serverName: string, toolName: string, disabled: boolean): void;
