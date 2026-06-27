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
  formatCodexUsageStatus,
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
    path.join('archived_sessions', 'session-c.jsonl'),
    path.join('archived_sessions', 'session-d.jsonl'),
    path.join('sessions', '2026', '06', 'session-a.jsonl'),
  ]);
});

test('Codex usage scanner aggregates insights without retaining raw arguments or output', async () => {
  const summary = await getCodexUsageSummary({
    codexHome: fixtureCodexHome,
    now: new Date('2026-06-27T00:00:00.000Z'),
    days: 7,
  });

  assert.equal(summary.filesScanned, 5);
  assert.equal(summary.skippedLines, 1);
  assert.equal(summary.sessionsScanned, 4);
  assert.equal(summary.sessionsWithTokens, 3);
  assert.equal(summary.totalTokenUsage.totalTokens, 6240);
  assert.equal(summary.latestContextUsagePercent, 4);
  assert.deepEqual(summary.latestRateLimits, {
    primaryUsedPercent: 3,
    secondaryUsedPercent: 4,
  });

  assert.deepEqual(summary.toolCalls.map((tool) => ({
    name: tool.name,
    calls: tool.calls,
    failures: tool.failures,
  })).slice(0, 2), [
    { name: 'exec_command', calls: 7, failures: 6 },
    { name: 'read_thread_terminal', calls: 1, failures: 0 },
  ]);

  assert.deepEqual(summary.dailyUsage.map((day) => ({
    date: day.date,
    totalTokens: day.totalTokens,
    toolFailures: day.toolFailures,
  })), [
    { date: '2026-06-23', totalTokens: 5000, toolFailures: 0 },
    { date: '2026-06-24', totalTokens: 1000, toolFailures: 5 },
    { date: '2026-06-25', totalTokens: 0, toolFailures: 0 },
    { date: '2026-06-26', totalTokens: 240, toolFailures: 1 },
  ]);

  assert.equal(summary.projects[0].displayName, 'deep-work');
  assert.match(summary.projects.find((project) => project.cwd === '/tmp/project-a')?.displayName ?? '', /^project-a \(/);
  assert.match(summary.projects.find((project) => project.cwd === '/var/tmp/project-a')?.displayName ?? '', /^project-a \(/);
  assert.equal(summary.topSessions[0].projectDisplayName, 'deep-work');
  assert.equal(summary.topSessions[0].durationMs, 1861000);
  assert.deepEqual(summary.failureHotspots.map((hotspot) => ({
    projectDisplayName: hotspot.projectDisplayName,
    toolName: hotspot.toolName,
    failures: hotspot.failures,
  })).slice(0, 2), [
    { projectDisplayName: 'project-a (/var/tmp/project-a)', toolName: 'exec_command', failures: 5 },
    { projectDisplayName: 'project-a (/tmp/project-a)', toolName: 'exec_command', failures: 1 },
  ]);
  assert.match(summary.recommendations.map((rec) => rec.message).join('\n'), /repeated exec_command failures/);
  assert.match(summary.recommendations.map((rec) => rec.message).join('\n'), /deep work, not obvious waste/);
  assert.match(summary.recommendations.map((rec) => rec.message).join('\n'), /same folder name/);
  assert.doesNotMatch(JSON.stringify(summary), /secret command|secret output|secret failure|secret success/);

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

  const compact = formatCodexUsageStatus(summary);
  const output = formatCodexUsageSummary(summary);
  assert.match(compact, /Suggestions:/);
  assert.doesNotMatch(compact, /Daily usage:/);
  assert.match(output, /Codex Usage \(7d\)/);
  assert.match(output, /Tokens: 6,240 total/);
  assert.match(output, /Daily usage:/);
  assert.match(output, /Biggest sessions:/);
  assert.match(output, /Failure hotspots:/);
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
    const parsed = JSON.parse(jsonRun.stdout) as {
      sessionsScanned: number;
      totalTokenUsage: { totalTokens: number };
      dailyUsage: unknown[];
      topSessions: unknown[];
      failureHotspots: unknown[];
      recommendations: unknown[];
    };
    assert.equal(parsed.sessionsScanned, 4);
    assert.equal(parsed.totalTokenUsage.totalTokens, 6240);
    assert.equal(parsed.dailyUsage.length, 4);
    assert.equal(parsed.topSessions.length, 4);
    assert.equal(parsed.failureHotspots.length, 2);
    assert.equal(parsed.recommendations.length >= 2, true);

    const statusRun = spawnSync(
      process.execPath,
      ['--loader', 'ts-node/esm', path.join(repoRoot, 'src', 'index.ts'), 'status', '--client', 'codex'],
      { cwd: repoRoot, env, encoding: 'utf-8' }
    );
    assert.equal(statusRun.status, 0, statusRun.stderr);
    assert.match(statusRun.stdout, /Codex Usage \(7d\)/);
    assert.match(statusRun.stdout, /Suggestions:/);
    assert.doesNotMatch(statusRun.stdout, /Daily usage:/);
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
      const body = await response.json() as {
        sessionsScanned: number;
        totalTokenUsage: { totalTokens: number };
        dailyUsage: unknown[];
        topSessions: unknown[];
        failureHotspots: unknown[];
      };
      assert.equal(body.sessionsScanned, 4);
      assert.equal(body.totalTokenUsage.totalTokens, 6240);
      assert.equal(body.dailyUsage.length, 4);
      assert.equal(body.topSessions.length, 4);
      assert.equal(body.failureHotspots.length, 2);
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

test('README documents Codex install workaround and usage commands', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf-8');
  assert.match(readme, /mkdir -p ~\/\.npm-global ~\/\.npm-cache/);
  assert.match(readme, /npm config set prefix ~\/\.npm-global/);
  assert.match(readme, /npm install -g --cache ~\/\.npm-cache mcp-gauge/);
  assert.match(readme, /mcp-gauge init --client codex/);
  assert.match(readme, /mcp-gauge codex-usage/);
  assert.match(readme, /zero MCP servers/);
});
