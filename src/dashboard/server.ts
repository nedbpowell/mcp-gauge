/**
 * Local dashboard server
 *
 * - Serves the HTML dashboard on http://localhost:<port>
 * - Tries the preferred port, falls back to OS-assigned if busy
 * - Writes the actual port to ~/.mcp-gauge/port so `status` can find it
 * - Pushes live BudgetState updates over WebSocket
 * - Exposes a REST API for the dashboard to toggle tools
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import net from 'net';
import { stateEmitter, getBudgetState, updateToolState } from '../proxy/proxy.js';
import { setToolDisabled, writePort } from '../store.js';
import { BudgetState, ClientName } from '../types.js';
import { getCodexUsageSummary } from '../codex/usage.js';

export interface DashboardHandle {
  port: number;
  close: () => Promise<void>;
}

// ─── Port finding ─────────────────────────────────────────────────────────────

function findAvailablePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(preferred, '127.0.0.1', () => {
      const addr = probe.address() as net.AddressInfo;
      probe.close(() => resolve(addr.port));
    });
    probe.on('error', () => {
      // Preferred port is busy — ask the OS for any free port
      const fallback = net.createServer();
      fallback.listen(0, '127.0.0.1', () => {
        const addr = fallback.address() as net.AddressInfo;
        fallback.close(() => resolve(addr.port));
      });
    });
  });
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
// Single-file, zero-dependency dashboard. Intentionally simple.
// WebSocket client polls for state and re-renders on every update.

function renderDashboard(port: number): string {
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

    .codex-section { margin-bottom: 32px; }
    .section-title { font-size: 15px; font-weight: 600; margin-bottom: 10px; }
    .codex-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
    .codex-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; }
    .codex-label { color: #7d8590; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
    .codex-value { font-size: 18px; font-weight: 700; }
    .codex-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .codex-wide { margin-top: 16px; }
    .codex-bars { display: flex; flex-direction: column; gap: 7px; }
    .codex-bar-row { display: grid; grid-template-columns: 88px 1fr 92px; gap: 10px; align-items: center; }
    .codex-bar-track { height: 8px; background: #21262d; border-radius: 4px; overflow: hidden; }
    .codex-bar-fill { height: 100%; background: #388bfd; border-radius: 4px; }
    .recommendations { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; }
    .recommendations li { margin-left: 18px; padding: 3px 0; }
    .compact-list { list-style: none; border-top: 1px solid #21262d; }
    .compact-list li { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid #161b22; }
    .compact-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .compact-meta { color: #7d8590; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .codex-diagnostics { color: #7d8590; font-size: 12px; margin-top: 12px; }

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
    let codexUsage = null;
    let pendingChanges = false;

    fetch('/api/codex-usage?days=7')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        codexUsage = data;
        if (state) render(state);
      })
      .catch(() => {});

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

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[ch]));
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

      const codexHtml = renderCodexUsage();

      document.getElementById('app').innerHTML = \`
        \${codexHtml}

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

    function renderCodexUsage() {
      if (!codexUsage) return '';
      const recommendations = codexUsage.recommendations.slice(0, 3).map(rec => \`
        <li>\${esc(rec.message)}</li>
      \`).join('');
      const tools = codexUsage.toolCalls.slice(0, 6).map(tool => \`
        <li>
          <span class="compact-name">\${esc(tool.name)}</span>
          <span class="compact-meta">\${fmt(tool.calls)} calls\${tool.failures ? ' · ' + fmt(tool.failures) + ' failed' : ''}</span>
        </li>
      \`).join('');
      const projects = codexUsage.projects.slice(0, 6).map(project => \`
        <li title="\${esc(project.cwd)}">
          <span class="compact-name">\${esc(project.displayName)}</span>
          <span class="compact-meta">\${fmt(project.totalTokens)} tokens</span>
        </li>
      \`).join('');
      const sessions = codexUsage.topSessions.slice(0, 5).map(session => \`
        <li title="\${esc(session.cwd || '')}">
          <span class="compact-name">\${esc(session.projectDisplayName)}</span>
          <span class="compact-meta">\${fmt(session.totalTokens)} tokens · \${fmt(session.toolCalls)} calls\${session.toolFailures ? ' · ' + fmt(session.toolFailures) + ' failed' : ''}</span>
        </li>
      \`).join('');
      const hotspots = codexUsage.failureHotspots.slice(0, 5).map(hotspot => \`
        <li title="\${esc(hotspot.cwd || '')}">
          <span class="compact-name">\${esc(hotspot.projectDisplayName)} · \${esc(hotspot.toolName)}</span>
          <span class="compact-meta">\${fmt(hotspot.failures)} failed / \${fmt(hotspot.calls)} calls</span>
        </li>
      \`).join('');
      const maxDaily = Math.max(1, ...codexUsage.dailyUsage.map(day => day.totalTokens));
      const daily = codexUsage.dailyUsage.map(day => \`
        <div class="codex-bar-row">
          <span class="compact-meta">\${esc(day.date)}</span>
          <div class="codex-bar-track"><div class="codex-bar-fill" style="width:\${Math.max(3, Math.round((day.totalTokens / maxDaily) * 100))}%"></div></div>
          <span class="compact-meta">\${fmt(day.totalTokens)}</span>
        </div>
      \`).join('');
      const context = codexUsage.latestContextUsagePercent === null ? 'n/a' : codexUsage.latestContextUsagePercent + '%';
      const primaryLimit = codexUsage.latestRateLimits.primaryUsedPercent === null ? 'n/a' : codexUsage.latestRateLimits.primaryUsedPercent + '%';
      const secondaryLimit = codexUsage.latestRateLimits.secondaryUsedPercent === null ? 'n/a' : codexUsage.latestRateLimits.secondaryUsedPercent + '%';
      const diagnostics = codexUsage.skippedLines > 0
        ? '<div class="codex-diagnostics">Skipped malformed lines: ' + fmt(codexUsage.skippedLines) + '</div>'
        : '';

      return \`
        <div class="codex-section">
          <div class="section-title">Codex Usage</div>
          \${recommendations ? '<div class="recommendations"><div class="codex-label">Suggestions</div><ul>' + recommendations + '</ul></div>' : ''}
          <div class="codex-grid">
            <div class="codex-card">
              <div class="codex-label">Sessions</div>
              <div class="codex-value">\${fmt(codexUsage.sessionsScanned)}</div>
            </div>
            <div class="codex-card">
              <div class="codex-label">Tokens</div>
              <div class="codex-value">\${fmt(codexUsage.totalTokenUsage.totalTokens)}</div>
            </div>
            <div class="codex-card">
              <div class="codex-label">Context</div>
              <div class="codex-value">\${context}</div>
            </div>
            <div class="codex-card">
              <div class="codex-label">Rate limits</div>
              <div class="codex-value">\${primaryLimit} / \${secondaryLimit}</div>
            </div>
          </div>
          <div class="codex-columns">
            <div>
              <div class="codex-label">Top built-in tools</div>
              <ul class="compact-list">\${tools || '<li><span class="compact-meta">No tool calls found</span></li>'}</ul>
            </div>
            <div>
              <div class="codex-label">Top projects</div>
              <ul class="compact-list">\${projects || '<li><span class="compact-meta">No projects found</span></li>'}</ul>
            </div>
          </div>
          <div class="codex-columns codex-wide">
            <div>
              <div class="codex-label">Biggest sessions</div>
              <ul class="compact-list">\${sessions || '<li><span class="compact-meta">No sessions found</span></li>'}</ul>
            </div>
            <div>
              <div class="codex-label">Failure hotspots</div>
              <ul class="compact-list">\${hotspots || '<li><span class="compact-meta">No failures found</span></li>'}</ul>
            </div>
          </div>
          <div class="codex-wide">
            <div class="codex-label">Daily usage</div>
            <div class="codex-bars">\${daily || '<span class="compact-meta">No daily usage found</span>'}</div>
          </div>
          \${diagnostics}
        </div>
      \`;
    }
  </script>
</body>
</html>`;
}

// ─── Server startup ───────────────────────────────────────────────────────────

export async function startDashboard(
  preferredPort = 3456,
  client: ClientName = 'claude'
): Promise<DashboardHandle> {
  const port = await findAvailablePort(preferredPort);

  if (preferredPort !== 0 && port !== preferredPort) {
    process.stderr.write(
      `[mcp-gauge] Port ${preferredPort} in use, using ${port} instead\n`
    );
  }

  // Persist the actual port so `mcp-gauge status` can find it
  writePort(port, client);

  const app = express();
  app.use(express.json());

  // Serve dashboard
  app.get('/', (_req, res) => {
    res.send(renderDashboard(port));
  });

  // Toggle tool enabled/disabled
  app.post('/api/toggle', (req, res) => {
    const { serverName, toolName, disabled } = req.body as {
      serverName: string;
      toolName: string;
      disabled: boolean;
    };

    setToolDisabled(serverName, toolName, disabled, client);
    updateToolState(serverName, toolName, disabled);

    res.json({ ok: true });
  });

  // Current state snapshot (for `mcp-gauge status`)
  app.get('/api/state', (_req, res) => {
    res.json(getBudgetState());
  });

  app.get('/api/codex-usage', async (req, res) => {
    const days = typeof req.query.days === 'string' ? Number(req.query.days) : undefined;
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
    res.json(await getCodexUsageSummary({
      days: days !== undefined && Number.isFinite(days) && days > 0 ? days : undefined,
      cwd,
    }));
  });

  const httpServer = http.createServer(app);

  // WebSocket for live state push
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    // Send current state immediately on connect
    ws.send(JSON.stringify(getBudgetState()));
    ws.on('close', () => clients.delete(ws));
  });

  // Push state to all connected dashboard tabs on every update
  stateEmitter.on('update', (state: BudgetState) => {
    const payload = JSON.stringify(state);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, '127.0.0.1', () => {
      process.stderr.write(`[mcp-gauge] Dashboard at http://localhost:${port}\n`);
      resolve();
    });
  });

  return {
    port,
    close: () => new Promise<void>((resolve, reject) => {
      wss.close(() => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }),
  };
}
