import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

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

interface SessionAccumulator {
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
  callIdToToolName: Map<string, string>;
  toolCalls: Map<string, number>;
  toolFailures: Map<string, number>;
  toolOutputTokenEstimate: Map<string, number>;
}

interface ParsedRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

export async function getCodexUsageSummary(
  options: CodexUsageOptions = {}
): Promise<CodexUsageSummary> {
  const now = options.now ?? new Date();
  const days = normalizeDays(options.days);
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const codexHome = options.codexHome ?? path.join(homeDir(), '.codex');
  const files = await discoverCodexLogFiles(codexHome);
  const sessions = new Map<string, SessionAccumulator>();
  let skippedLines = 0;

  for (const file of files) {
    const result = await parseCodexLogFile(file, sessions, { since, cwd: options.cwd });
    skippedLines += result.skippedLines;
  }

  const sessionSummaries = Array.from(sessions.values())
    .map(sessionToSummary)
    .filter((session) => {
      if (options.cwd && session.cwd !== options.cwd) return false;
      const timestamp = session.lastEventAt ?? session.startedAt;
      return timestamp !== null && new Date(timestamp).getTime() >= since.getTime();
    })
    .sort((a, b) => timestampMs(b.lastEventAt ?? b.startedAt) - timestampMs(a.lastEventAt ?? a.startedAt));

  const totalTokenUsage = emptyTokenUsage();
  const toolCalls = new Map<string, CodexToolUsageSummary>();
  const projects = new Map<string, CodexProjectUsageSummary>();
  let sessionsWithTokens = 0;

  for (const session of sessionSummaries) {
    if (session.totalTokenUsage) {
      sessionsWithTokens += 1;
      addTokenUsage(totalTokenUsage, session.totalTokenUsage);
    }

    const acc = sessions.get(session.id);
    if (acc) {
      for (const [toolName, calls] of acc.toolCalls.entries()) {
        const current = toolCalls.get(toolName) ?? {
          name: toolName,
          calls: 0,
          failures: 0,
          outputTokenEstimate: 0,
        };
        current.calls += calls;
        current.failures += acc.toolFailures.get(toolName) ?? 0;
        current.outputTokenEstimate += acc.toolOutputTokenEstimate.get(toolName) ?? 0;
        toolCalls.set(toolName, current);
      }
    }

    if (session.cwd) {
      const project = projects.get(session.cwd) ?? {
        cwd: session.cwd,
        name: path.basename(session.cwd) || session.cwd,
        sessions: 0,
        totalTokens: 0,
        toolCalls: 0,
      };
      project.sessions += 1;
      project.totalTokens += session.totalTokenUsage?.totalTokens ?? 0;
      project.toolCalls += session.toolCalls;
      projects.set(session.cwd, project);
    }
  }

  const latestSessionWithContext = sessionSummaries.find(
    (session) => session.lastTokenUsage && session.modelContextWindow && session.modelContextWindow > 0
  );

  return {
    generatedAt: now.toISOString(),
    since: since.toISOString(),
    days,
    cwd: options.cwd ?? null,
    filesScanned: files.length,
    skippedLines,
    sessionsScanned: sessionSummaries.length,
    sessionsWithTokens,
    totalTokenUsage,
    latestContextUsagePercent: latestSessionWithContext?.lastTokenUsage && latestSessionWithContext.modelContextWindow
      ? Math.round((latestSessionWithContext.lastTokenUsage.totalTokens / latestSessionWithContext.modelContextWindow) * 100)
      : null,
    latestRateLimits: {
      primaryUsedPercent: sessionSummaries[0]?.primaryRateLimitUsedPercent ?? null,
      secondaryUsedPercent: sessionSummaries[0]?.secondaryRateLimitUsedPercent ?? null,
    },
    toolCalls: Array.from(toolCalls.values())
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    projects: Array.from(projects.values())
      .sort((a, b) => b.totalTokens - a.totalTokens || b.toolCalls - a.toolCalls || a.cwd.localeCompare(b.cwd)),
    recentSessions: sessionSummaries.slice(0, options.maxRecentSessions ?? 10),
  };
}

export async function discoverCodexLogFiles(codexHome: string): Promise<string[]> {
  const roots = [
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ];
  const files: string[] = [];

  for (const root of roots) {
    await collectJsonlFiles(root, files);
  }

  return files.sort();
}

export function formatCodexUsageSummary(summary: CodexUsageSummary): string {
  const lines: string[] = [];
  lines.push(`Codex Usage (${summary.days}d)`);
  lines.push(`  Sessions: ${summary.sessionsScanned.toLocaleString()} (${summary.sessionsWithTokens.toLocaleString()} with token data)`);
  lines.push(`  Tokens: ${summary.totalTokenUsage.totalTokens.toLocaleString()} total, ${summary.totalTokenUsage.inputTokens.toLocaleString()} input, ${summary.totalTokenUsage.outputTokens.toLocaleString()} output`);
  if (summary.latestContextUsagePercent !== null) {
    lines.push(`  Latest context: ${summary.latestContextUsagePercent}% used`);
  }
  if (summary.latestRateLimits.primaryUsedPercent !== null || summary.latestRateLimits.secondaryUsedPercent !== null) {
    lines.push(`  Rate limits: primary ${formatPercent(summary.latestRateLimits.primaryUsedPercent)}, secondary ${formatPercent(summary.latestRateLimits.secondaryUsedPercent)}`);
  }
  if (summary.toolCalls.length > 0) {
    lines.push('  Top tools:');
    for (const tool of summary.toolCalls.slice(0, 8)) {
      const failures = tool.failures > 0 ? `, ${tool.failures} failed` : '';
      lines.push(`    ${tool.name.padEnd(28)} ${tool.calls.toString().padStart(4)} calls${failures}`);
    }
  }
  if (summary.projects.length > 0) {
    lines.push('  Top projects:');
    for (const project of summary.projects.slice(0, 5)) {
      lines.push(`    ${project.name.padEnd(28)} ${project.totalTokens.toLocaleString()} tokens · ${project.sessions} sessions`);
    }
  }
  if (summary.skippedLines > 0) {
    lines.push(`  Skipped malformed lines: ${summary.skippedLines.toLocaleString()}`);
  }
  return lines.join('\n');
}

async function parseCodexLogFile(
  filePath: string,
  sessions: Map<string, SessionAccumulator>,
  filters: { since: Date; cwd?: string }
): Promise<{ skippedLines: number }> {
  let skippedLines = 0;
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let fallbackSessionId = path.basename(filePath, '.jsonl');

  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    let record: ParsedRecord;
    try {
      record = JSON.parse(line) as ParsedRecord;
    } catch {
      skippedLines += 1;
      continue;
    }

    const timestamp = asString(record.timestamp);
    const payload = isRecord(record.payload) ? record.payload : {};
    if (record.type === 'session_meta') {
      const id = asString(payload.id) ?? fallbackSessionId;
      fallbackSessionId = id;
      const session = getSession(sessions, id);
      session.startedAt = asString(payload.timestamp) ?? timestamp ?? session.startedAt;
      session.lastEventAt = latestTimestamp(session.lastEventAt, timestamp ?? session.startedAt);
      session.cwd = asString(payload.cwd) ?? session.cwd;
      session.originator = asString(payload.originator) ?? session.originator;
      session.cliVersion = asString(payload.cli_version) ?? session.cliVersion;
      session.source = asString(payload.source) ?? session.source;
      session.modelProvider = asString(payload.model_provider) ?? session.modelProvider;
      continue;
    }

    const session = getSession(sessions, fallbackSessionId);
    session.lastEventAt = latestTimestamp(session.lastEventAt, timestamp);

    if (record.type === 'event_msg' && payload.type === 'token_count') {
      const info = isRecord(payload.info) ? payload.info : null;
      if (info) {
        const totalUsage = parseTokenUsage(info.total_token_usage);
        const lastUsage = parseTokenUsage(info.last_token_usage);
        session.totalTokenUsage = totalUsage ?? session.totalTokenUsage;
        session.lastTokenUsage = lastUsage ?? session.lastTokenUsage;
        session.modelContextWindow = asNumber(info.model_context_window) ?? session.modelContextWindow;
      }

      const rateLimits = isRecord(payload.rate_limits) ? payload.rate_limits : null;
      const primary = isRecord(rateLimits?.primary) ? rateLimits?.primary : null;
      const secondary = isRecord(rateLimits?.secondary) ? rateLimits?.secondary : null;
      session.primaryRateLimitUsedPercent = asNumber(primary?.used_percent) ?? session.primaryRateLimitUsedPercent;
      session.secondaryRateLimitUsedPercent = asNumber(secondary?.used_percent) ?? session.secondaryRateLimitUsedPercent;
      continue;
    }

    if (record.type === 'response_item' && payload.type === 'function_call') {
      const toolName = asString(payload.name);
      const callId = asString(payload.call_id);
      if (!toolName) continue;
      session.toolCalls.set(toolName, (session.toolCalls.get(toolName) ?? 0) + 1);
      if (callId) session.callIdToToolName.set(callId, toolName);
      continue;
    }

    if (record.type === 'response_item' && payload.type === 'function_call_output') {
      const callId = asString(payload.call_id);
      const output = asString(payload.output);
      if (!callId || output === null) continue;
      const toolName = session.callIdToToolName.get(callId);
      if (!toolName) continue;
      session.toolOutputTokenEstimate.set(
        toolName,
        (session.toolOutputTokenEstimate.get(toolName) ?? 0) + estimateTokens(output)
      );
      if (isFailureOutput(output)) {
        session.toolFailures.set(toolName, (session.toolFailures.get(toolName) ?? 0) + 1);
      }
    }
  }

  for (const [id, session] of sessions.entries()) {
    const sessionTime = timestampMs(session.lastEventAt ?? session.startedAt);
    if (sessionTime !== 0 && sessionTime < filters.since.getTime()) {
      sessions.delete(id);
    } else if (filters.cwd && session.cwd && session.cwd !== filters.cwd) {
      sessions.delete(id);
    }
  }

  return { skippedLines };
}

async function collectJsonlFiles(dir: string, files: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }
}

function getSession(sessions: Map<string, SessionAccumulator>, id: string): SessionAccumulator {
  const current = sessions.get(id);
  if (current) return current;
  const next: SessionAccumulator = {
    id,
    startedAt: null,
    lastEventAt: null,
    cwd: null,
    originator: null,
    cliVersion: null,
    source: null,
    modelProvider: null,
    totalTokenUsage: null,
    lastTokenUsage: null,
    modelContextWindow: null,
    primaryRateLimitUsedPercent: null,
    secondaryRateLimitUsedPercent: null,
    callIdToToolName: new Map(),
    toolCalls: new Map(),
    toolFailures: new Map(),
    toolOutputTokenEstimate: new Map(),
  };
  sessions.set(id, next);
  return next;
}

function sessionToSummary(session: SessionAccumulator): CodexSessionUsageSummary {
  return {
    id: session.id,
    startedAt: session.startedAt,
    lastEventAt: session.lastEventAt,
    cwd: session.cwd,
    originator: session.originator,
    cliVersion: session.cliVersion,
    source: session.source,
    modelProvider: session.modelProvider,
    totalTokenUsage: session.totalTokenUsage,
    lastTokenUsage: session.lastTokenUsage,
    modelContextWindow: session.modelContextWindow,
    primaryRateLimitUsedPercent: session.primaryRateLimitUsedPercent,
    secondaryRateLimitUsedPercent: session.secondaryRateLimitUsedPercent,
    toolCalls: Array.from(session.toolCalls.values()).reduce((sum, count) => sum + count, 0),
    toolFailures: Array.from(session.toolFailures.values()).reduce((sum, count) => sum + count, 0),
  };
}

function parseTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  return {
    inputTokens: asNumber(value.input_tokens) ?? 0,
    cachedInputTokens: asNumber(value.cached_input_tokens) ?? 0,
    outputTokens: asNumber(value.output_tokens) ?? 0,
    reasoningOutputTokens: asNumber(value.reasoning_output_tokens) ?? 0,
    totalTokens: asNumber(value.total_tokens) ?? 0,
  };
}

function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function addTokenUsage(target: TokenUsage, usage: TokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
  target.totalTokens += usage.totalTokens;
}

function isFailureOutput(output: string): boolean {
  const exitMatch = output.match(/Process exited with code (-?\d+)/);
  if (exitMatch && Number(exitMatch[1]) !== 0) return true;

  try {
    const parsed = JSON.parse(output) as unknown;
    if (isRecord(parsed)) {
      const status = asString(parsed.status)?.toLowerCase();
      if (status === 'error' || status === 'failed') return true;
      if (parsed.error !== undefined) return true;
    }
  } catch {
    // Most tool outputs are plain text.
  }

  return false;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function latestTimestamp(current: string | null, next: string | null | undefined): string | null {
  if (!next) return current;
  if (!current) return next;
  return timestampMs(next) >= timestampMs(current) ? next : current;
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days) || days <= 0) return 7;
  return Math.max(1, Math.floor(days));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${value}%`;
}

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}
