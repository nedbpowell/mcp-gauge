import { ToolDefinition } from './types.js';
export declare function countTokensSync(text: string): number;
export declare function countTokens(text: string): Promise<number>;
export declare function measureToolCost(tool: ToolDefinition): Promise<number>;
export declare function formatTokens(n: number): string;
export declare function tokenPercent(tokens: number, limit: number): number;
