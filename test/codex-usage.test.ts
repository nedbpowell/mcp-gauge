import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { startDashboard } from '../src/dashboard/server.js';
import {
  discoverCodexLogFiles,
  formatCodexUsageSummary,
  getCodexUsageSummary,
} from '../src/codex/usage.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureCodexHome = path.join(repoRoot, 'test', 'fixtures', 'codex-logs');

test('Codex usage scanner discovers active and archived JSONL logs', async () => {
  const files = await discoverCodexLogFiles(fixtureCodexHome);
  assert.deepEqual(files.map((file) => path.relative(fixtureCodexHome, file)).sort(), [
    path.join('archived_sessions', 'old-session.jsonl'),
    path.join('archived_sessions', 'session-b.jsonl'),
    path.join('sessions', '2026', '06', 'session-a.jsonl'),
  ]);
});

test('Codex usage scanner aggregates tokens, tools, failures, cwd filters, and skipped lines', async () => {
  const summary = await getCodexUsageSummary({
    codexHome: fixtureCodexHome,
    now: new Date('2026-06-27T00:00:00.000Z'),
    days: 7,
  });

  assert.equal(summary.filesScanned, 3);
  assert.equal(summary.skippedLines, 1);
  assert.equal(summary.sessionsScanned, 2);
  assert.equal(summary.sessionsWithTokens, 1);
  assert.equal(summary.totalTokenUsage.totalTokens, 240);
  assert.equal(summary.latestContextUsagePercent, 4);
  assert.deepEqual(summary.latestRateLimits, {
    primaryUsedPercent: 3,
    secondaryUsedPercent: 4,
  });

  assert.deepEqual(summary.toolCalls.map((tool) => ({
    name: tool.name,
    calls: tool.calls,
    failures: tool.failures,
  })), [
    { name: 'exec_command', calls: 1, failures: 1 },
    { name: 'read_thread_terminal', calls: 1, failures: 0 },
  ]);

  assert.deepEqual(summary.projects.map((project) => ({
    cwd: project.cwd,
    sessions: project.sessions,
    totalTokens: project.totalTokens,
  })), [
    { cwd: '/tmp/project-a', sessions: 1, totalTokens: 240 },
    { cwd: '/tmp/project-b', sessions: 1, totalTokens: 0 },
  ]);

  assert.doesNotMatch(JSON.stringify(summary), /secret command|secret output/);

  const cwdSummary = await getCodexUsageSummary({
    codexHome: fixtureCodexHome,
    now: new Date('2026-06-27T00:00:00.000Z'),
    days: 7,
    cwd: '/tmp/project-b',
  });

  assert.equal(cwdSummary.sessionsScanned, 1);
  assert.equal(cwdSummary.toolCalls[0].name, 'read_thread_terminal');
});

test('Codex usage formatter is human-readable', async () => {
  const summary = await getCodexUsageSummary({
    codexHome: fixtureCodexHome,
    now: new Date('2026-06-27T00:00:00.000Z'),
    days: 7,
  });

  const output = formatCodexUsageSummary(summary);
  assert.match(output, /Codex Usage \(7d\)/);
  assert.match(output, /Tokens: 240 total/);
  assert.match(output, /exec_command/);
});

test('codex-usage CLI supports JSON and status fallback without a running proxy', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gauge-home-'));
  try {
    fs.cpSync(fixtureCodexHome, path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.mcp-gauge', 'clients', 'codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.mcp-gauge', 'clients', 'codex', 'port'), '9', 'utf-8');

    const env = {
      ...process.env,
      HOME: home,
      TS_NODE_TRANSPILE_ONLY: 'true',
    };

    const jsonRun = spawnSync(
      process.execPath,
      ['--loader', 'ts-node/esm', path.join(repoRoot, 'src', 'index.ts'), 'codex-usage', '--days', '7', '--json'],
      { cwd: repoRoot, env, encoding: 'utf-8' }
    );
    assert.equal(jsonRun.status, 0, jsonRun.stderr);
    const parsed = JSON.parse(jsonRun.stdout) as { sessionsScanned: number; totalTokenUsage: { totalTokens: number } };
    assert.equal(parsed.sessionsScanned, 2);
    assert.equal(parsed.totalTokenUsage.totalTokens, 240);

    const statusRun = spawnSync(
      process.execPath,
      ['--loader', 'ts-node/esm', path.join(repoRoot, 'src', 'index.ts'), 'status', '--client', 'codex'],
      { cwd: repoRoot, env, encoding: 'utf-8' }
    );
    assert.equal(statusRun.status, 0, statusRun.stderr);
    assert.match(statusRun.stdout, /Codex Usage \(7d\)/);
    assert.match(statusRun.stdout, /only Codex log usage is shown/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('dashboard exposes Codex usage API with no MCP upstreams', async () => {
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gauge-home-'));
  process.env.HOME = home;

  try {
    fs.cpSync(fixtureCodexHome, path.join(home, '.codex'), { recursive: true });
    const dashboard = await startDashboard(0, 'codex');
    try {
      const response = await fetch(`http://localhost:${dashboard.port}/api/codex-usage?days=7`);
      assert.equal(response.ok, true);
      const body = await response.json() as { sessionsScanned: number; totalTokenUsage: { totalTokens: number } };
      assert.equal(body.sessionsScanned, 2);
      assert.equal(body.totalTokenUsage.totalTokens, 240);
    } finally {
      await dashboard.close();
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
