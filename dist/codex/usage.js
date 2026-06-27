import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
const allowedCommandFamilies = new Set([
    'rg',
    'npm',
    'bun',
    'yarn',
    'pnpm',
    'git',
    'tsc',
    'python',
    'node',
    'deno',
    'vitest',
    'jest',
    'cargo',
    'go',
    'make',
    'cmake',
    'swift',
    'xcodebuild',
]);
export async function getCodexUsageSummary(options = {}) {
    const now = options.now ?? new Date();
    const days = normalizeDays(options.days);
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const codexHome = options.codexHome ?? path.join(homeDir(), '.codex');
    const files = await discoverCodexLogFiles(codexHome);
    const sessions = new Map();
    let skippedLines = 0;
    for (const file of files) {
        const result = await parseCodexLogFile(file, sessions, { since, cwd: options.cwd });
        skippedLines += result.skippedLines;
    }
    const sessionSummaries = Array.from(sessions.values())
        .map(sessionToSummary)
        .filter((session) => {
        if (options.cwd && session.cwd !== options.cwd)
            return false;
        const timestamp = session.lastEventAt ?? session.startedAt;
        return timestamp !== null && new Date(timestamp).getTime() >= since.getTime();
    })
        .sort((a, b) => timestampMs(b.lastEventAt ?? b.startedAt) - timestampMs(a.lastEventAt ?? a.startedAt));
    const totalTokenUsage = emptyTokenUsage();
    const toolCalls = new Map();
    const projects = new Map();
    const dailyUsage = new Map();
    const failureHotspots = new Map();
    const failureReasons = new Map();
    let sessionsWithTokens = 0;
    const basenameCounts = countBy(sessionSummaries
        .map((session) => session.cwd)
        .filter((cwd) => cwd !== null)
        .map((cwd) => projectName(cwd)));
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
            session.failureReasons = Array.from(acc.failureReasons.values())
                .map((reason) => ({
                ...reason,
                projectName: session.projectName,
                projectDisplayName: session.projectDisplayName,
                calls: acc.commandFamilyCalls.get(commandFamilyKey(reason.toolName, reason.commandFamily)) ?? reason.failures,
            }))
                .sort(sortFailureReasons);
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
            for (const reason of session.failureReasons) {
                const key = failureReasonKey(session.cwd, reason.toolName, reason.commandFamily, reason.category);
                const currentReason = failureReasons.get(key) ?? {
                    ...reason,
                    cwd: session.cwd,
                    projectName: session.projectName,
                    projectDisplayName: session.projectDisplayName,
                    calls: 0,
                    failures: 0,
                };
                currentReason.failures += reason.failures;
                currentReason.calls = acc.commandFamilyCalls.get(commandFamilyKey(reason.toolName, reason.commandFamily)) ?? currentReason.calls;
                failureReasons.set(key, currentReason);
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
    const latestSessionWithContext = sessionSummaries.find((session) => session.lastTokenUsage && session.modelContextWindow && session.modelContextWindow > 0);
    const latestSessionWithTokens = sessionSummaries.find((session) => session.lastTokenUsage);
    const projectSummaries = Array.from(projects.values())
        .sort((a, b) => b.totalTokens - a.totalTokens || b.toolCalls - a.toolCalls || a.cwd.localeCompare(b.cwd));
    const dailySummaries = Array.from(dailyUsage.values())
        .sort((a, b) => a.date.localeCompare(b.date));
    const topSessions = [...sessionSummaries]
        .sort((a, b) => b.totalTokens - a.totalTokens || b.toolFailures - a.toolFailures || b.toolCalls - a.toolCalls)
        .slice(0, options.maxRecentSessions ?? 10);
    const hotspotSummaries = Array.from(failureHotspots.values())
        .sort((a, b) => b.failures - a.failures || b.calls - a.calls || a.projectDisplayName.localeCompare(b.projectDisplayName));
    const failureReasonSummaries = Array.from(failureReasons.values()).sort(sortFailureReasons);
    const summary = {
        generatedAt: now.toISOString(),
        since: since.toISOString(),
        days,
        cwd: options.cwd ?? null,
        filesScanned: files.length,
        skippedLines,
        sessionsScanned: sessionSummaries.length,
        sessionsWithTokens,
        totalTokenUsage,
        latestTurnTokenUsage: latestSessionWithTokens?.lastTokenUsage ?? null,
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
        failureReasons: failureReasonSummaries,
        topFailureReasons: failureReasonSummaries.slice(0, options.maxRecentSessions ?? 10),
        recommendations: [],
        recentSessions: sessionSummaries.slice(0, options.maxRecentSessions ?? 10),
    };
    summary.recommendations = buildRecommendations(summary, basenameCounts);
    return summary;
}
export async function discoverCodexLogFiles(codexHome) {
    const roots = [
        path.join(codexHome, 'sessions'),
        path.join(codexHome, 'archived_sessions'),
    ];
    const files = [];
    for (const root of roots) {
        await collectJsonlFiles(root, files);
    }
    return files.sort();
}
export function formatCodexUsageStatus(summary) {
    const lines = [];
    lines.push(`Codex Usage (${summary.days}d)`);
    lines.push(`  Sessions: ${summary.sessionsScanned.toLocaleString()} (${summary.sessionsWithTokens.toLocaleString()} with token data)`);
    lines.push(`  Processed: ${summary.totalTokenUsage.totalTokens.toLocaleString()} model tokens (cumulative, not context)`);
    if (summary.latestTurnTokenUsage) {
        lines.push(`  Latest turn: ${summary.latestTurnTokenUsage.totalTokens.toLocaleString()} tokens`);
    }
    if (summary.latestContextUsagePercent !== null) {
        lines.push(`  Latest context: ${summary.latestContextUsagePercent}% used`);
    }
    if (summary.latestRateLimits.primaryUsedPercent !== null || summary.latestRateLimits.secondaryUsedPercent !== null) {
        lines.push(`  Rate limits: primary ${formatPercent(summary.latestRateLimits.primaryUsedPercent)}, secondary ${formatPercent(summary.latestRateLimits.secondaryUsedPercent)}`);
    }
    if (summary.projects.length > 0) {
        lines.push('  Top projects:');
        for (const project of summary.projects.slice(0, 5)) {
            lines.push(`    ${formatName(project.displayName, 44)} ${project.totalTokens.toLocaleString()} processed · ${project.sessions} sessions`);
        }
    }
    if (summary.topFailureReasons.length > 0) {
        lines.push('  Failure reasons:');
        for (const reason of summary.topFailureReasons.slice(0, 3)) {
            lines.push(`    ${formatName(reason.projectDisplayName, 30)} ${formatName(reason.commandFamily, 10)} ${formatName(reason.label, 22)} ${reason.failures} failed`);
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
export function formatCodexUsageSummary(summary) {
    const lines = [];
    lines.push(formatCodexUsageStatus(summary));
    if (summary.dailyUsage.length > 0) {
        lines.push('');
        lines.push('Daily usage:');
        const maxTokens = Math.max(...summary.dailyUsage.map((day) => day.totalTokens), 1);
        for (const day of summary.dailyUsage) {
            const bar = '█'.repeat(Math.max(1, Math.round((day.totalTokens / maxTokens) * 16)));
            lines.push(`  ${day.date}  ${day.totalTokens.toLocaleString().padStart(12)} processed  ${bar}`);
        }
    }
    if (summary.topSessions.length > 0) {
        lines.push('');
        lines.push('Biggest sessions:');
        for (const session of summary.topSessions.slice(0, 5)) {
            const duration = session.durationMs === null ? 'n/a' : formatDuration(session.durationMs);
            const classification = classifySession(session);
            lines.push(`  ${formatName(session.projectDisplayName, 36)} ${session.totalTokens.toLocaleString().padStart(12)} processed · ${session.toolCalls} calls · ${session.toolFailures} failed · ${duration} · ${classification}`);
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
    if (summary.topFailureReasons.length > 0) {
        lines.push('');
        lines.push('Failure reasons:');
        for (const reason of summary.topFailureReasons.slice(0, 8)) {
            lines.push(`  ${formatName(reason.projectDisplayName, 36)} ${formatName(reason.commandFamily, 10)} ${formatName(reason.label, 24)} ${reason.failures} failed / ${reason.calls} calls`);
            lines.push(`    ${reason.recommendation}`);
        }
    }
    if (summary.skippedLines > 0) {
        lines.push('');
        lines.push(`  Skipped malformed lines: ${summary.skippedLines.toLocaleString()}`);
    }
    return lines.join('\n');
}
async function parseCodexLogFile(filePath, sessions, filters) {
    let skippedLines = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let fallbackSessionId = path.basename(filePath, '.jsonl');
    for await (const line of rl) {
        if (line.trim().length === 0)
            continue;
        let record;
        try {
            record = JSON.parse(line);
        }
        catch {
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
            if (!toolName)
                continue;
            const commandFamily = toolName === 'exec_command'
                ? commandFamilyFromArguments(payload.arguments)
                : toolName;
            session.toolCalls.set(toolName, (session.toolCalls.get(toolName) ?? 0) + 1);
            session.commandFamilyCalls.set(commandFamilyKey(toolName, commandFamily), (session.commandFamilyCalls.get(commandFamilyKey(toolName, commandFamily)) ?? 0) + 1);
            if (callId)
                session.callIdToToolCall.set(callId, { toolName, commandFamily });
            continue;
        }
        if (record.type === 'response_item' && payload.type === 'function_call_output') {
            const callId = asString(payload.call_id);
            const output = asString(payload.output);
            if (!callId || output === null)
                continue;
            const toolCall = session.callIdToToolCall.get(callId);
            if (!toolCall)
                continue;
            const { toolName, commandFamily } = toolCall;
            session.toolOutputTokenEstimate.set(toolName, (session.toolOutputTokenEstimate.get(toolName) ?? 0) + estimateTokens(output));
            if (isFailureOutput(output)) {
                session.toolFailures.set(toolName, (session.toolFailures.get(toolName) ?? 0) + 1);
                const category = classifyFailure(output, toolName, commandFamily);
                const key = failureReasonKey(session.cwd, toolName, commandFamily, category);
                const currentReason = session.failureReasons.get(key) ?? {
                    cwd: session.cwd,
                    projectName: session.cwd ? projectName(session.cwd) : '(unknown)',
                    projectDisplayName: session.cwd ? projectName(session.cwd) : '(unknown)',
                    toolName,
                    commandFamily,
                    category,
                    label: failureCategoryLabel(category),
                    recommendation: failureCategoryRecommendation(category),
                    calls: 0,
                    failures: 0,
                };
                currentReason.failures += 1;
                currentReason.calls = session.commandFamilyCalls.get(commandFamilyKey(toolName, commandFamily)) ?? currentReason.failures;
                session.failureReasons.set(key, currentReason);
            }
        }
    }
    for (const [id, session] of sessions.entries()) {
        const sessionTime = timestampMs(session.lastEventAt ?? session.startedAt);
        if (sessionTime !== 0 && sessionTime < filters.since.getTime()) {
            sessions.delete(id);
        }
        else if (filters.cwd && session.cwd && session.cwd !== filters.cwd) {
            sessions.delete(id);
        }
    }
    return { skippedLines };
}
async function collectJsonlFiles(dir, files) {
    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await collectJsonlFiles(fullPath, files);
        }
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            files.push(fullPath);
        }
    }
}
function getSession(sessions, id) {
    const current = sessions.get(id);
    if (current)
        return current;
    const next = {
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
        callIdToToolCall: new Map(),
        toolCalls: new Map(),
        toolFailures: new Map(),
        toolOutputTokenEstimate: new Map(),
        commandFamilyCalls: new Map(),
        failureReasons: new Map(),
    };
    sessions.set(id, next);
    return next;
}
function sessionToSummary(session) {
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
        failureReasons: Array.from(session.failureReasons.values()).sort(sortFailureReasons),
    };
}
function parseTokenUsage(value) {
    if (!isRecord(value))
        return null;
    return {
        inputTokens: asNumber(value.input_tokens) ?? 0,
        cachedInputTokens: asNumber(value.cached_input_tokens) ?? 0,
        outputTokens: asNumber(value.output_tokens) ?? 0,
        reasoningOutputTokens: asNumber(value.reasoning_output_tokens) ?? 0,
        totalTokens: asNumber(value.total_tokens) ?? 0,
    };
}
function emptyTokenUsage() {
    return {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
    };
}
function addTokenUsage(target, usage) {
    target.inputTokens += usage.inputTokens;
    target.cachedInputTokens += usage.cachedInputTokens;
    target.outputTokens += usage.outputTokens;
    target.reasoningOutputTokens += usage.reasoningOutputTokens;
    target.totalTokens += usage.totalTokens;
}
function isFailureOutput(output) {
    const exitMatch = output.match(/Process exited with code (-?\d+)/);
    if (exitMatch && Number(exitMatch[1]) !== 0)
        return true;
    try {
        const parsed = JSON.parse(output);
        if (isRecord(parsed)) {
            const status = asString(parsed.status)?.toLowerCase();
            if (status === 'error' || status === 'failed')
                return true;
            if (parsed.error !== undefined)
                return true;
        }
    }
    catch {
        // Most tool outputs are plain text.
    }
    return false;
}
function classifyFailure(output, toolName, commandFamily) {
    const exitCode = exitCodeFromOutput(output);
    const normalized = output.toLowerCase();
    if (toolName !== 'exec_command')
        return 'tool_error';
    if (/zsh:\d+:\s*no matches found|no matches found:/i.test(output))
        return 'shell_glob';
    if (/no such file or directory|os error 2|enoent|cannot access/i.test(output))
        return 'missing_path';
    if (commandFamily === 'rg' && exitCode === 1 && outputLooksEmpty(output))
        return 'no_matches';
    if (/timed out|timeout|cancelled|canceled|truncated|total output lines:|max_output_tokens|exceeded/i.test(output)) {
        return 'timeout_or_truncated';
    }
    if (isTestOrBuildFailure(normalized, commandFamily))
        return 'test_or_build_failure';
    return 'command_error';
}
function exitCodeFromOutput(output) {
    const exitMatch = output.match(/Process exited with code (-?\d+)/);
    return exitMatch ? Number(exitMatch[1]) : null;
}
function outputLooksEmpty(output) {
    return /Original token count:\s*0/i.test(output) || /Output:\s*$/i.test(output.trim());
}
function isTestOrBuildFailure(normalizedOutput, commandFamily) {
    const buildFamilies = new Set(['npm', 'bun', 'yarn', 'pnpm', 'tsc', 'vitest', 'jest']);
    if (buildFamilies.has(commandFamily))
        return true;
    return /failed tests|test failed|build failed|typecheck failed|error ts\d+|command failed/.test(normalizedOutput);
}
function commandFamilyFromArguments(argumentsValue) {
    const fallback = 'exec_command';
    const argsText = asString(argumentsValue);
    if (!argsText)
        return fallback;
    try {
        const parsed = JSON.parse(argsText);
        if (!isRecord(parsed))
            return fallback;
        const cmd = asString(parsed.cmd);
        if (!cmd)
            return fallback;
        return commandFamilyFromCommand(cmd);
    }
    catch {
        return fallback;
    }
}
function commandFamilyFromCommand(command) {
    const trimmed = command.trim();
    if (trimmed.length === 0)
        return 'exec_command';
    const firstToken = trimmed.match(/^(?:env\s+)?(?:NO_COLOR=\S+\s+|FORCE_COLOR=\S+\s+)*([^\s;&|]+)/)?.[1] ?? '';
    const base = path.basename(firstToken.replace(/^['"]|['"]$/g, ''));
    if (base === 'bunx')
        return 'bun';
    if (base === 'npx')
        return 'npm';
    if (base === 'python3')
        return 'python';
    return allowedCommandFamilies.has(base) ? base : 'other';
}
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function latestTimestamp(current, next) {
    if (!next)
        return current;
    if (!current)
        return next;
    return timestampMs(next) >= timestampMs(current) ? next : current;
}
function timestampMs(value) {
    if (!value)
        return 0;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : 0;
}
function normalizeDays(days) {
    if (days === undefined || !Number.isFinite(days) || days <= 0)
        return 7;
    return Math.max(1, Math.floor(days));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function asString(value) {
    return typeof value === 'string' ? value : null;
}
function asNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function formatPercent(value) {
    return value === null ? 'n/a' : `${value}%`;
}
function homeDir() {
    return process.env.HOME ?? os.homedir();
}
function countBy(values) {
    const counts = new Map();
    for (const value of values) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return counts;
}
function projectName(cwd) {
    return path.basename(cwd) || cwd;
}
function projectDisplayName(cwd, basenameCounts) {
    const name = projectName(cwd);
    if ((basenameCounts.get(name) ?? 0) <= 1)
        return name;
    return `${name} (${shortenHome(cwd)})`;
}
function shortenHome(filePath) {
    const home = homeDir();
    if (filePath === home)
        return '~';
    if (filePath.startsWith(`${home}${path.sep}`)) {
        return `~${filePath.slice(home.length)}`;
    }
    return filePath;
}
function dateKey(timestamp) {
    if (!timestamp)
        return null;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime()))
        return null;
    return date.toISOString().slice(0, 10);
}
function buildRecommendations(summary, basenameCounts) {
    const recommendations = [];
    if ((summary.latestRateLimits.primaryUsedPercent ?? 0) >= 90) {
        recommendations.push({
            severity: 'warning',
            message: 'Primary rate-limit pressure is high; pause large jobs or use smaller scoped asks.',
        });
    }
    else if ((summary.latestRateLimits.primaryUsedPercent ?? 0) >= 80) {
        recommendations.push({
            severity: 'info',
            message: 'Primary rate-limit pressure is elevated; keep the next few asks smaller if you need to keep working continuously.',
        });
    }
    if ((summary.latestContextUsagePercent ?? 0) >= 75) {
        recommendations.push({
            severity: 'warning',
            message: 'Recent context usage is high; start a new thread or ask for a checkpoint summary.',
        });
    }
    const failureReason = summary.topFailureReasons.find((item) => item.failures >= 5)
        ?? summary.topFailureReasons.find((item) => item.failures >= 3 && item.failures / Math.max(item.calls, 1) >= 0.25);
    if (failureReason) {
        recommendations.push({
            severity: 'warning',
            message: `${failureReason.projectDisplayName} has repeated ${failureReason.label.toLowerCase()}; ${failureReason.recommendation}`,
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
function formatDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    if (minutes > 0)
        return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}
function formatName(value, width) {
    if (value.length > width) {
        return `${value.slice(0, Math.max(1, width - 1))}…`;
    }
    return value.padEnd(width);
}
function classifySession(session) {
    if (session.toolFailures >= 5)
        return 'high friction';
    if (session.totalTokens > 0 && session.toolFailures <= 1)
        return 'likely deep work';
    return 'normal';
}
function failureReasonKey(cwd, toolName, commandFamily, category) {
    return `${cwd ?? ''}::${toolName}::${commandFamily}::${category}`;
}
function commandFamilyKey(toolName, commandFamily) {
    return `${toolName}::${commandFamily}`;
}
function sortFailureReasons(a, b) {
    return b.failures - a.failures
        || b.calls - a.calls
        || a.projectDisplayName.localeCompare(b.projectDisplayName)
        || a.commandFamily.localeCompare(b.commandFamily)
        || a.category.localeCompare(b.category);
}
function failureCategoryLabel(category) {
    switch (category) {
        case 'missing_path':
            return 'Missing path';
        case 'no_matches':
            return 'No matches';
        case 'shell_glob':
            return 'Shell glob';
        case 'test_or_build_failure':
            return 'Test/build failure';
        case 'timeout_or_truncated':
            return 'Timeout/truncated';
        case 'tool_error':
            return 'Tool error';
        case 'command_error':
            return 'Command error';
    }
}
function failureCategoryRecommendation(category) {
    switch (category) {
        case 'missing_path':
            return 'Check the repo layout or ask Codex to inspect files before searching.';
        case 'no_matches':
            return 'Adjust the search terms; this is usually low severity.';
        case 'shell_glob':
            return 'Quote globs or use rg --files before matching paths.';
        case 'test_or_build_failure':
            return 'Read the first failing test or build error before retrying.';
        case 'timeout_or_truncated':
            return 'Use narrower commands or lower output limits.';
        case 'tool_error':
            return 'Check the tool error and retry with a smaller scoped request.';
        case 'command_error':
            return 'Inspect the command result before retrying.';
    }
}
