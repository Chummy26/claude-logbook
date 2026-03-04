#!/usr/bin/env node

/**
 * hooks.ts — Silent background hook handler for logbook.
 *
 * Called by Claude Code hooks (Stop, PreCompact, SessionEnd).
 * Reads the conversation transcript, extracts meaningful memories,
 * deduplicates, and syncs to CLAUDE.md.
 *
 * Derived from memory-mcp's extractor.ts (~70%).
 */

import * as fs from "fs";
import * as path from "path";
import { MemoryStore, tokenize, jaccard } from "./store.js";
import { syncClaudeMd } from "./inject.js";
import type { HookInput, ExtractedMemory, Memory } from "./types.js";

// ─── Stdin ──────────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
    return new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf-8");
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
        setTimeout(() => resolve(data), 1000);
    });
}

// ─── Transcript Parsing ────────────────────────────────────────────────────

function readTranscript(transcriptPath: string, afterLine: number): string[] {
    if (!fs.existsSync(transcriptPath)) return [];
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    return lines.slice(afterLine);
}

function extractTextFromBlocks(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((b: Record<string, unknown>) => b.type === "text")
            .map((b: Record<string, unknown>) => b.text as string)
            .join(" ");
    }
    return "";
}

function summarizeTranscriptLines(lines: string[]): string {
    const events: string[] = [];

    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            const msg = entry.message || {};
            const content = msg.content;

            if (entry.type === "user") {
                const text =
                    typeof content === "string"
                        ? content
                        : extractTextFromBlocks(content);
                if (text) events.push(`USER: ${text.slice(0, 500)}`);
            } else if (entry.type === "assistant") {
                const text = extractTextFromBlocks(content);
                if (text) events.push(`CLAUDE: ${text.slice(0, 500)}`);

                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === "tool_use") {
                            const name = block.name || "unknown";
                            const input = block.input || {};

                            if (name === "Write" || name === "Edit") {
                                events.push(
                                    `TOOL [${name}]: ${input.file_path || "unknown file"}`
                                );
                            } else if (name === "Bash") {
                                events.push(
                                    `TOOL [Bash]: ${(input.command || "").slice(0, 200)}`
                                );
                            } else if (name === "Read") {
                                events.push(
                                    `TOOL [Read]: ${input.file_path || "unknown"}`
                                );
                            } else {
                                events.push(`TOOL [${name}]`);
                            }
                        }
                    }
                }
            }
        } catch {
            // Skip unparseable lines
        }
    }

    return events.join("\n");
}

// ─── Chunked Extraction ────────────────────────────────────────────────────

function chunkText(
    text: string,
    chunkSize: number,
    overlap: number
): string[] {
    if (text.length <= chunkSize) return [text];
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        chunks.push(text.slice(start, start + chunkSize));
        start += chunkSize - overlap;
    }
    return chunks;
}

/**
 * Build the extraction prompt for the LLM.
 * This would be sent to Haiku/equivalent for memory extraction.
 * For now, we use a simple heuristic-based extraction (no LLM dependency).
 */
function heuristicExtract(
    transcript: string,
    existingMemories: Memory[]
): ExtractedMemory[] {
    const memories: ExtractedMemory[] = [];
    const lines = transcript.split("\n");

    // Heuristic patterns for detecting various memory types
    const patterns: {
        regex: RegExp;
        type: ExtractedMemory["type"];
        tags: string[];
    }[] = [
            {
                regex: /decided to (?:use|go with|pick|choose|switch to) (.+)/i,
                type: "decision",
                tags: ["choice"],
            },
            {
                regex: /(?:architecture|structure|stack).*?(?:is|uses?|based on) (.+)/i,
                type: "architecture",
                tags: ["structure"],
            },
            {
                regex: /(?:convention|pattern|always|never|naming).*?(.+)/i,
                type: "pattern",
                tags: ["convention"],
            },
            {
                regex: /(?:bug|gotcha|pitfall|watch out|careful|warning).*?(.+)/i,
                type: "gotcha",
                tags: ["pitfall"],
            },
            {
                regex: /(?:completed?|finished|done|implemented|added|created|built) (.+)/i,
                type: "progress",
                tags: ["done"],
            },
            {
                regex: /(?:working on|in progress|started|began|implementing) (.+)/i,
                type: "progress",
                tags: ["in-flight"],
            },
            {
                regex: /TOOL \[(?:Write|Edit)\]: (.+)/,
                type: "progress",
                tags: ["file-change"],
            },
        ];

    for (const line of lines) {
        for (const { regex, type, tags } of patterns) {
            const match = line.match(regex);
            if (match) {
                const content = line.replace(/^(USER|CLAUDE|TOOL \[.*?\]):?\s*/, "").trim();
                if (content.length < 10) continue;

                // Check against existing memories for dedup
                const newTokens = tokenize(content);
                let isDuplicate = false;
                for (const existing of existingMemories) {
                    if (existing.type !== type) continue;
                    const sim = jaccard(newTokens, tokenize(existing.content));
                    if (sim > 0.6) {
                        isDuplicate = true;
                        break;
                    }
                }

                if (!isDuplicate) {
                    memories.push({ type, content, tags });
                }
                break; // only match first pattern per line
            }
        }
    }

    return memories.slice(0, 5); // Cap at 5 memories per extraction
}

// ─── Cursor ─────────────────────────────────────────────────────────────────

function getCursorPath(projectDir: string): string {
    return path.join(projectDir, ".logbook", "cursor.json");
}

function getCursor(projectDir: string, sessionId: string): number {
    const cursorPath = getCursorPath(projectDir);
    if (!fs.existsSync(cursorPath)) return 0;
    try {
        const cursors = JSON.parse(fs.readFileSync(cursorPath, "utf-8"));
        return cursors[sessionId] || 0;
    } catch {
        return 0;
    }
}

function setCursor(
    projectDir: string,
    sessionId: string,
    line: number
): void {
    const cursorPath = getCursorPath(projectDir);
    let cursors: Record<string, number> = {};
    if (fs.existsSync(cursorPath)) {
        try {
            cursors = JSON.parse(fs.readFileSync(cursorPath, "utf-8"));
        } catch {
            cursors = {};
        }
    }
    cursors[sessionId] = line;
    fs.writeFileSync(cursorPath, JSON.stringify(cursors, null, 2));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    try {
        const stdinData = await readStdin();
        if (!stdinData.trim()) return;

        const input: HookInput = JSON.parse(stdinData);
        const { session_id, transcript_path, cwd } = input;
        const event = input.hook_event_name;

        if (!transcript_path || !cwd) return;

        // Ensure .logbook dir exists
        const memDir = path.join(cwd, ".logbook");
        if (!fs.existsSync(memDir)) {
            fs.mkdirSync(memDir, { recursive: true });
        }

        const store = new MemoryStore(cwd);

        // Acquire lock
        if (!store.acquireLock()) return;

        try {
            // Read new transcript lines
            const cursor = getCursor(cwd, session_id);
            const newLines = readTranscript(transcript_path, cursor);

            // Minimum threshold: need meaningful content
            const minLines = event === "PreCompact" ? 1 : 3;
            if (newLines.length < minLines) {
                setCursor(cwd, session_id, cursor + newLines.length);
                return;
            }

            // Summarize transcript
            const summary = summarizeTranscriptLines(newLines);
            if (!summary.trim()) return;

            // Extract memories (heuristic-based, no LLM dependency)
            const existingMemories = store.getActiveMemories();
            const extracted = heuristicExtract(summary, existingMemories);

            // Save extracted memories
            for (const mem of extracted) {
                if (mem.supersedes_content) {
                    const superTokens = tokenize(mem.supersedes_content);
                    for (const existing of existingMemories) {
                        if (existing.type === mem.type) {
                            const sim = jaccard(superTokens, tokenize(existing.content));
                            if (sim > 0.5) {
                                store.addMemory({
                                    type: mem.type,
                                    content: mem.content,
                                    tags: mem.tags,
                                    supersedes: existing.id,
                                });
                                break;
                            }
                        }
                    }
                } else {
                    store.addMemory({
                        type: mem.type,
                        content: mem.content,
                        tags: mem.tags || [],
                    });
                }
            }

            // Update cursor
            setCursor(cwd, session_id, cursor + newLines.length);

            // Increment extraction count
            store.incrementExtractionCount();

            // Decay confidence
            store.decayConfidence();

            // Sync CLAUDE.md
            syncClaudeMd(cwd, store);
        } finally {
            store.releaseLock();
        }
    } catch {
        // Silent failure — never disrupt Claude's work
    }
}

// Only run if this file is executed directly
const isMainModule =
    process.argv[1] &&
    (process.argv[1].endsWith("hooks.js") ||
        process.argv[1].endsWith("hooks.ts"));

if (isMainModule) {
    main();
}

export { main as runHooks, heuristicExtract, summarizeTranscriptLines };
