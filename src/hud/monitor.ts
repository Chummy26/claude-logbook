/**
 * monitor.ts — Context window tracker for logbook.
 *
 * Estimates token count from CLAUDE.md, loaded MCP schemas,
 * calculates ctx% against the ~200K limit, estimates compact ETA.
 */

import * as fs from "fs";
import * as path from "path";

// Claude's effective context window
const MAX_CONTEXT_TOKENS = 200_000;
// Quality degrades past this point
const DEGRADATION_THRESHOLD = 147_000;
// Rough char-to-token ratio
const CHARS_PER_TOKEN = 4;

export interface ContextSnapshot {
    /** Estimated total tokens currently in context */
    totalTokens: number;
    /** Maximum context window size */
    maxTokens: number;
    /** Percentage of context used (0-100) */
    usagePercent: number;
    /** Tokens from CLAUDE.md (Tier 1) */
    claudeMdTokens: number;
    /** Tokens from MCP tool schemas */
    mcpSchemaTokens: number;
    /** Estimated tokens from conversation */
    conversationTokens: number;
    /** Whether quality degradation is likely */
    degraded: boolean;
    /** Estimated rounds until auto-compact fires */
    compactEtaRounds: number | null;
}

/**
 * Estimate token count from text content.
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens consumed by CLAUDE.md.
 */
function getClaudeMdTokens(projectDir: string): number {
    const claudeMdPath = path.join(projectDir, "CLAUDE.md");
    if (!fs.existsSync(claudeMdPath)) return 0;
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    return estimateTokens(content);
}

/**
 * Estimate tokens consumed by MCP tool schemas.
 * Each MCP server typically costs 2K–17K tokens of schema.
 * We estimate by looking at .mcp.json if it exists.
 */
function getMcpSchemaTokens(projectDir: string): number {
    const mcpPath = path.join(projectDir, ".mcp.json");
    if (!fs.existsSync(mcpPath)) return 0;

    try {
        const config = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
        const servers = config.mcpServers || {};
        const serverCount = Object.keys(servers).length;
        // Average ~5K tokens per MCP server for schemas
        return serverCount * 5000;
    } catch {
        return 0;
    }
}

/**
 * Take a snapshot of the current context usage.
 *
 * @param projectDir - Project root directory
 * @param conversationTokenEstimate - Optional estimate of conversation tokens
 *        (if available from the session). Defaults to 0 since we can't
 *        directly measure this without hook data.
 */
export function getContextSnapshot(
    projectDir: string,
    conversationTokenEstimate: number = 0
): ContextSnapshot {
    const claudeMdTokens = getClaudeMdTokens(projectDir);
    const mcpSchemaTokens = getMcpSchemaTokens(projectDir);
    const conversationTokens = conversationTokenEstimate;

    const totalTokens = claudeMdTokens + mcpSchemaTokens + conversationTokens;
    const usagePercent = Math.round((totalTokens / MAX_CONTEXT_TOKENS) * 100);
    const degraded = totalTokens > DEGRADATION_THRESHOLD;

    // Estimate rounds until compact:
    // If we know conversation tokens are growing, estimate how many
    // rounds of ~2K tokens each until we hit the compact threshold (~95%)
    let compactEtaRounds: number | null = null;
    const compactThreshold = MAX_CONTEXT_TOKENS * 0.95;
    if (totalTokens < compactThreshold && conversationTokens > 0) {
        const tokensPerRound = 2000; // average tokens per user-assistant round
        const remaining = compactThreshold - totalTokens;
        compactEtaRounds = Math.floor(remaining / tokensPerRound);
    }

    return {
        totalTokens,
        maxTokens: MAX_CONTEXT_TOKENS,
        usagePercent,
        claudeMdTokens,
        mcpSchemaTokens,
        conversationTokens,
        degraded,
        compactEtaRounds,
    };
}

/**
 * Format a context snapshot as a brief status string.
 */
export function formatContextStatus(snapshot: ContextSnapshot): string {
    const lines: string[] = [];
    lines.push(`Context Usage: ${snapshot.usagePercent}% (${formatTokenCount(snapshot.totalTokens)} / ${formatTokenCount(snapshot.maxTokens)})`);
    lines.push(`  CLAUDE.md:      ${formatTokenCount(snapshot.claudeMdTokens)}`);
    lines.push(`  MCP schemas:    ${formatTokenCount(snapshot.mcpSchemaTokens)}`);
    lines.push(`  Conversation:   ${formatTokenCount(snapshot.conversationTokens)}`);

    if (snapshot.degraded) {
        lines.push(`  ⚠ Quality degradation likely (past ${formatTokenCount(DEGRADATION_THRESHOLD)} threshold)`);
    }

    if (snapshot.compactEtaRounds !== null) {
        lines.push(`  Compact ETA:    ~${snapshot.compactEtaRounds} rounds`);
    }

    return lines.join("\n");
}

function formatTokenCount(tokens: number): string {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`;
    }
    return String(tokens);
}
