/**
 * overlay.ts — Terminal statusline and environment-aware rendering for logbook.
 *
 * Renders the HUD string:
 *   [logbook] ctx: 12% | risk: LOW | tools: 7 | memory: active
 *
 * Detects terminal vs VSCode environment, formats accordingly.
 */

import type { HudMetrics, RiskLevel } from "../memory/types.js";
import type { ContextSnapshot } from "./monitor.js";
import type { RiskAssessment } from "./risk.js";
import type { MemoryStore } from "../memory/store.js";

// ─── ANSI Colors (for terminal) ─────────────────────────────────────────────

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

const RISK_COLORS: Record<RiskLevel, string> = {
    LOW: "\x1b[32m",      // green
    MEDIUM: "\x1b[33m",   // yellow
    HIGH: "\x1b[31m",     // red
    CRITICAL: "\x1b[41m", // red background
};

const CTX_COLORS = {
    low: "\x1b[32m",    // green  (< 50%)
    mid: "\x1b[33m",    // yellow (50-73%)
    high: "\x1b[31m",   // red    (> 73%)
};

// ─── Environment Detection ──────────────────────────────────────────────────

export type Environment = "terminal" | "vscode" | "unknown";

export function detectEnvironment(): Environment {
    if (process.env.VSCODE_PID || process.env.TERM_PROGRAM === "vscode") {
        return "vscode";
    }
    if (process.stdout.isTTY) {
        return "terminal";
    }
    return "unknown";
}

// ─── HUD Rendering ─────────────────────────────────────────────────────────

/**
 * Build HUD metrics from current state.
 */
export function buildHudMetrics(
    snapshot: ContextSnapshot,
    risk: RiskAssessment,
    store: MemoryStore,
    toolCount: number = 7
): HudMetrics {
    const counts = store.getAllMemoryCount();
    const state = store.getState();

    let memoryStatus: "active" | "inactive" | "degraded";
    if (counts.active === 0) {
        memoryStatus = "inactive";
    } else if (counts.active > 80) {
        memoryStatus = "degraded";
    } else {
        memoryStatus = "active";
    }

    // Count MCP tools (approximate)
    const activeTools = Math.max(1, toolCount);

    return {
        contextPercent: snapshot.usagePercent,
        riskLevel: risk.level,
        activeTools,
        memoryStatus,
        compactEta: snapshot.compactEtaRounds !== null
            ? `~${snapshot.compactEtaRounds}r`
            : undefined,
        totalTokens: snapshot.totalTokens,
        maxTokens: snapshot.maxTokens,
    };
}

/**
 * Render the compact one-line HUD string.
 *
 * Format: [logbook] ctx: 12% | risk: LOW | tools: 7 | memory: active
 */
export function renderStatusLine(metrics: HudMetrics): string {
    const env = detectEnvironment();

    if (env === "terminal") {
        return renderTerminalStatusLine(metrics);
    }
    return renderPlainStatusLine(metrics);
}

function renderTerminalStatusLine(metrics: HudMetrics): string {
    // Color the context percentage
    let ctxColor: string;
    if (metrics.contextPercent < 50) {
        ctxColor = CTX_COLORS.low;
    } else if (metrics.contextPercent < 73) {
        ctxColor = CTX_COLORS.mid;
    } else {
        ctxColor = CTX_COLORS.high;
    }

    // Color the risk level
    const riskColor = RISK_COLORS[metrics.riskLevel];

    const parts = [
        `${DIM}[logbook]${RESET}`,
        `ctx: ${ctxColor}${BOLD}${metrics.contextPercent}%${RESET}`,
        `risk: ${riskColor}${BOLD}${metrics.riskLevel}${RESET}`,
        `tools: ${metrics.activeTools}`,
        `memory: ${metrics.memoryStatus}`,
    ];

    if (metrics.compactEta) {
        parts.push(`compact: ${metrics.compactEta}`);
    }

    return parts.join(` ${DIM}|${RESET} `);
}

function renderPlainStatusLine(metrics: HudMetrics): string {
    const parts = [
        `[logbook]`,
        `ctx: ${metrics.contextPercent}%`,
        `risk: ${metrics.riskLevel}`,
        `tools: ${metrics.activeTools}`,
        `memory: ${metrics.memoryStatus}`,
    ];

    if (metrics.compactEta) {
        parts.push(`compact: ${metrics.compactEta}`);
    }

    return parts.join(" | ");
}

/**
 * Render a detailed multi-line HUD report.
 */
export function renderDetailedHud(
    metrics: HudMetrics,
    snapshot: ContextSnapshot,
    risk: RiskAssessment
): string {
    const lines: string[] = [];

    lines.push("╔══════════════════════════════════════════════╗");
    lines.push("║             📓 logbook HUD                  ║");
    lines.push("╠══════════════════════════════════════════════╣");
    lines.push(`║  Context:  ${padRight(`${metrics.contextPercent}% (${formatTokens(metrics.totalTokens)} / ${formatTokens(metrics.maxTokens)})`, 33)}║`);
    lines.push(`║  Risk:     ${padRight(metrics.riskLevel + ` (score: ${risk.score})`, 33)}║`);
    lines.push(`║  Tools:    ${padRight(String(metrics.activeTools), 33)}║`);
    lines.push(`║  Memory:   ${padRight(metrics.memoryStatus, 33)}║`);

    if (metrics.compactEta) {
        lines.push(`║  Compact:  ${padRight(metrics.compactEta, 33)}║`);
    }

    lines.push("╠══════════════════════════════════════════════╣");
    lines.push("║  Risk Factors:                               ║");

    for (const factor of risk.factors) {
        const barLen = Math.round(factor.weight * 30);
        const bar = "█".repeat(barLen) + "░".repeat(30 - barLen);
        lines.push(`║  ${padRight(factor.name, 18)} ${bar} ║`);
    }

    lines.push("╚══════════════════════════════════════════════╝");

    return lines.join("\n");
}

function padRight(str: string, len: number): string {
    return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function formatTokens(tokens: number): string {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`;
    }
    return String(tokens);
}
