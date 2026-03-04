/**
 * applier.ts — Surgical patch applier for logbook.
 *
 * Takes a PatchPlan, validates it against current file state,
 * applies changes surgically, verifies the result parses correctly.
 *
 * Inspired ~40% by agent-orchestrator's reactions pattern
 * for CI failure routing.
 */

import * as fs from "fs";
import * as path from "path";
import type { PatchPlan, PatchResult, PatchTarget } from "../memory/types.js";
import { detectLanguage, extractSymbols } from "./parser.js";

// ─── Validation ─────────────────────────────────────────────────────────────

interface ValidationResult {
    valid: boolean;
    errors: string[];
}

/**
 * Validate a patch plan against the current file state.
 * Ensures the file exists, content hasn't changed unexpectedly,
 * and all target nodes can be located.
 */
export function validatePatchPlan(plan: PatchPlan): ValidationResult {
    const errors: string[] = [];

    // Check file exists
    if (!fs.existsSync(plan.filePath)) {
        errors.push(`File not found: ${plan.filePath}`);
        return { valid: false, errors };
    }

    const currentContent = fs.readFileSync(plan.filePath, "utf-8");
    const currentLines = currentContent.split("\n");

    // Validate each target
    for (const target of plan.targets) {
        // Check line bounds
        if (target.startLine < 0 || target.endLine >= currentLines.length) {
            errors.push(
                `Target "${target.nodeName}" lines ${target.startLine + 1}-${target.endLine + 1} ` +
                `out of bounds (file has ${currentLines.length} lines)`
            );
            continue;
        }

        // Check original text matches current state
        const currentText = currentLines
            .slice(target.startLine, target.endLine + 1)
            .join("\n");

        if (currentText !== target.originalText) {
            // Allow fuzzy matching (trimmed comparison)
            const trimCurrent = currentText.trim();
            const trimOriginal = target.originalText.trim();
            if (trimCurrent !== trimOriginal) {
                errors.push(
                    `Target "${target.nodeName}" at lines ${target.startLine + 1}-${target.endLine + 1} ` +
                    `has been modified since the plan was created`
                );
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

// ─── Application ────────────────────────────────────────────────────────────

/**
 * Apply a patch plan to the file.
 * Returns a PatchResult indicating success/failure for each target.
 */
export function applyPatch(plan: PatchPlan): PatchResult {
    const validation = validatePatchPlan(plan);

    if (!validation.valid) {
        return {
            success: false,
            filePath: plan.filePath,
            changedLines: 0,
            totalLines: 0,
            targets: plan.targets.map((t) => ({
                nodeId: t.nodeId,
                applied: false,
                error: "Pre-validation failed: " + validation.errors.join("; "),
            })),
        };
    }

    const currentContent = fs.readFileSync(plan.filePath, "utf-8");
    const lines = currentContent.split("\n");
    const targetResults: { nodeId: string; applied: boolean; error?: string }[] = [];

    // Sort targets by start line (descending) to apply from bottom to top
    // This prevents line number shifts from affecting earlier targets
    const sortedTargets = [...plan.targets].sort(
        (a, b) => b.startLine - a.startLine
    );

    let changedLines = 0;

    for (const target of sortedTargets) {
        try {
            // Replace the target lines
            const newLines = target.newText.split("\n");
            const oldCount = target.endLine - target.startLine + 1;
            lines.splice(target.startLine, oldCount, ...newLines);
            changedLines += Math.abs(newLines.length - oldCount) + newLines.length;

            targetResults.push({ nodeId: target.nodeId, applied: true });
        } catch (err) {
            targetResults.push({
                nodeId: target.nodeId,
                applied: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const newContent = lines.join("\n");

    // Verify the result still parses
    const language = detectLanguage(plan.filePath);
    let parseError: string | undefined;

    if (language) {
        try {
            const symbols = extractSymbols(newContent, language);
            // Basic validation: if we had symbols before, we should still have some
        } catch (err) {
            parseError =
                "Post-patch parse error: " +
                (err instanceof Error ? err.message : String(err));
        }
    }

    if (parseError) {
        // Rollback: don't write the broken file
        return {
            success: false,
            filePath: plan.filePath,
            changedLines: 0,
            totalLines: lines.length,
            targets: targetResults.map((t) => ({
                ...t,
                applied: false,
                error: t.applied ? parseError : t.error,
            })),
        };
    }

    // Write the patched file atomically
    const tmpPath = plan.filePath + ".logbook.tmp";
    fs.writeFileSync(tmpPath, newContent);
    fs.renameSync(tmpPath, plan.filePath);

    return {
        success: targetResults.every((t) => t.applied),
        filePath: plan.filePath,
        changedLines,
        totalLines: lines.length,
        targets: targetResults,
    };
}

/**
 * Preview what a patch would do without actually applying it.
 * Returns the new content as a string.
 */
export function previewPatch(plan: PatchPlan): string | null {
    const validation = validatePatchPlan(plan);
    if (!validation.valid) return null;

    const currentContent = fs.readFileSync(plan.filePath, "utf-8");
    const lines = currentContent.split("\n");

    const sortedTargets = [...plan.targets].sort(
        (a, b) => b.startLine - a.startLine
    );

    for (const target of sortedTargets) {
        const newLines = target.newText.split("\n");
        const oldCount = target.endLine - target.startLine + 1;
        lines.splice(target.startLine, oldCount, ...newLines);
    }

    return lines.join("\n");
}

/**
 * Generate a unified diff string for display.
 */
export function generateUnifiedDiff(
    filePath: string,
    oldContent: string,
    newContent: string
): string {
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const diffLines: string[] = [];

    diffLines.push(`--- a/${path.basename(filePath)}`);
    diffLines.push(`+++ b/${path.basename(filePath)}`);

    // Simple line-by-line diff output
    const maxLen = Math.max(oldLines.length, newLines.length);
    let contextStart = -1;

    for (let i = 0; i < maxLen; i++) {
        const oldLine = i < oldLines.length ? oldLines[i] : null;
        const newLine = i < newLines.length ? newLines[i] : null;

        if (oldLine !== newLine) {
            if (contextStart === -1) {
                // Start a new hunk
                const start = Math.max(0, i - 3);
                diffLines.push(`@@ -${start + 1} +${start + 1} @@`);
                // Add context lines
                for (let j = start; j < i; j++) {
                    if (j < oldLines.length) {
                        diffLines.push(` ${oldLines[j]}`);
                    }
                }
                contextStart = i;
            }
            if (oldLine !== null) diffLines.push(`-${oldLine}`);
            if (newLine !== null) diffLines.push(`+${newLine}`);
        } else if (contextStart !== -1) {
            diffLines.push(` ${oldLine}`);
            if (i - contextStart > 6) {
                contextStart = -1; // End hunk after 3 context lines
            }
        }
    }

    return diffLines.join("\n");
}
