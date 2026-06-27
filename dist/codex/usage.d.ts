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
    displayName: string;
    sessions: number;
    totalTokens: number;
    toolCalls: number;
    toolFailures: number;
}
export interface CodexDailyUsageSummary {
    date: string;
    sessions: number;
    totalTokens: number;
    toolCalls: number;
    toolFailures: number;
}
export interface CodexFailureHotspot {
    cwd: string | null;
    projectName: string;
    projectDisplayName: string;
    toolName: string;
    calls: number;
    failures: number;
}
export type CodexFailureCategory = 'missing_path' | 'no_matches' | 'shell_glob' | 'test_or_build_failure' | 'timeout_or_truncated' | 'command_error' | 'tool_error';
export interface CodexFailureReason {
    cwd: string | null;
    projectName: string;
    projectDisplayName: string;
    toolName: string;
    commandFamily: string;
    category: CodexFailureCategory;
    label: string;
    recommendation: string;
    calls: number;
    failures: number;
}
export interface CodexRecommendation {
    severity: 'info' | 'warning';
    message: string;
}
export interface CodexSessionUsageSummary {
    id: string;
    startedAt: string | null;
    lastEventAt: string | null;
    cwd: string | null;
    projectName: string;
    projectDisplayName: string;
    originator: string | null;
    cliVersion: string | null;
    source: string | null;
    modelProvider: string | null;
    totalTokenUsage: TokenUsage | null;
    lastTokenUsage: TokenUsage | null;
    totalTokens: number;
    modelContextWindow: number | null;
    primaryRateLimitUsedPercent: number | null;
    secondaryRateLimitUsedPercent: number | null;
    durationMs: number | null;
    toolCalls: number;
    toolFailures: number;
    failureReasons: CodexFailureReason[];
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
    latestTurnTokenUsage: TokenUsage | null;
    latestContextUsagePercent: number | null;
    latestRateLimits: {
        primaryUsedPercent: number | null;
        secondaryUsedPercent: number | null;
    };
    toolCalls: CodexToolUsageSummary[];
    projects: CodexProjectUsageSummary[];
    dailyUsage: CodexDailyUsageSummary[];
    topSessions: CodexSessionUsageSummary[];
    failureHotspots: CodexFailureHotspot[];
    failureReasons: CodexFailureReason[];
    topFailureReasons: CodexFailureReason[];
    recommendations: CodexRecommendation[];
    recentSessions: CodexSessionUsageSummary[];
}
export declare function getCodexUsageSummary(options?: CodexUsageOptions): Promise<CodexUsageSummary>;
export declare function discoverCodexLogFiles(codexHome: string): Promise<string[]>;
export declare function formatCodexUsageStatus(summary: CodexUsageSummary): string;
export declare function formatCodexUsageSummary(summary: CodexUsageSummary): string;
