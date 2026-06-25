/**
 * mcp-gauge init / uninstall
 *
 * init:
 *   - Reads the existing Claude Desktop config
 *   - Replaces all MCP servers with the proxy entry (backing up first)
 *   - Safe to re-run: picks up any newly added servers
 *
 * uninstall:
 *   - Rebuilds the config from the backup + the full launch.json server list,
 *     so servers added after the initial install are not lost
 */
export declare function runInit(): void;
export declare function runUninstall(): void;
