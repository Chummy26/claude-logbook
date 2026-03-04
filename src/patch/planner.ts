/**
 * planner.ts — Minimal diff planner for logbook's patch engine.
 *
 * Given a file and desired changes, identifies the minimal set
 * of AST nodes that need modification. Uses Myers diff algorithm
 * principles to compute the shortest edit path.
 */

import * as fs from "fs";
import type { ASTNode, PatchPlan, PatchTarget } from "../memory/types.js";
import { parseFile, detectLanguage } from "./parser.js";

// ─── Myers Diff (simplified) ─────────────────────────────────────────────────

interface DiffEdit {
    type: "insert" | "delete" | "equal";
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

/**
 * Compute line-level diffs between two texts.
 * Returns a list of edit operations.
 */
export function computeLineDiff(
    oldText: string,
    newText: string
): DiffEdit[] {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");
    const edits: DiffEdit[] = [];

    // Simple LCS-based diff
    const lcs = computeLCS(oldLines, newLines);
    let oldIdx = 0;
    let newIdx = 0;

    for (const { oldLine, newLine } of lcs) {
        // Handle deletions before this common line
        if (oldIdx < oldLine) {
            edits.push({
                type: "delete",
                oldStart: oldIdx,
                oldEnd: oldLine,
                newStart: newIdx,
                newEnd: newIdx,
            });
        }
        // Handle insertions before this common line
        if (newIdx < newLine) {
            edits.push({
                type: "insert",
                oldStart: oldLine,
                oldEnd: oldLine,
                newStart: newIdx,
                newEnd: newLine,
            });
        }
        // Equal line
        edits.push({
            type: "equal",
            oldStart: oldLine,
            oldEnd: oldLine + 1,
            newStart: newLine,
            newEnd: newLine + 1,
        });
        oldIdx = oldLine + 1;
        newIdx = newLine + 1;
    }

    // Handle trailing deletions/insertions
    if (oldIdx < oldLines.length) {
        edits.push({
            type: "delete",
            oldStart: oldIdx,
            oldEnd: oldLines.length,
            newStart: newIdx,
            newEnd: newIdx,
        });
    }
    if (newIdx < newLines.length) {
        edits.push({
            type: "insert",
            oldStart: oldLines.length,
            oldEnd: oldLines.length,
            newStart: newIdx,
            newEnd: newLines.length,
        });
    }

    return edits.filter((e) => e.type !== "equal");
}

interface LCSEntry {
    oldLine: number;
    newLine: number;
}

/**
 * Compute Longest Common Subsequence of two line arrays.
 */
function computeLCS(oldLines: string[], newLines: string[]): LCSEntry[] {
    const m = oldLines.length;
    const n = newLines.length;

    // Build DP table
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
        new Array(n + 1).fill(0)
    );

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack to find LCS
    const result: LCSEntry[] = [];
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
        if (oldLines[i - 1] === newLines[j - 1]) {
            result.unshift({ oldLine: i - 1, newLine: j - 1 });
            i--;
            j--;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }

    return result;
}

// ─── Patch Planning ──────────────────────────────────────────────────────────

/**
 * Plan a minimal patch: identify which AST nodes are affected by changes.
 *
 * @param filePath - Path to the file to patch
 * @param oldContent - Current file content
 * @param newContent - Desired file content
 * @param description - Human-readable description of the change
 * @returns A PatchPlan targeting only the affected nodes
 */
export function planPatch(
    filePath: string,
    oldContent: string,
    newContent: string,
    description: string
): PatchPlan {
    const language = detectLanguage(filePath) || "unknown";

    // Get the line-level diffs
    const diffs = computeLineDiff(oldContent, newContent);

    // Parse the old content to get AST nodes
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const nodes = parseFile(filePath);

    // Find which AST nodes are affected by the diffs
    const targets: PatchTarget[] = [];
    const affectedNodeIds = new Set<string>();

    for (const diff of diffs) {
        if (diff.type === "equal") continue;

        // Find nodes that overlap with this diff range
        for (const node of nodes) {
            if (affectedNodeIds.has(node.id)) continue;

            const nodeStart = node.startPosition.row;
            const nodeEnd = node.endPosition.row;
            const diffStart = diff.oldStart;
            const diffEnd = diff.oldEnd;

            // Check overlap
            if (nodeStart <= diffEnd && nodeEnd >= diffStart) {
                affectedNodeIds.add(node.id);

                // Get the new text for this node
                // Map old node lines to new content via diff
                const nodeOldText = oldLines
                    .slice(nodeStart, nodeEnd + 1)
                    .join("\n");

                // Find corresponding new text by computing the offset
                const offset = computeLineOffset(diffs, nodeStart);
                const newNodeStart = nodeStart + offset;
                const newNodeEnd = Math.min(
                    newNodeStart + (nodeEnd - nodeStart),
                    newLines.length - 1
                );
                const nodeNewText = newLines
                    .slice(newNodeStart, newNodeEnd + 1)
                    .join("\n");

                targets.push({
                    nodeId: node.id,
                    nodeName: node.name,
                    nodeType: node.type,
                    originalText: nodeOldText,
                    newText: nodeNewText,
                    startLine: nodeStart,
                    endLine: nodeEnd,
                });
            }
        }

        // If no AST node covers this diff, create a raw line target
        if (targets.length === 0 || !targets.some((t) =>
            t.startLine <= diff.oldStart && t.endLine >= diff.oldEnd - 1
        )) {
            const rawOld = oldLines.slice(diff.oldStart, diff.oldEnd).join("\n");
            const rawNew = diff.type === "insert"
                ? newLines.slice(diff.newStart, diff.newEnd).join("\n")
                : "";

            targets.push({
                nodeId: `raw_${diff.oldStart}_${diff.oldEnd}`,
                nodeName: `lines ${diff.oldStart + 1}-${diff.oldEnd}`,
                nodeType: "raw",
                originalText: rawOld,
                newText: rawNew,
                startLine: diff.oldStart,
                endLine: diff.oldEnd - 1,
            });
        }
    }

    if (language === "unknown" && diffs.length > 0) {
        return {
            filePath,
            language,
            targets: [
                {
                    nodeId: "raw_entire_file",
                    nodeName: "entire file",
                    nodeType: "raw",
                    originalText: oldContent,
                    newText: newContent,
                    startLine: 0,
                    endLine: Math.max(oldLines.length - 1, 0),
                },
            ],
            description,
        };
    }

    return {
        filePath,
        language,
        targets,
        description,
    };
}

/**
 * Compute the cumulative line offset at a given line number
 * caused by insertions and deletions before it.
 */
function computeLineOffset(diffs: DiffEdit[], lineNumber: number): number {
    let offset = 0;
    for (const diff of diffs) {
        if (diff.oldStart >= lineNumber) break;
        if (diff.type === "insert") {
            offset += diff.newEnd - diff.newStart;
        } else if (diff.type === "delete") {
            offset -= diff.oldEnd - diff.oldStart;
        }
    }
    return offset;
}

/**
 * Format a PatchPlan as a human-readable summary.
 */
export function formatPatchPlan(plan: PatchPlan): string {
    const lines: string[] = [];
    lines.push(`Patch Plan: ${plan.description}`);
    lines.push(`File: ${plan.filePath} (${plan.language})`);
    lines.push(`Targets: ${plan.targets.length}`);
    lines.push("");

    for (const target of plan.targets) {
        lines.push(`  → ${target.nodeType} "${target.nodeName}" (lines ${target.startLine + 1}-${target.endLine + 1})`);
        const oldLineCount = target.originalText.split("\n").length;
        const newLineCount = target.newText.split("\n").length;
        const delta = newLineCount - oldLineCount;
        const sign = delta >= 0 ? "+" : "";
        lines.push(`    ${oldLineCount} → ${newLineCount} lines (${sign}${delta})`);
    }

    return lines.join("\n");
}
