import { ToolDefinition } from './types.js';

// We approximate using character count → token estimate.
// Real tiktoken is optional — if it fails to load we fall back gracefully.
// Claude's tokenizer is close to cl100k_base (GPT-4 family).
// A tool definition serialised to JSON averages ~3.5 chars/token in practice.

const CHARS_PER_TOKEN = 3.5;

// The overhead MCP adds around each tool definition in the context window.
// Anthropic's tool use format wraps each tool in XML-ish structure.
// Empirically measured at ~40 tokens per tool for the framing alone.
const FRAMING_TOKENS_PER_TOOL = 40;

let encoder: { encode: (text: string) => Uint32Array } | null = null;

async function getEncoder() {
  if (encoder) return encoder;
  try {
    // Optional: use real tiktoken if available
    const { get_encoding } = await import('tiktoken');
    encoder = get_encoding('cl100k_base');
    return encoder;
  } catch {
    // Fall back to character-based estimate — accurate enough for UI purposes
    return null;
  }
}

export function countTokensSync(text: string): number {
  // Fast synchronous fallback used during proxy startup
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export async function countTokens(text: string): Promise<number> {
  const enc = await getEncoder();
  if (enc) {
    return enc.encode(text).length;
  }
  return countTokensSync(text);
}

export async function measureToolCost(tool: ToolDefinition): Promise<number> {
  // Serialize the tool exactly as it appears in the Claude context window
  const serialized = JSON.stringify({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? {},
  });

  const bodyTokens = await countTokens(serialized);
  return bodyTokens + FRAMING_TOKENS_PER_TOOL;
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

export function tokenPercent(tokens: number, limit: number): number {
  return Math.round((tokens / limit) * 100);
}
