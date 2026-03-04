#!/usr/bin/env node

/**
 * server.ts — MCP server entry point for logbook.
 *
 * Registers all MCP tools:
 *   - memory_search  — keyword search across stored memories
 *   - memory_save    — manually persist a memory with type/tags
 *   - patch_apply    — accept a surgical diff and apply it via AST
 *   - context_status — return HUD metrics (ctx%, risk, tools, etc.)
 *   - memory_recall  — list active memories
 *   - memory_delete  — delete a memory by id
 *   - memory_stats   — get memory store statistics
 *
 * Derived from memory-mcp's index.ts MCP server pattern.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "./memory/store.js";
import { syncClaudeMd } from "./memory/inject.js";
import { getContextSnapshot, formatContextStatus } from "./hud/monitor.js";
import { assessRisk, formatRiskAssessment } from "./hud/risk.js";
import { buildHudMetrics, renderStatusLine, renderDetailedHud } from "./hud/overlay.js";
import { planPatch, formatPatchPlan } from "./patch/planner.js";
import { applyPatch, previewPatch, generateUnifiedDiff } from "./patch/applier.js";
import { generateTests, getTestCommand } from "./patch/testgen.js";
import { detectLanguage } from "./patch/parser.js";
import { autoRegisterHooks } from "./setup.js";

// ─── Schema Constants ───────────────────────────────────────────────────────

const MEMORY_TYPE = z
    .enum(["decision", "pattern", "gotcha", "architecture", "progress", "context"])
    .describe(
        "Memory type: decision (why X over Y), pattern (conventions), " +
        "gotcha (pitfalls), architecture (system structure), " +
        "progress (what's done/in-flight), context (business context)"
    );

// ─── Server Creation ────────────────────────────────────────────────────────

const MCP_TOOL_NAMES = [
    "memory_search",
    "memory_save",
    "patch_apply",
    "context_status",
    "memory_recall",
    "memory_delete",
    "memory_stats",
] as const;

function createServer(projectDir: string): McpServer {
    const store = new MemoryStore(projectDir);

    const server = new McpServer({
        name: "logbook",
        version: "0.1.0",
    });

    // ── Tool: memory_search ──────────────────────────────────────────────────

    server.tool(
        "memory_search",
        "Search project memories by keyword. Returns ranked results matching " +
        "the query across content and tags. Use this to recall past decisions, " +
        "patterns, architecture notes, and gotchas.",
        {
            query: z.string().describe("Search query (keywords)"),
            type: MEMORY_TYPE.optional().describe("Filter by memory type"),
            limit: z.number().optional().describe("Max results (default 20)"),
        },
        async ({ query, type, limit }) => {
            let results = store.searchMemories(query, limit || 20);
            if (type) {
                results = results.filter((m) => m.type === type);
            }
            if (results.length === 0) {
                return {
                    content: [{ type: "text", text: `No memories matching "${query}".` }],
                };
            }
            const text = results
                .map((m) => {
                    const tagStr = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
                    return `[${m.id}] (${m.type}) ${m.content}${tagStr}`;
                })
                .join("\n\n");
            return {
                content: [
                    {
                        type: "text",
                        text: `${results.length} results for "${query}":\n\n${text}`,
                    },
                ],
            };
        }
    );

    // ── Tool: memory_save ────────────────────────────────────────────────────

    server.tool(
        "memory_save",
        "Save a memory about this project. Records decisions, patterns, " +
        "architecture, gotchas, progress, or context for future sessions. " +
        "Automatically deduplicates against existing memories.",
        {
            type: MEMORY_TYPE,
            content: z.string().describe("The memory — be specific and concise"),
            tags: z.array(z.string()).optional().describe("Tags for categorization"),
            supersedes: z
                .string()
                .optional()
                .describe("ID of memory this replaces"),
        },
        async ({ type, content, tags, supersedes }) => {
            const mem = store.addMemory({
                type,
                content,
                tags: tags || [],
                supersedes,
            });
            syncClaudeMd(projectDir, store);
            return {
                content: [
                    {
                        type: "text",
                        text: mem
                            ? `Saved: [${mem.id}] (${type}) ${content}`
                            : "Duplicate detected, skipped.",
                    },
                ],
            };
        }
    );

    // ── Tool: patch_apply ────────────────────────────────────────────────────

    server.tool(
        "patch_apply",
        "Apply a surgical code change to a file. Instead of rewriting the " +
        "entire file, logbook parses the AST, identifies only the nodes that " +
        "need to change, applies a minimal diff, and verifies the result " +
        "parses correctly. Optionally generates regression tests.",
        {
            file_path: z.string().describe("Absolute path to the file to patch"),
            new_content: z
                .string()
                .describe("The complete desired content of the file after patching"),
            description: z
                .string()
                .describe("Human-readable description of the change"),
            generate_tests: z
                .boolean()
                .optional()
                .describe("Generate regression test skeletons (default false)"),
            dry_run: z
                .boolean()
                .optional()
                .describe("Preview without applying (default false)"),
        },
        async ({ file_path, new_content, description, generate_tests: genTests, dry_run }) => {
            // Read current content
            if (!fs.existsSync(file_path)) {
                return {
                    content: [{ type: "text", text: `File not found: ${file_path}` }],
                };
            }

            const oldContent = fs.readFileSync(file_path, "utf-8");

            if (oldContent === new_content) {
                return {
                    content: [{ type: "text", text: "No changes detected." }],
                };
            }

            // Plan the patch
            const plan = planPatch(file_path, oldContent, new_content, description);
            const planSummary = formatPatchPlan(plan);

            if (dry_run) {
                const preview = previewPatch(plan);
                const diff = preview
                    ? generateUnifiedDiff(file_path, oldContent, preview)
                    : "Cannot generate preview.";
                return {
                    content: [
                        {
                            type: "text",
                            text: `DRY RUN — no changes applied.\n\n${planSummary}\n\nDiff:\n${diff}`,
                        },
                    ],
                };
            }

            // Apply the patch
            const result = applyPatch(plan);

            const parts: string[] = [];
            parts.push(result.success ? "✓ Patch applied successfully." : "✗ Patch failed.");
            parts.push("");
            parts.push(planSummary);
            parts.push("");
            parts.push(`Changed: ${result.changedLines} lines in ${result.totalLines} total`);

            // Report per-target results
            for (const t of result.targets) {
                const status = t.applied ? "✓" : "✗";
                parts.push(`  ${status} ${t.nodeId}${t.error ? ` — ${t.error}` : ""}`);
            }

            // Generate tests if requested
            if (genTests && result.success) {
                const tests = generateTests(plan);
                if (tests.length > 0) {
                    parts.push("");
                    parts.push("Generated test files:");
                    for (const test of tests) {
                        fs.writeFileSync(test.filePath, test.content);
                        parts.push(`  → ${test.filePath}`);
                    }

                    const lang = detectLanguage(file_path);
                    if (lang) {
                        const cmd = getTestCommand(lang);
                        if (cmd) {
                            parts.push(`\nRun tests with: ${cmd}`);
                        }
                    }

                    result.generatedTests = tests.map((t) => t.filePath);
                }
            }

            // Save a memory about this patch
            if (result.success) {
                store.addMemory({
                    type: "progress",
                    content: `Patched ${path.basename(file_path)}: ${description} (${result.changedLines} lines changed)`,
                    tags: ["patch", path.basename(file_path)],
                });
                syncClaudeMd(projectDir, store);
            }

            return {
                content: [{ type: "text", text: parts.join("\n") }],
            };
        }
    );

    // ── Tool: context_status ─────────────────────────────────────────────────

    server.tool(
        "context_status",
        "Get real-time context window metrics: usage percentage, " +
        "hallucination risk level, active MCP tools, memory status, " +
        "and estimated rounds until auto-compact fires.",
        {
            detailed: z
                .boolean()
                .optional()
                .describe("Show detailed breakdown (default false)"),
        },
        async ({ detailed }) => {
            const snapshot = getContextSnapshot(projectDir);
            const risk = assessRisk(snapshot, store);
            const metrics = buildHudMetrics(snapshot, risk, store, MCP_TOOL_NAMES.length);

            if (detailed) {
                const detailedOutput = renderDetailedHud(metrics, snapshot, risk);
                const contextStatus = formatContextStatus(snapshot);
                const riskStatus = formatRiskAssessment(risk);

                return {
                    content: [
                        {
                            type: "text",
                            text: `${detailedOutput}\n\n${contextStatus}\n\n${riskStatus}`,
                        },
                    ],
                };
            }

            const statusLine = renderStatusLine(metrics);
            return {
                content: [{ type: "text", text: statusLine }],
            };
        }
    );

    // ── Additional Tools ─────────────────────────────────────────────────────

    server.tool(
        "memory_recall",
        "Recall all active memories, optionally filtered by type or tags.",
        {
            type: MEMORY_TYPE.optional(),
            tags: z.array(z.string()).optional().describe("Filter by tags"),
        },
        async ({ type, tags }) => {
            const memories = store.getMemories({ type, tags });
            if (memories.length === 0) {
                return { content: [{ type: "text", text: "No memories found." }] };
            }
            const text = memories
                .map((m) => {
                    const tagStr = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
                    return `[${m.id}] (${m.type}) ${m.content}${tagStr}`;
                })
                .join("\n\n");
            return {
                content: [
                    {
                        type: "text",
                        text: `${memories.length} memories:\n\n${text}`,
                    },
                ],
            };
        }
    );

    server.tool(
        "memory_delete",
        "Delete a specific memory by ID.",
        { id: z.string().describe("Memory ID to delete") },
        async ({ id }) => {
            const ok = store.deleteMemory(id);
            if (ok) syncClaudeMd(projectDir, store);
            return {
                content: [
                    {
                        type: "text",
                        text: ok ? `Deleted ${id}` : `Not found: ${id}`,
                    },
                ],
            };
        }
    );

    server.tool(
        "memory_stats",
        "Show memory statistics: counts by type, active/archived/superseded.",
        {},
        async () => {
            const counts = store.getAllMemoryCount();
            const state = store.getState();
            const active = store.getActiveMemories();

            const byType: Record<string, number> = {};
            for (const m of active) {
                byType[m.type] = (byType[m.type] || 0) + 1;
            }

            const lines = [
                `Memory Stats:`,
                `  Active: ${counts.active}`,
                `  Archived: ${counts.archived}`,
                `  Superseded: ${counts.superseded}`,
                `  Total: ${counts.total}`,
                ``,
                `By type:`,
                ...Object.entries(byType).map(([t, n]) => `  ${t}: ${n}`),
                ``,
                `Extractions: ${state.extractionCount}`,
                `Last consolidation: ${state.lastConsolidation || "never"}`,
                `Last updated: ${state.lastUpdated}`,
            ];

            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
    );

    return server;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function runServer(argv: string[] = process.argv.slice(2)): Promise<void> {
    const rawProjectDir = argv[0];
    const projectDir = rawProjectDir && !rawProjectDir.startsWith("-")
        ? path.resolve(rawProjectDir)
        : process.cwd();

    // Auto-register hooks on first connection
    try {
        autoRegisterHooks(projectDir);
    } catch {
        // Non-fatal: hooks are optional for basic operation
    }

    const server = createServer(projectDir);
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

async function main() {
    await runServer(process.argv.slice(2));
}

const thisScript = fileURLToPath(import.meta.url);
if (process.argv[1] === thisScript) {
    main().catch((err) => {
        console.error("Fatal:", err);
        process.exit(1);
    });
}
