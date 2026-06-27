import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runInit, runUninstall } from '../src/cli/init.js';
import {
  readCodexStdioServers,
  readLaunchConfig,
  restoreCodexMcpServers,
  rewriteCodexMcpServers,
  writeLaunchConfig,
} from '../src/store.js';

test('Codex rewrite proxies only stdio MCP servers and preserves HTTP servers', () => {
  const configText = `
model = "gpt-5"

[mcp_servers.remote]
url = "https://example.com/mcp"

[mcp_servers.local] # local stdio server
command = "/bin/echo"
args = ["hello"]
unknown_field = "keep me"

[mcp_servers.local.env]
TOKEN = "secret"

[mcp_servers."quoted name"]
command = "node"
args = ["server.js"]
`;

  const servers = readCodexStdioServers(configText);
  assert.deepEqual(Object.keys(servers).sort(), ['local', 'quoted name']);
  assert.equal(servers.local.command, '/bin/echo');
  assert.equal(servers.local.env?.TOKEN, 'secret');
  assert.match(servers.local.originalBlock ?? '', /unknown_field = "keep me"/);

  const rewritten = rewriteCodexMcpServers(configText, Object.keys(servers), {
    command: '/usr/local/bin/mcp-gauge',
    args: ['proxy', '--client', 'codex'],
  });

  assert.match(rewritten, /\[mcp_servers\.remote\]/);
  assert.match(rewritten, /url = "https:\/\/example\.com\/mcp"/);
  assert.doesNotMatch(rewritten, /\[mcp_servers\.local\]/);
  assert.doesNotMatch(rewritten, /\[mcp_servers\."quoted name"\]/);
  assert.match(rewritten, /\[mcp_servers\.__mcp_gauge_proxy__\]/);
  assert.match(rewritten, /args = \["proxy", "--client", "codex"\]/);

  const restored = restoreCodexMcpServers(rewritten, servers);
  assert.match(restored, /\[mcp_servers\.remote\]/);
  assert.match(restored, /\[mcp_servers\.local\] # local stdio server/);
  assert.match(restored, /unknown_field = "keep me"/);
  assert.match(restored, /\[mcp_servers\.local\.env\]/);
  assert.match(restored, /\[mcp_servers\."quoted name"\]/);
  assert.doesNotMatch(restored, /__mcp_gauge_proxy__/);
});

test('Codex rewrite upgrades existing proxy entry without duplicating it', () => {
  const configText = `
[mcp_servers.remote]
url = "https://example.com/mcp"

[mcp_servers.__mcp_gauge_proxy__]
command = "/old/mcp-gauge"
args = ["proxy"]

[mcp_servers.new_local]
command = "/bin/echo"
args = ["new"]
`;

  const rewritten = rewriteCodexMcpServers(configText, ['new_local'], {
    command: '/old/mcp-gauge',
    args: ['proxy', '--client', 'codex'],
  });

  assert.equal(rewritten.match(/__mcp_gauge_proxy__/g)?.length, 1);
  assert.match(rewritten, /\[mcp_servers\.remote\]/);
  assert.doesNotMatch(rewritten, /\[mcp_servers\.new_local\]/);
  assert.match(rewritten, /args = \["proxy", "--client", "codex"\]/);
});

test('Codex rewrite recovers from duplicate existing proxy entries', () => {
  const configText = `
[mcp_servers.__mcp_gauge_proxy__]
command = "/Users/sws/.bun/bin/mcp-gauge"
args = ["proxy"]

[mcp_servers.__mcp_gauge_proxy__]
command = "/Users/sws/.bun/bin/mcp-gauge"
args = ["proxy"]

[mcp_servers.local]
command = "/bin/echo"
args = ["hello"]
`;

  const servers = readCodexStdioServers(configText);
  assert.equal(servers.__mcp_gauge_proxy__.command, '/Users/sws/.bun/bin/mcp-gauge');
  assert.equal(servers.local.command, '/bin/echo');

  const rewritten = rewriteCodexMcpServers(configText, ['local'], {
    command: servers.__mcp_gauge_proxy__.command,
    args: ['proxy', '--client', 'codex'],
  });

  assert.equal(rewritten.match(/\[mcp_servers\.__mcp_gauge_proxy__\]/g)?.length, 1);
  assert.doesNotMatch(rewritten, /\[mcp_servers\.local\]/);
  assert.match(rewritten, /args = \["proxy", "--client", "codex"\]/);
});

test('Codex launch config reads legacy launch file as fallback and writes scoped state', () => {
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gauge-home-'));
  process.env.HOME = home;

  try {
    const legacyDir = path.join(home, '.mcp-gauge');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'launch.json'),
      JSON.stringify({
        upstreamConfigs: {
          legacy: { command: '/bin/echo', args: ['legacy'] },
        },
      }),
      'utf-8'
    );

    assert.equal(readLaunchConfig('codex').legacy.command, '/bin/echo');

    writeLaunchConfig({
      scoped: { command: '/bin/echo', args: ['scoped'] },
    }, 'codex');

    const scopedPath = path.join(home, '.mcp-gauge', 'clients', 'codex', 'launch.json');
    assert.equal(fs.existsSync(scopedPath), true);
    assert.equal(readLaunchConfig('codex').scoped.command, '/bin/echo');
    assert.equal(readLaunchConfig('codex').legacy, undefined);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex init migrates legacy launch state into scoped state when already installed', () => {
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gauge-home-'));
  process.env.HOME = home;
  process.env.PATH = `${path.join(home, 'bin')}:${previousPath ?? ''}`;

  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  process.exit = ((code?: string | number | null) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;

  try {
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'bin', 'mcp-gauge'), '#!/bin/sh\n', { mode: 0o755 });

    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.codex', 'config.toml'),
      `
[mcp_servers.__mcp_gauge_proxy__]
command = "${path.join(home, 'bin', 'mcp-gauge')}"
args = ["proxy"]
`,
      'utf-8'
    );

    fs.mkdirSync(path.join(home, '.mcp-gauge'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.mcp-gauge', 'launch.json'),
      JSON.stringify({
        upstreamConfigs: {
          legacy: { command: '/bin/echo', args: ['legacy'] },
        },
      }),
      'utf-8'
    );

    assert.throws(() => runInit('codex'), /process\.exit:0/);

    const scopedPath = path.join(home, '.mcp-gauge', 'clients', 'codex', 'launch.json');
    assert.equal(fs.existsSync(scopedPath), true);
    assert.equal(readLaunchConfig('codex').legacy.command, '/bin/echo');
    assert.match(
      fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8'),
      /args = \["proxy", "--client", "codex"\]/
    );
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex init installs usage-only proxy when no local stdio servers exist', () => {
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gauge-home-'));
  process.env.HOME = home;
  process.env.PATH = `${path.join(home, 'bin')}:${previousPath ?? ''}`;

  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  process.exit = ((code?: string | number | null) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;

  try {
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'bin', 'mcp-gauge'), '#!/bin/sh\n', { mode: 0o755 });

    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.codex', 'config.toml'),
      `
[mcp_servers.remote]
url = "https://example.com/mcp"
`,
      'utf-8'
    );

    runInit('codex');

    const configText = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
    assert.match(configText, /\[mcp_servers\.remote\]/);
    assert.match(configText, /url = "https:\/\/example\.com\/mcp"/);
    assert.match(configText, /\[mcp_servers\.__mcp_gauge_proxy__\]/);
    assert.match(configText, /args = \["proxy", "--client", "codex"\]/);
    assert.deepEqual(readLaunchConfig('codex'), {});
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex usage-only init explains what changed and what was left alone', () => {
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gauge-home-'));
  process.env.HOME = home;
  process.env.PATH = `${path.join(home, 'bin')}:${previousPath ?? ''}`;

  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.error = () => undefined;

  try {
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'bin', 'mcp-gauge'), '#!/bin/sh\n', { mode: 0o755 });

    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.codex', 'config.toml'),
      `
[mcp_servers.remote]
url = "https://example.com/mcp"
`,
      'utf-8'
    );

    runInit('codex');

    const output = logs.join('\n');
    assert.match(output, /Found Codex config:/);
    assert.match(output, /No local stdio MCP servers found/);
    assert.match(output, /HTTP MCP servers will be left untouched/);
    assert.match(output, /Created backup: ~\/\.mcp-gauge\/clients\/codex\/config_backup\.toml/);
    assert.match(output, /Codex usage tracking is ready/);
    assert.match(output, /mcp-gauge status --client codex/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex uninstall restores from backup when launch state is missing', () => {
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gauge-home-'));
  process.env.HOME = home;

  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;

  try {
    const codexDir = path.join(home, '.codex');
    const backupDir = path.join(home, '.mcp-gauge', 'clients', 'codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });

    const originalConfig = `
model = "gpt-5"

[mcp_servers.local]
command = "node"
args = ["server.js"]
`;
    fs.writeFileSync(path.join(backupDir, 'config_backup.toml'), originalConfig, 'utf-8');
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      `
model = "gpt-5"

[mcp_servers.__mcp_gauge_proxy__]
command = "/usr/local/bin/mcp-gauge"
args = ["proxy", "--client", "codex"]
`,
      'utf-8'
    );

    runUninstall('codex');

    const restored = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    assert.match(restored, /\[mcp_servers\.local\]/);
    assert.match(restored, /command = "node"/);
    assert.doesNotMatch(restored, /__mcp_gauge_proxy__/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex uninstall falls back to backup when current config is missing', () => {
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gauge-home-'));
  process.env.HOME = home;

  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.error = () => undefined;

  try {
    const backupDir = path.join(home, '.mcp-gauge', 'clients', 'codex');
    fs.mkdirSync(backupDir, { recursive: true });

    const originalConfig = `
model = "gpt-5"

[mcp_servers.local]
command = "node"
args = ["server.js"]
`;
    fs.writeFileSync(path.join(backupDir, 'config_backup.toml'), originalConfig, 'utf-8');
    writeLaunchConfig({
      local: { command: 'node', args: ['server.js'] },
    }, 'codex');

    runUninstall('codex');

    const restored = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8');
    assert.match(restored, /\[mcp_servers\.local\]/);
    assert.match(restored, /command = "node"/);
    assert.doesNotMatch(restored, /__mcp_gauge_proxy__/);
    assert.match(logs.join('\n'), /Used backup: ~\/\.mcp-gauge\/clients\/codex\/config_backup\.toml/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
