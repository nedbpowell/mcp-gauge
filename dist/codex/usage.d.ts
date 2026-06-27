export interface CodexUsageOptions {
    codexHome?: string;
    days?: number;
    cwd?: string;
    now?: Date;
    maxRecentSessions?: number;
}
export interface TokenUsage {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
}
export interface CodexToolUsageSummary {
    name: string;
    calls: number;
    failures: number;
    outputTokenEstimate: number;
}
export interface CodexProjectUsageSummary {
    cwd: string;
    name: string;
    sessions: number;
    totalTokens: number;
    toolCalls: number;
}
export interface CodexSessionUsageSummary {
    id: string;
    startedAt: string | null;
    lastEventAt: string | null;
    cwd: string | null;
    originator: string | null;
    cliVersion: string | null;
    source: string | null;
    modelProvider: string | null;
    totalTokenUsage: TokenUsage | null;
    lastTokenUsage: TokenUsage | null;
    modelContextWindow: number | null;
    primaryRateLimitUsedPercent: number | null;
    secondaryRateLimitUsedPercent: number | null;
    toolCalls: number;
    toolFailures: number;
}
export interface CodexUsageSummary {
    generatedAt: string;
    since: string;
    days: number;
    cwd: string | null;
    filesScanned: number;
    skippedLines: number;
    sessionsScanned: number;
    sessionsWithTokens: number;
    totalTokenUsage: TokenUsage;
    latestContextUsagePercent: number | null;
    latestRateLimits: {
        primaryUsedPercent: number | null;
        secondaryUsedPercent: number | null;
    };
    toolCalls: CodexToolUsageSummary[];
    projects: CodexProjectUsageSummary[];
    recentSessions: CodexSessionUsageSummary[];
}
export declare function getCodexUsageSummary(options?: CodexUsageOptions): Promise<CodexUsageSummary>;
export declare function discoverCodexLogFiles(codexHome: string): Promise<string[]>;
export declare function formatCodexUsageSummary(summary: CodexUsageSummary): string;
