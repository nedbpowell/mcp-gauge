import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const spec = JSON.parse(process.env.FAKE_MCP_SPEC ?? '{}');
const tools = spec.tools ?? [];
const prompts = spec.prompts ?? [];
const resources = spec.resources ?? [];
const templates = spec.templates ?? [];

const capabilities = {};
if (tools.length > 0) capabilities.tools = {};
if (prompts.length > 0) capabilities.prompts = {};
if (resources.length > 0 || templates.length > 0) capabilities.resources = {};

const server = new Server(
  { name: spec.name ?? 'fake-mcp-server', version: '1.0.0' },
  { capabilities }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? `${spec.name} ${tool.name}`,
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [
    {
      type: 'text',
      text: `${spec.name}:tool:${request.params.name}`,
    },
  ],
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description ?? `${spec.name} ${prompt.name}`,
  })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `${spec.name}:prompt:${request.params.name}`,
      },
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: resources.map((resource) => ({
    uri: resource.uri,
    name: resource.name,
    mimeType: resource.mimeType ?? 'text/plain',
  })),
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: templates.map((template) => ({
    uriTemplate: template.uriTemplate,
    name: template.name,
    mimeType: template.mimeType ?? 'text/plain',
  })),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const staticResource = resources.find((resource) => resource.uri === request.params.uri);
  if (staticResource) {
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: staticResource.mimeType ?? 'text/plain',
          text: staticResource.text ?? `${spec.name}:resource:${request.params.uri}`,
        },
      ],
    };
  }

  const template = templates.find((candidate) => {
    try {
      return new UriTemplate(candidate.uriTemplate).match(request.params.uri) !== null;
    } catch {
      return false;
    }
  });

  if (template) {
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: template.mimeType ?? 'text/plain',
          text: template.text ?? `${spec.name}:template:${request.params.uri}`,
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${request.params.uri}`);
});

await server.connect(new StdioServerTransport());
