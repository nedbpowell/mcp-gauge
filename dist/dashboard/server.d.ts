/**
 * Local dashboard server
 *
 * - Serves the HTML dashboard on http://localhost:<port>
 * - Tries the preferred port, falls back to OS-assigned if busy
 * - Writes the actual port to ~/.mcp-gauge/port so `status` can find it
 * - Pushes live BudgetState updates over WebSocket
 * - Exposes a REST API for the dashboard to toggle tools
 */
import { ClientName } from '../types.js';
export interface DashboardHandle {
    port: number;
    close: () => Promise<void>;
}
export declare function startDashboard(preferredPort?: number, client?: ClientName): Promise<DashboardHandle>;
