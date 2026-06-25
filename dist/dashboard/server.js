"use strict";
/**
 * Local dashboard server
 *
 * - Serves the HTML dashboard on http://localhost:<port>
 * - Tries the preferred port, falls back to OS-assigned if busy
 * - Writes the actual port to ~/.mcp-gauge/port so `status` can find it
 * - Pushes live BudgetState updates over WebSocket
 * - Exposes a REST API for the dashboard to toggle tools
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startDashboard = startDashboard;
const express_1 = __importDefault(require("express"));
const ws_1 = require("ws");
const http_1 = __importDefault(require("http"));
const net_1 = __importDefault(require("net"));
const proxy_js_1 = require("../proxy/proxy.js");
const store_js_1 = require("../store.js");
// ─── Port finding ─────────────────────────────────────────────────────────────
function findAvailablePort(preferred) {
    return new Promise((resolve) => {
        const probe = net_1.default.createServer();
        probe.listen(preferred, '127.0.0.1', () => {
            const addr = probe.address();
            probe.close(() => resolve(addr.port));
        });
        probe.on('error', () => {
            // Preferred port is busy — ask the OS for any free port
            const fallback = net_1.default.createServer();
            fallback.listen(0, '127.0.0.1', () => {
                const addr = fallback.address();
                fallback.close(() => resolve(addr.port));
            });
        });
    });
}
// ─── Dashboard HTML ───────────────────────────────────────────────────────────
// Single-file, zero-dependency dashboard. Intentionally simple.
// WebSocket client polls for state and re-renders on every update.
function renderDashboard(port) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>mcp-gauge — Token Budget</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace;
      background: #0d1117; color: #e6edf3; padding: 24px;
      font-size: 14px; line-height: 1.5;
    }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
    .subtitle { color: #7d8590; margin-bottom: 24px; font-size: 13px; }

    /* Restart notice */
    .restart-notice {
      display: none;
      background: #2d1f00; border: 1px solid #5a3e00;
      border-radius: 8px; padding: 12px 16px;
      margin-bottom: 20px; font-size: 13px; color: #e3b341;
    }
    .restart-notice.visible { display: block; }

    /* Budget bar */
    .budget-section { margin-bottom: 32px; }
    .budget-numbers {
      display: flex; justify-content: space-between;
      margin-bottom: 8px; font-size: 13px; color: #7d8590;
    }
    .budget-numbers .active { color: #e6edf3; font-weight: 600; font-size: 15px; }
    .budget-numbers .saved { color: #3fb950; }
    .bar-track {
      height: 10px; background: #21262d; border-radius: 6px; overflow: hidden;
    }
    .bar-fill {
      height: 100%; border-radius: 6px; transition: width 0.4s ease;
      background: linear-gradient(90deg, #1f6feb, #388bfd);
    }
    .bar-fill.warning { background: linear-gradient(90deg, #d29922, #e3b341); }
    .bar-fill.danger  { background: linear-gradient(90deg, #b62324, #f85149); }

    /* Stats row */
    .stats { display: flex; gap: 24px; margin-bottom: 32px; }
    .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px;
            padding: 14px 18px; flex: 1; }
    .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
                  color: #7d8590; margin-bottom: 4px; }
    .stat-value { font-size: 22px; font-weight: 700; }
    .stat-value.green { color: #3fb950; }
    .stat-value.yellow { color: #e3b341; }

    /* Server blocks */
    .server { margin-bottom: 28px; }
    .server-header {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 10px; padding-bottom: 8px;
      border-bottom: 1px solid #21262d;
    }
    .server-name { font-weight: 600; font-size: 15px; }
    .server-tokens { color: #7d8590; font-size: 12px; margin-left: auto; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; }
    .dot.offline { background: #f85149; }

    /* Tool table */
    table { width: 100%; border-collapse: collapse; }
    thead th {
      text-align: left; font-size: 11px; text-transform: uppercase;
      letter-spacing: 0.06em; color: #7d8590; padding: 6px 8px;
      border-bottom: 1px solid #21262d;
    }
    tbody tr { border-bottom: 1px solid #161b22; }
    tbody tr:hover { background: #161b22; }
    tbody tr.disabled { opacity: 0.45; }
    td { padding: 8px 8px; font-size: 13px; }
    .tool-name { font-family: monospace; font-size: 12px; }
    .tokens { color: #7d8590; font-variant-numeric: tabular-nums; }
    .calls { font-variant-numeric: tabular-nums; }
    .never { color: #7d8590; font-style: italic; }
    .badge {
      display: inline-block; padding: 2px 7px; border-radius: 12px;
      font-size: 11px; font-weight: 500;
    }
    .badge.unused { background: #3d1f00; color: #e3b341; }
    .badge.active { background: #0d1a0d; color: #3fb950; }

    /* Toggle */
    .toggle {
      position: relative; width: 36px; height: 20px; cursor: pointer;
    }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; inset: 0; background: #21262d;
      border-radius: 20px; transition: 0.2s;
    }
    .slider:before {
      position: absolute; content: ''; height: 14px; width: 14px;
      left: 3px; bottom: 3px; background: #7d8590;
      border-radius: 50%; transition: 0.2s;
    }
    input:checked + .slider { background: #1f6feb; }
    input:checked + .slider:before {
      transform: translateX(16px); background: white;
    }

    /* Recommendations */
    .recs { background: #0d1a0d; border: 1px solid #1a4d1a;
            border-radius: 8px; padding: 16px; margin-bottom: 28px; }
    .recs h3 { color: #3fb950; margin-bottom: 10px; font-size: 14px; }
    .rec { margin-bottom: 6px; font-size: 13px; }
    .rec button {
      background: #1f6feb; color: white; border: none; border-radius: 4px;
      padding: 2px 10px; cursor: pointer; font-size: 12px; margin-left: 8px;
    }
    .rec button:hover { background: #388bfd; }

    .footer { color: #7d8590; font-size: 12px; margin-top: 32px; }
  </style>
</head>
<body>
  <h1>⚡ mcp-gauge</h1>
  <p class="subtitle">Live token budget for your MCP tools</p>

  <div id="restart-notice" class="restart-notice">
    ⚠ Tool changes are queued — restart Claude Desktop to apply them.
  </div>

  <div id="app">
    <p style="color: #7d8590">Connecting to proxy...</p>
  </div>

  <script>
    const ws = new WebSocket('ws://localhost:${port}/ws');
    let state = null;
    let pendingChanges = false;

    ws.onmessage = (e) => {
      state = JSON.parse(e.data);
      render(state);
    };

    ws.onclose = () => {
      document.getElementById('app').innerHTML =
        '<p style="color:#f85149">⚠️ Proxy disconnected. Restart mcp-gauge.</p>';
    };

    function toggle(serverName, toolName, enabled) {
      fetch('/api/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverName, toolName, disabled: !enabled })
      }).then(() => {
        pendingChanges = true;
        document.getElementById('restart-notice').classList.add('visible');
      });
    }

    function disableUnused() {
      if (!state) return;
      const toggles = [];
      for (const server of state.servers) {
        for (const tool of server.tools) {
          if (tool.totalCallCount === 0 && !tool.disabled) {
            toggles.push({ serverName: server.name, toolName: tool.name, disabled: true });
          }
        }
      }
      // Send sequentially to avoid data.json race conditions
      toggles.reduce((p, t) =>
        p.then(() => fetch('/api/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(t)
        })),
        Promise.resolve()
      ).then(() => {
        pendingChanges = true;
        document.getElementById('restart-notice').classList.add('visible');
      });
    }

    function fmt(n) {
      return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n.toString();
    }

    function pct(n, limit) {
      return Math.round((n / limit) * 100);
    }

    function render(s) {
      const usedPct = pct(s.activeTokens, s.modelLimit);
      const barClass = usedPct > 70 ? 'danger' : usedPct > 40 ? 'warning' : '';

      const unusedTools = s.servers.flatMap(sv =>
        sv.tools.filter(t => t.totalCallCount === 0 && !t.disabled)
          .map(t => ({ ...t, serverName: sv.name }))
      );
      const unusedTokens = unusedTools.reduce((sum, t) => sum + t.tokenCost, 0);

      let recsHtml = '';
      if (unusedTools.length > 0) {
        recsHtml = \`
          <div class="recs">
            <h3>💡 Recommendations</h3>
            <div class="rec">
              <strong>\${unusedTools.length} tools</strong> (\${fmt(unusedTokens)} tokens)
              have never been called this session.
              <button onclick="disableUnused()">Disable all</button>
            </div>
          </div>
        \`;
      }

      const serversHtml = s.servers.map(sv => {
        const toolRows = sv.tools.map(t => {
          const badge = t.totalCallCount === 0 && !t.disabled
            ? '<span class="badge unused">never used</span>'
            : t.callCount > 0
              ? '<span class="badge active">active</span>'
              : '';
          return \`
            <tr class="\${t.disabled ? 'disabled' : ''}">
              <td>
                <label class="toggle">
                  <input type="checkbox" \${t.disabled ? '' : 'checked'}
                    onchange="toggle('\${sv.name}', '\${t.name}', this.checked)">
                  <span class="slider"></span>
                </label>
              </td>
              <td class="tool-name">\${t.name}</td>
              <td class="tokens">\${fmt(t.tokenCost)}</td>
              <td class="calls">
                \${t.totalCallCount > 0
                  ? t.totalCallCount
                  : '<span class="never">—</span>'}
              </td>
              <td>\${badge}</td>
            </tr>
          \`;
        }).join('');

        return \`
          <div class="server">
            <div class="server-header">
              <div class="dot \${sv.connected ? '' : 'offline'}"></div>
              <span class="server-name">\${sv.name}</span>
              <span class="server-tokens">
                \${fmt(sv.totalTokens)} tokens · \${sv.toolCount} tools
                \${sv.disabledCount > 0 ? '· ' + sv.disabledCount + ' disabled' : ''}
              </span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>On</th><th>Tool</th><th>Tokens</th>
                  <th>Calls (all time)</th><th></th>
                </tr>
              </thead>
              <tbody>\${toolRows}</tbody>
            </table>
          </div>
        \`;
      }).join('');

      document.getElementById('app').innerHTML = \`
        <div class="budget-section">
          <div class="budget-numbers">
            <span class="active">\${fmt(s.activeTokens)} tokens used by tools</span>
            <span class="saved">saved \${fmt(s.savedTokens)} tokens</span>
            <span>\${usedPct}% of \${fmt(s.modelLimit)} limit</span>
          </div>
          <div class="bar-track">
            <div class="bar-fill \${barClass}" style="width: \${Math.min(usedPct, 100)}%"></div>
          </div>
        </div>

        <div class="stats">
          <div class="stat">
            <div class="stat-label">Active tokens</div>
            <div class="stat-value">\${fmt(s.activeTokens)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Tokens saved</div>
            <div class="stat-value green">\${fmt(s.savedTokens)}</div>
          </div>
          <div class="stat">
            <div class="stat-label">Never-used tools</div>
            <div class="stat-value yellow">\${unusedTools.length}</div>
          </div>
        </div>

        \${recsHtml}
        \${serversHtml}

        <p class="footer">
          Updates live · Session started \${new Date(s.sessionStartedAt).toLocaleTimeString()}
        </p>
      \`;

      // Re-show notice if there are pending changes (render replaces DOM)
      if (pendingChanges) {
        document.getElementById('restart-notice').classList.add('visible');
      }
    }
  </script>
</body>
</html>`;
}
// ─── Server startup ───────────────────────────────────────────────────────────
async function startDashboard(preferredPort = 3456) {
    const port = await findAvailablePort(preferredPort);
    if (port !== preferredPort) {
        process.stderr.write(`[mcp-gauge] Port ${preferredPort} in use, using ${port} instead\n`);
    }
    // Persist the actual port so `mcp-gauge status` can find it
    (0, store_js_1.writePort)(port);
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    // Serve dashboard
    app.get('/', (_req, res) => {
        res.send(renderDashboard(port));
    });
    // Toggle tool enabled/disabled
    app.post('/api/toggle', (req, res) => {
        const { serverName, toolName, disabled } = req.body;
        (0, store_js_1.setToolDisabled)(serverName, toolName, disabled);
        (0, proxy_js_1.updateToolState)(serverName, toolName, disabled);
        res.json({ ok: true });
    });
    // Current state snapshot (for `mcp-gauge status`)
    app.get('/api/state', (_req, res) => {
        res.json((0, proxy_js_1.getBudgetState)());
    });
    const httpServer = http_1.default.createServer(app);
    // WebSocket for live state push
    const wss = new ws_1.WebSocketServer({ server: httpServer, path: '/ws' });
    const clients = new Set();
    wss.on('connection', (ws) => {
        clients.add(ws);
        // Send current state immediately on connect
        ws.send(JSON.stringify((0, proxy_js_1.getBudgetState)()));
        ws.on('close', () => clients.delete(ws));
    });
    // Push state to all connected dashboard tabs on every update
    proxy_js_1.stateEmitter.on('update', (state) => {
        const payload = JSON.stringify(state);
        for (const client of clients) {
            if (client.readyState === ws_1.WebSocket.OPEN) {
                client.send(payload);
            }
        }
    });
    await new Promise((resolve) => {
        httpServer.listen(port, '127.0.0.1', () => {
            process.stderr.write(`[mcp-gauge] Dashboard at http://localhost:${port}\n`);
            resolve();
        });
    });
}
