/**
 * mcp-gauge init / uninstall
 *
 * init:
 *   - Reads the existing client config
 *   - Replaces all MCP servers with the proxy entry (backing up first)
 *   - Safe to re-run: picks up any newly added servers
 *
 * uninstall:
 *   - Rebuilds the config from the backup + the full launch.json server list,
 *     so servers added after the initial install are not lost
 */
import { ClientName } from '../types.js';
export declare function runInit(client?: ClientName): void;
export declare function runUninstall(client?: ClientName): void;
