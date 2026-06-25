"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.countTokensSync = countTokensSync;
exports.countTokens = countTokens;
exports.measureToolCost = measureToolCost;
exports.formatTokens = formatTokens;
exports.tokenPercent = tokenPercent;
// We approximate using character count → token estimate.
// Real tiktoken is optional — if it fails to load we fall back gracefully.
// Claude's tokenizer is close to cl100k_base (GPT-4 family).
// A tool definition serialised to JSON averages ~3.5 chars/token in practice.
const CHARS_PER_TOKEN = 3.5;
// The overhead MCP adds around each tool definition in the context window.
// Anthropic's tool use format wraps each tool in XML-ish structure.
// Empirically measured at ~40 tokens per tool for the framing alone.
const FRAMING_TOKENS_PER_TOOL = 40;
let encoder = null;
async function getEncoder() {
    if (encoder)
        return encoder;
    try {
        // Optional: use real tiktoken if available
        const { get_encoding } = await Promise.resolve().then(() => __importStar(require('tiktoken')));
        encoder = get_encoding('cl100k_base');
        return encoder;
    }
    catch {
        // Fall back to character-based estimate — accurate enough for UI purposes
        return null;
    }
}
function countTokensSync(text) {
    // Fast synchronous fallback used during proxy startup
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}
async function countTokens(text) {
    const enc = await getEncoder();
    if (enc) {
        return enc.encode(text).length;
    }
    return countTokensSync(text);
}
async function measureToolCost(tool) {
    // Serialize the tool exactly as it appears in the Claude context window
    const serialized = JSON.stringify({
        name: tool.name,
        description: tool.description ?? '',
        input_schema: tool.inputSchema ?? {},
    });
    const bodyTokens = await countTokens(serialized);
    return bodyTokens + FRAMING_TOKENS_PER_TOOL;
}
function formatTokens(n) {
    if (n >= 1000)
        return `${(n / 1000).toFixed(1)}k`;
    return n.toString();
}
function tokenPercent(tokens, limit) {
    return Math.round((tokens / limit) * 100);
}
