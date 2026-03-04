// ─── Memory Types ───────────────────────────────────────────────────────────

export type MemoryType =
    | "decision"
    | "pattern"
    | "gotcha"
    | "architecture"
    | "progress"
    | "context";

export interface Memory {
    id: string;
    type: MemoryType;
    content: string;
    tags: string[];
    created: string;
    updated: string;
    supersedes?: string;
    confidence: number;
    accessCount: number;
    mergedFrom?: string[];
}

export interface ProjectState {
    version: number;
    project: string;
    description: string;
    memories: Memory[];
    lastUpdated: string;
    lastConsolidation?: string;
    extractionCount: number;
}

export interface ConsolidationResult {
    keep: string[];
    merge: { content: string; tags: string[]; sources: string[] }[];
    drop: string[];
}

// ─── HUD Types ──────────────────────────────────────────────────────────────

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface HudMetrics {
    contextPercent: number;
    riskLevel: RiskLevel;
    activeTools: number;
    memoryStatus: "active" | "inactive" | "degraded";
    compactEta?: string;
    totalTokens: number;
    maxTokens: number;
}

// ─── Patch Types ────────────────────────────────────────────────────────────

export interface ASTNode {
    id: string;
    type: string;
    name: string;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    text: string;
    children: ASTNode[];
}

export interface PatchTarget {
    nodeId: string;
    nodeName: string;
    nodeType: string;
    originalText: string;
    newText: string;
    startLine: number;
    endLine: number;
}

export interface PatchPlan {
    filePath: string;
    language: string;
    targets: PatchTarget[];
    description: string;
}

export interface PatchResult {
    success: boolean;
    filePath: string;
    changedLines: number;
    totalLines: number;
    targets: { nodeId: string; applied: boolean; error?: string }[];
    generatedTests?: string[];
}

// ─── Hook Types ─────────────────────────────────────────────────────────────

export interface HookInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
    hook_event_name: "Stop" | "PreCompact" | "SessionEnd";
}

export interface ExtractedMemory {
    type: MemoryType;
    content: string;
    tags: string[];
    supersedes_content?: string | null;
}
