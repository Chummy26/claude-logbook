/**
 * inject.ts — CLAUDE.md auto-updater for logbook.
 *
 * Generates a line-budgeted consciousness document and injects it
 * between <!-- logbook:start --> and <!-- logbook:end --> markers
 * in CLAUDE.md. Preserves any existing content outside the markers.
 *
 * Derived from memory-mcp's syncClaudeMd (~60%).
 */

import * as fs from "fs";
import * as path from "path";
import type { MemoryStore } from "./store.js";

const MARKERS = {
    start: "<!-- logbook:start -->",
    end: "<!-- logbook:end -->",
};

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sync the logbook memory block into CLAUDE.md.
 * Creates the file if it doesn't exist.
 * Replaces the block between markers if it exists.
 * Appends the block if markers don't exist yet.
 */
export function syncClaudeMd(projectDir: string, store: MemoryStore): void {
    const claudeMdPath = path.join(projectDir, "CLAUDE.md");
    const consciousness = store.generateConsciousness();

    const memoryBlock = `${MARKERS.start}\n${consciousness}\n${MARKERS.end}`;

    if (fs.existsSync(claudeMdPath)) {
        let existing = fs.readFileSync(claudeMdPath, "utf-8");

        if (
            existing.includes(MARKERS.start) &&
            existing.includes(MARKERS.end)
        ) {
            // Replace existing block
            const regex = new RegExp(
                `${escapeRegex(MARKERS.start)}[\\s\\S]*?${escapeRegex(MARKERS.end)}`
            );
            existing = existing.replace(regex, memoryBlock);
        } else {
            // Append block
            existing = existing.trimEnd() + "\n\n" + memoryBlock + "\n";
        }

        fs.writeFileSync(claudeMdPath, existing);
    } else {
        // Create new file
        fs.writeFileSync(claudeMdPath, memoryBlock + "\n");
    }
}

/**
 * Get the current memory block from CLAUDE.md, if it exists.
 */
export function getMemoryBlock(projectDir: string): string | null {
    const claudeMdPath = path.join(projectDir, "CLAUDE.md");
    if (!fs.existsSync(claudeMdPath)) return null;

    const content = fs.readFileSync(claudeMdPath, "utf-8");
    const startIdx = content.indexOf(MARKERS.start);
    const endIdx = content.indexOf(MARKERS.end);

    if (startIdx === -1 || endIdx === -1) return null;

    return content.slice(
        startIdx + MARKERS.start.length,
        endIdx
    ).trim();
}

/**
 * Estimate the token count of the memory block in CLAUDE.md.
 * Uses rough approximation of ~4 chars per token.
 */
export function estimateBlockTokens(projectDir: string): number {
    const block = getMemoryBlock(projectDir);
    if (!block) return 0;
    return Math.ceil(block.length / 4);
}
