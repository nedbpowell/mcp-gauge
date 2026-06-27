import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const fakeServerPath = path.join(repoRoot, 'test', 'fixtures', 'fake-mcp-server.mjs');
const proxyEntryPath = path.join(repoRoot, 'src', 'index.ts');

test('proxy routes tools, prompts, static resources, and template resources for Codex', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gauge-proxy-home-'));
  const launchDir = path.join(home, '.mcp-gauge', 'clients', 'codex');
  fs.mkdirSync(launchDir, { recursive: true });

  const upstreamConfigs = {
    one: fakeServerConfig({
      name: 'one',
      tools: [{ name: 'shared' }],
      prompts: [{ name: 'ask' }],
      resources: [{ uri: 'file://same', name: 'same', text: 'one static' }],
      templates: [{ uriTemplate: 'item://one/{id}', name: 'one-item', text: 'one template' }],
    }),
    two: fakeServerConfig({
      name: 'two',
      tools: [{ name: 'shared' }],
      prompts: [{ name: 'ask' }],
      resources: [{ uri: 'file://same', name: 'same', text: 'two static' }],
      templates: [{ uriTemplate: 'item://two/{id}', name: 'two-item', text: 'two template' }],
    }),
  };

  fs.writeFileSync(
    path.join(launchDir, 'launch.json'),
    JSON.stringify({ upstreamConfigs }, null, 2),
    'utf-8'
  );

  const client = new Client(
    { name: 'mcp-gauge-test-client', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--loader', 'ts-node/esm', proxyEntryPath, 'proxy', '--client', 'codex', '--port', '0'],
    env: { ...process.env, HOME: home },
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['one__shared', 'two__shared']);

    const toolResult = await client.callTool({ name: 'one__shared', arguments: {} });
    assert.equal(toolResult.content?.[0]?.type, 'text');
    assert.equal(toolResult.content?.[0]?.text, 'one:tool:shared');

    const prompts = await client.listPrompts();
    assert.deepEqual(prompts.prompts.map((prompt) => prompt.name).sort(), ['one__ask', 'two__ask']);

    const prompt = await client.getPrompt({ name: 'two__ask', arguments: {} });
    assert.equal(prompt.messages[0].content.type, 'text');
    assert.equal(prompt.messages[0].content.text, 'two:prompt:ask');

    const resources = await client.listResources();
    const oneResource = resources.resources.find((resource) =>
      resource.uri.startsWith('mcp-gauge+resource://one/')
    );
    assert.ok(oneResource);

    const staticResource = await client.readResource({ uri: oneResource.uri });
    assert.equal(staticResource.contents[0].text, 'one static');

    const templates = await client.listResourceTemplates();
    assert.deepEqual(
      templates.resourceTemplates.map((template) => template.uriTemplate).sort(),
      ['item://one/{id}', 'item://two/{id}']
    );

    const templateResource = await client.readResource({ uri: 'item://one/42' });
    assert.equal(templateResource.contents[0].text, 'one template');
  } finally {
    await client.close().catch(() => undefined);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function fakeServerConfig(spec: Record<string, unknown>) {
  return {
    command: process.execPath,
    args: [fakeServerPath],
    env: {
      FAKE_MCP_SPEC: JSON.stringify(spec),
    },
  };
}
