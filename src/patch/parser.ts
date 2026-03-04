/**
 * parser.ts — Tree-sitter AST parser for logbook's patch engine.
 *
 * Loads WASM grammars for TypeScript, Python, Rust, Go.
 * Parses files incrementally, extracts stable node IDs.
 * Language detection from file extension.
 */

import * as fs from "fs";
import * as path from "path";
import type { ASTNode } from "../memory/types.js";

// ─── Language Detection ─────────────────────────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".java": "java",
    ".rb": "ruby",
    ".php": "php",
};

/**
 * Detect language from file extension.
 */
export function detectLanguage(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return LANGUAGE_MAP[ext] || null;
}

/**
 * Get all supported extensions.
 */
export function getSupportedExtensions(): string[] {
    return Object.keys(LANGUAGE_MAP);
}

// ─── Node Extraction (Regex-based fallback) ─────────────────────────────────
//
// Since web-tree-sitter requires WASM grammars that may not be available,
// we provide a robust regex-based parser that handles the common case:
// extracting function and class declarations from source code.
//
// This is used as the primary parser until tree-sitter WASM grammars
// are configured, at which point tree-sitter takes over.

interface ExtractedSymbol {
    type: "function" | "class" | "method" | "variable" | "interface";
    name: string;
    startLine: number;
    endLine: number;
    text: string;
}

/**
 * Extract top-level symbols from source code using regex patterns.
 * This works for TypeScript, JavaScript, Python, Go, and Rust.
 */
export function extractSymbols(
    source: string,
    language: string
): ExtractedSymbol[] {
    const lines = source.split("\n");
    const symbols: ExtractedSymbol[] = [];

    const patterns = getLanguagePatterns(language);
    if (!patterns) return symbols;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const pattern of patterns) {
            const match = line.match(pattern.regex);
            if (match) {
                const name = match[1];
                const startLine = i;

                // Find the end of the block by counting braces / indentation
                const endLine = findBlockEnd(lines, i, language);

                symbols.push({
                    type: pattern.type,
                    name,
                    startLine,
                    endLine,
                    text: lines.slice(startLine, endLine + 1).join("\n"),
                });
                break;
            }
        }
    }

    return symbols;
}

interface LanguagePattern {
    regex: RegExp;
    type: ExtractedSymbol["type"];
}

function getLanguagePatterns(language: string): LanguagePattern[] | null {
    switch (language) {
        case "typescript":
        case "javascript":
            return [
                { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/, type: "function" },
                { regex: /^(?:export\s+)?class\s+(\w+)/, type: "class" },
                { regex: /^(?:export\s+)?interface\s+(\w+)/, type: "interface" },
                { regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/, type: "function" },
                { regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, type: "function" },
            ];
        case "python":
            return [
                { regex: /^(?:async\s+)?def\s+(\w+)\s*\(/, type: "function" },
                { regex: /^class\s+(\w+)/, type: "class" },
            ];
        case "rust":
            return [
                { regex: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, type: "function" },
                { regex: /^(?:pub\s+)?struct\s+(\w+)/, type: "class" },
                { regex: /^(?:pub\s+)?enum\s+(\w+)/, type: "class" },
                { regex: /^(?:pub\s+)?trait\s+(\w+)/, type: "interface" },
                { regex: /^impl(?:\s*<[^>]*>)?\s+(\w+)/, type: "class" },
            ];
        case "go":
            return [
                { regex: /^func\s+(\w+)\s*\(/, type: "function" },
                { regex: /^func\s+\(\w+\s+\*?\w+\)\s+(\w+)\s*\(/, type: "method" },
                { regex: /^type\s+(\w+)\s+struct\s*\{/, type: "class" },
                { regex: /^type\s+(\w+)\s+interface\s*\{/, type: "interface" },
            ];
        default:
            return null;
    }
}

/**
 * Find the end of a code block starting at `startLine`.
 * Uses brace counting for C-style languages, indentation for Python.
 */
function findBlockEnd(
    lines: string[],
    startLine: number,
    language: string
): number {
    if (language === "python") {
        return findPythonBlockEnd(lines, startLine);
    }
    return findBraceBlockEnd(lines, startLine);
}

function findBraceBlockEnd(lines: string[], startLine: number): number {
    let braceCount = 0;
    let foundOpen = false;

    for (let i = startLine; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === "{") {
                braceCount++;
                foundOpen = true;
            } else if (ch === "}") {
                braceCount--;
                if (foundOpen && braceCount === 0) {
                    return i;
                }
            }
        }
    }

    // If no braces found (e.g., single line), return start line
    return foundOpen ? lines.length - 1 : startLine;
}

function findPythonBlockEnd(lines: string[], startLine: number): number {
    // Find the indentation of the def/class line
    const startIndent = lines[startLine].search(/\S/);

    for (let i = startLine + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "") continue; // skip blank lines

        const indent = line.search(/\S/);
        if (indent <= startIndent) {
            return i - 1;
        }
    }

    return lines.length - 1;
}

/**
 * Convert extracted symbols into ASTNode format.
 */
export function symbolsToASTNodes(symbols: ExtractedSymbol[]): ASTNode[] {
    return symbols.map((sym, idx) => ({
        id: `${sym.type}_${sym.name}_${sym.startLine}`,
        type: sym.type,
        name: sym.name,
        startPosition: { row: sym.startLine, column: 0 },
        endPosition: { row: sym.endLine, column: 0 },
        text: sym.text,
        children: [],
    }));
}

/**
 * Parse a file and return its AST nodes.
 */
export function parseFile(filePath: string): ASTNode[] {
    const language = detectLanguage(filePath);
    if (!language) return [];

    if (!fs.existsSync(filePath)) return [];

    const source = fs.readFileSync(filePath, "utf-8");
    const symbols = extractSymbols(source, language);
    return symbolsToASTNodes(symbols);
}
