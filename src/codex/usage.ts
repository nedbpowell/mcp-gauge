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
  dailyUsage: CodexDailyUsageSummary[];
  topSessions: CodexSessionUsageSummary[];
  failureHotspots: CodexFailureHotspot[];
  recommendations: CodexRecommendation[];
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
  const dailyUsage = new Map<string, CodexDailyUsageSummary>();
  const failureHotspots = new Map<string, CodexFailureHotspot>();
  let sessionsWithTokens = 0;
  const basenameCounts = countBy(
    sessionSummaries
      .map((session) => session.cwd)
      .filter((cwd): cwd is string => cwd !== null)
      .map((cwd) => projectName(cwd))
  );

  for (const session of sessionSummaries) {
    if (session.totalTokenUsage) {
      sessionsWithTokens += 1;
      addTokenUsage(totalTokenUsage, session.totalTokenUsage);
    }

    session.projectName = session.cwd ? projectName(session.cwd) : '(unknown)';
    session.projectDisplayName = session.cwd
      ? projectDisplayName(session.cwd, basenameCounts)
      : '(unknown)';
    session.totalTokens = session.totalTokenUsage?.totalTokens ?? 0;

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

        const failures = acc.toolFailures.get(toolName) ?? 0;
        if (failures > 0) {
          const key = `${session.cwd ?? ''}::${toolName}`;
          const currentHotspot = failureHotspots.get(key) ?? {
            cwd: session.cwd,
            projectName: session.projectName,
            projectDisplayName: session.projectDisplayName,
            toolName,
            calls: 0,
            failures: 0,
          };
          currentHotspot.calls += calls;
          currentHotspot.failures += failures;
          failureHotspots.set(key, currentHotspot);
        }
      }
    }

    if (session.cwd) {
      const project = projects.get(session.cwd) ?? {
        cwd: session.cwd,
        name: projectName(session.cwd),
        displayName: projectDisplayName(session.cwd, basenameCounts),
        sessions: 0,
        totalTokens: 0,
        toolCalls: 0,
        toolFailures: 0,
      };
      project.sessions += 1;
      project.totalTokens += session.totalTokenUsage?.totalTokens ?? 0;
      project.toolCalls += session.toolCalls;
      project.toolFailures += session.toolFailures;
      projects.set(session.cwd, project);
    }

    const date = dateKey(session.lastEventAt ?? session.startedAt);
    if (date) {
      const day = dailyUsage.get(date) ?? {
        date,
        sessions: 0,
        totalTokens: 0,
        toolCalls: 0,
        toolFailures: 0,
      };
      day.sessions += 1;
      day.totalTokens += session.totalTokenUsage?.totalTokens ?? 0;
      day.toolCalls += session.toolCalls;
      day.toolFailures += session.toolFailures;
      dailyUsage.set(date, day);
    }
  }

  const latestSessionWithContext = sessionSummaries.find(
    (session) => session.lastTokenUsage && session.modelContextWindow && session.modelContextWindow > 0
  );

  const projectSummaries = Array.from(projects.values())
    .sort((a, b) => b.totalTokens - a.totalTokens || b.toolCalls - a.toolCalls || a.cwd.localeCompare(b.cwd));
  const dailySummaries = Array.from(dailyUsage.values())
    .sort((a, b) => a.date.localeCompare(b.date));
  const topSessions = [...sessionSummaries]
    .sort((a, b) => b.totalTokens - a.totalTokens || b.toolFailures - a.toolFailures || b.toolCalls - a.toolCalls)
    .slice(0, options.maxRecentSessions ?? 10);
  const hotspotSummaries = Array.from(failureHotspots.values())
    .sort((a, b) => b.failures - a.failures || b.calls - a.calls || a.projectDisplayName.localeCompare(b.projectDisplayName));

  const summary: CodexUsageSummary = {
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
    projects: projectSummaries,
    dailyUsage: dailySummaries,
    topSessions,
    failureHotspots: hotspotSummaries,
    recommendations: [],
    recentSessions: sessionSummaries.slice(0, options.maxRecentSessions ?? 10),
  };
  summary.recommendations = buildRecommendations(summary, basenameCounts);
  return summary;
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

export function formatCodexUsageStatus(summary: CodexUsageSummary): string {
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
  if (summary.projects.length > 0) {
    lines.push('  Top projects:');
    for (const project of summary.projects.slice(0, 5)) {
      lines.push(`    ${project.displayName.padEnd(36)} ${project.totalTokens.toLocaleString()} tokens · ${project.sessions} sessions`);
    }
  }
  if (summary.failureHotspots.length > 0) {
    lines.push('  Failure hotspots:');
    for (const hotspot of summary.failureHotspots.slice(0, 3)) {
      lines.push(`    ${hotspot.projectDisplayName.padEnd(28)} ${hotspot.toolName.padEnd(18)} ${hotspot.failures} failed`);
    }
  }
  if (summary.recommendations.length > 0) {
    lines.push('  Suggestions:');
    for (const rec of summary.recommendations.slice(0, 3)) {
      lines.push(`    - ${rec.message}`);
    }
  }
  return lines.join('\n');
}

export function formatCodexUsageSummary(summary: CodexUsageSummary): string {
  const lines: string[] = [];
  lines.push(formatCodexUsageStatus(summary));
  if (summary.dailyUsage.length > 0) {
    lines.push('');
    lines.push('Daily usage:');
    const maxTokens = Math.max(...summary.dailyUsage.map((day) => day.totalTokens), 1);
    for (const day of summary.dailyUsage) {
      const bar = '█'.repeat(Math.max(1, Math.round((day.totalTokens / maxTokens) * 16)));
      lines.push(`  ${day.date}  ${day.totalTokens.toLocaleString().padStart(12)} tokens  ${bar}`);
    }
  }
  if (summary.topSessions.length > 0) {
    lines.push('');
    lines.push('Biggest sessions:');
    for (const session of summary.topSessions.slice(0, 5)) {
      const duration = session.durationMs === null ? 'n/a' : formatDuration(session.durationMs);
      lines.push(`  ${session.projectDisplayName.padEnd(36)} ${session.totalTokens.toLocaleString().padStart(12)} tokens · ${session.toolCalls} calls · ${session.toolFailures} failed · ${duration}`);
    }
  }
  if (summary.toolCalls.length > 0) {
    lines.push('');
    lines.push('Top tools:');
    for (const tool of summary.toolCalls.slice(0, 8)) {
      const failures = tool.failures > 0 ? `, ${tool.failures} failed` : '';
      lines.push(`  ${tool.name.padEnd(28)} ${tool.calls.toString().padStart(4)} calls${failures}`);
    }
  }
  if (summary.failureHotspots.length > 0) {
    lines.push('');
    lines.push('Failure hotspots:');
    for (const hotspot of summary.failureHotspots.slice(0, 8)) {
      lines.push(`  ${hotspot.projectDisplayName.padEnd(36)} ${hotspot.toolName.padEnd(20)} ${hotspot.failures} failed / ${hotspot.calls} calls`);
    }
  }
  if (summary.skippedLines > 0) {
    lines.push('');
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
  const startedMs = timestampMs(session.startedAt);
  const endedMs = timestampMs(session.lastEventAt);
  return {
    id: session.id,
    startedAt: session.startedAt,
    lastEventAt: session.lastEventAt,
    cwd: session.cwd,
    projectName: session.cwd ? projectName(session.cwd) : '(unknown)',
    projectDisplayName: session.cwd ? projectName(session.cwd) : '(unknown)',
    originator: session.originator,
    cliVersion: session.cliVersion,
    source: session.source,
    modelProvider: session.modelProvider,
    totalTokenUsage: session.totalTokenUsage,
    lastTokenUsage: session.lastTokenUsage,
    totalTokens: session.totalTokenUsage?.totalTokens ?? 0,
    modelContextWindow: session.modelContextWindow,
    primaryRateLimitUsedPercent: session.primaryRateLimitUsedPercent,
    secondaryRateLimitUsedPercent: session.secondaryRateLimitUsedPercent,
    durationMs: startedMs > 0 && endedMs >= startedMs ? endedMs - startedMs : null,
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

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function projectName(cwd: string): string {
  return path.basename(cwd) || cwd;
}

function projectDisplayName(cwd: string, basenameCounts: Map<string, number>): string {
  const name = projectName(cwd);
  if ((basenameCounts.get(name) ?? 0) <= 1) return name;
  return `${name} (${shortenHome(cwd)})`;
}

function shortenHome(filePath: string): string {
  const home = homeDir();
  if (filePath === home) return '~';
  if (filePath.startsWith(`${home}${path.sep}`)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

function dateKey(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function buildRecommendations(
  summary: CodexUsageSummary,
  basenameCounts: Map<string, number>
): CodexRecommendation[] {
  const recommendations: CodexRecommendation[] = [];
  if ((summary.latestRateLimits.primaryUsedPercent ?? 0) >= 90) {
    recommendations.push({
      severity: 'warning',
      message: 'Primary rate-limit pressure is high; pause large jobs or use smaller scoped asks.',
    });
  }
  if ((summary.latestContextUsagePercent ?? 0) >= 75) {
    recommendations.push({
      severity: 'warning',
      message: 'Recent context usage is high; start a new thread or ask for a checkpoint summary.',
    });
  }

  const hotspot = summary.failureHotspots.find((item) => item.failures >= 5)
    ?? summary.failureHotspots.find((item) => item.failures >= 3 && item.failures / Math.max(item.calls, 1) >= 0.25);
  if (hotspot) {
    recommendations.push({
      severity: 'warning',
      message: `${hotspot.projectDisplayName} has repeated ${hotspot.toolName} failures; give an exact repo path, ask Codex to inspect first, or narrow the task.`,
    });
  }

  const topCount = Math.max(1, Math.ceil(summary.topSessions.length * 0.1));
  const deepWork = summary.topSessions
    .slice(0, topCount)
    .find((session) => session.totalTokens > 0 && session.toolFailures <= 1);
  if (deepWork) {
    recommendations.push({
      severity: 'info',
      message: `${deepWork.projectDisplayName} used many tokens with few failures; that looks like deep work, not obvious waste.`,
    });
  }

  if (Array.from(basenameCounts.values()).some((count) => count > 1)) {
    recommendations.push({
      severity: 'info',
      message: 'Some projects share the same folder name; use the shortened paths shown here to distinguish workspaces.',
    });
  }

  return recommendations;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
