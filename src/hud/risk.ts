/**
 * risk.ts — Hallucination risk scorer for logbook.
 *
 * Rates LOW / MEDIUM / HIGH / CRITICAL based on:
 *  - Context saturation (>73% = MEDIUM, >90% = HIGH)
 *  - Memory store staleness (outdated memories increase risk)
 *  - Active memory count (too few or too many)
 */

import type { RiskLevel } from "../memory/types.js";
import type { ContextSnapshot } from "./monitor.js";
import type { MemoryStore } from "../memory/store.js";

export interface RiskAssessment {
    level: RiskLevel;
    score: number; // 0.0 - 1.0
    factors: RiskFactor[];
}

export interface RiskFactor {
    name: string;
    weight: number; // contribution to final score
    description: string;
}

/**
 * Assess the hallucination risk based on context usage and memory state.
 */
export function assessRisk(
    snapshot: ContextSnapshot,
    store: MemoryStore
): RiskAssessment {
    const factors: RiskFactor[] = [];
    let totalScore = 0;

    // Factor 1: Context saturation (weight: 0.5)
    const saturationRatio = snapshot.usagePercent / 100;
    let saturationScore: number;
    if (saturationRatio < 0.5) {
        saturationScore = 0;
    } else if (saturationRatio < 0.73) {
        saturationScore = (saturationRatio - 0.5) / 0.23 * 0.3;
    } else if (saturationRatio < 0.9) {
        saturationScore = 0.3 + ((saturationRatio - 0.73) / 0.17) * 0.4;
    } else {
        saturationScore = 0.7 + ((saturationRatio - 0.9) / 0.1) * 0.3;
    }
    saturationScore = Math.min(1, saturationScore);
    const saturationWeight = 0.5;
    totalScore += saturationScore * saturationWeight;
    factors.push({
        name: "context_saturation",
        weight: saturationScore * saturationWeight,
        description: `Context ${snapshot.usagePercent}% full`,
    });

    // Factor 2: Memory staleness (weight: 0.25)
    const state = store.getState();
    const memories = store.getActiveMemories();
    let stalenessScore = 0;

    if (memories.length > 0) {
        const now = Date.now();
        const avgAge =
            memories.reduce(
                (sum, m) =>
                    sum + (now - new Date(m.updated).getTime()) / 86400000,
                0
            ) / memories.length;

        // >7 days average = stale
        stalenessScore = Math.min(1, avgAge / 14);
    } else {
        // No memories = no memory context = slight risk
        stalenessScore = 0.3;
    }

    const stalenessWeight = 0.25;
    totalScore += stalenessScore * stalenessWeight;
    factors.push({
        name: "memory_staleness",
        weight: stalenessScore * stalenessWeight,
        description:
            memories.length > 0
                ? `${memories.length} active memories`
                : "No active memories",
    });

    // Factor 3: Memory overload / sparsity (weight: 0.15)
    let overloadScore = 0;
    const counts = store.getAllMemoryCount();
    if (counts.active > 100) {
        overloadScore = Math.min(1, (counts.active - 100) / 100);
    } else if (counts.active < 3) {
        overloadScore = 0.2;
    }

    const overloadWeight = 0.15;
    totalScore += overloadScore * overloadWeight;
    factors.push({
        name: "memory_density",
        weight: overloadScore * overloadWeight,
        description: `${counts.active} active, ${counts.total} total memories`,
    });

    // Factor 4: Extraction recency (weight: 0.1)
    let recencyScore = 0;
    if (state.lastUpdated) {
        const daysSinceUpdate =
            (Date.now() - new Date(state.lastUpdated).getTime()) / 86400000;
        recencyScore = Math.min(1, daysSinceUpdate / 7);
    } else {
        recencyScore = 0.5;
    }

    const recencyWeight = 0.1;
    totalScore += recencyScore * recencyWeight;
    factors.push({
        name: "extraction_recency",
        weight: recencyScore * recencyWeight,
        description: state.lastUpdated
            ? `Last updated: ${state.lastUpdated.split("T")[0]}`
            : "Never updated",
    });

    // Determine risk level
    let level: RiskLevel;
    if (totalScore < 0.2) {
        level = "LOW";
    } else if (totalScore < 0.45) {
        level = "MEDIUM";
    } else if (totalScore < 0.7) {
        level = "HIGH";
    } else {
        level = "CRITICAL";
    }

    return {
        level,
        score: Math.round(totalScore * 100) / 100,
        factors,
    };
}

/**
 * Format a risk assessment as a brief string.
 */
export function formatRiskAssessment(assessment: RiskAssessment): string {
    const lines = [
        `Risk Level: ${assessment.level} (score: ${assessment.score})`,
        "",
        "Factors:",
    ];

    for (const factor of assessment.factors) {
        const bar = "█".repeat(Math.round(factor.weight * 20));
        lines.push(`  ${factor.name}: ${bar} ${factor.description}`);
    }

    return lines.join("\n");
}
