/**
 * setup.ts — Auto-registers Claude Code hooks on first connection.
 *
 * On first MCP connection, registers Stop, PreCompact, and SessionEnd
 * hooks into .claude/settings.json. Detects whether hooks are already
 * installed (appends, never overwrites).
 *
 * Derived from memory-mcp's install.ts.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";

const HOOK_EVENTS = ["Stop", "PreCompact", "SessionEnd"] as const;

function currentDir(): string {
    return path.dirname(fileURLToPath(import.meta.url));
}

function isLogbookHookCommand(command?: unknown): boolean {
    return typeof command === "string" && command.includes("hooks.js");
}

/**
 * Auto-register logbook hooks in the project's Claude Code settings.
 * Only runs once — checks for a marker file in .logbook/.
 */
export function autoRegisterHooks(projectDir: string): void {
    const logbookDir = path.join(projectDir, ".logbook");
    const markerPath = path.join(logbookDir, ".hooks-registered");

    // Skip if already registered
    if (fs.existsSync(markerPath)) return;

    // Ensure .logbook dir exists
    if (!fs.existsSync(logbookDir)) {
        fs.mkdirSync(logbookDir, { recursive: true });
    }

    // Find the hooks.js path
    const hooksPath = findHooksScript();
    if (!hooksPath) {
        // Can't find hooks script — skip silently
        return;
    }

    // Register hooks in project settings
    const settingsPath = path.join(projectDir, ".claude", "settings.json");
    installHooksToSettings(settingsPath, hooksPath);

    // Write marker
    fs.writeFileSync(markerPath, new Date().toISOString());
}

/**
 * Find the compiled hooks.js script.
 */
function findHooksScript(): string | null {
    // Look for hooks.js relative to this file
    const dir = currentDir();
    const candidates = [
        path.join(dir, "memory", "hooks.js"),
        path.join(dir, "dist", "memory", "hooks.js"),
        path.join(process.cwd(), "dist", "memory", "hooks.js"),
        path.join(process.cwd(), "node_modules", "logbook-cc", "dist", "memory", "hooks.js"),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

/**
 * Install hook entries into a Claude Code settings.json file.
 * Appends to existing hooks — never overwrites.
 */
function installHooksToSettings(
    settingsPath: string,
    hooksPath: string
): void {
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        } catch {
            settings = {};
        }
    }

    if (!settings.hooks) {
        settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown[]>;

    const hookCommand = `node "${hooksPath}"`;
    const hookEntry = {
        hooks: [{ type: "command", command: hookCommand, timeout: 30 }],
    };

    for (const event of HOOK_EVENTS) {
        if (!hooks[event]) {
            hooks[event] = [];
        }

        // Check if logbook hook is already installed
        const alreadyInstalled = hooks[event].some((h: unknown) => {
            const entry = h as Record<string, unknown>;
            if (Array.isArray(entry.hooks)) {
                return entry.hooks.some((hh: unknown) => {
                    const hook = hh as Record<string, unknown>;
                    return isLogbookHookCommand(hook.command);
                });
            }
            return false;
        });

        if (!alreadyInstalled) {
            hooks[event].push(hookEntry);
        }
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Check if hooks are currently registered.
 */
export function areHooksRegistered(projectDir: string): boolean {
    const markerPath = path.join(projectDir, ".logbook", ".hooks-registered");
    return fs.existsSync(markerPath);
}

/**
 * Remove logbook hooks from settings.
 */
export function removeHooks(projectDir: string): void {
    const settingsPath = path.join(projectDir, ".claude", "settings.json");
    if (!fs.existsSync(settingsPath)) return;

    try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        const hooks = settings.hooks as Record<string, unknown[]> | undefined;
        if (!hooks) return;

        for (const event of HOOK_EVENTS) {
            if (hooks[event]) {
                hooks[event] = hooks[event].filter((h: unknown) => {
            const entry = h as Record<string, unknown>;
            if (Array.isArray(entry.hooks)) {
                return !entry.hooks.some((hh: unknown) => {
                    const hook = hh as Record<string, unknown>;
                    return isLogbookHookCommand(hook.command);
                });
            }
            return true;
        });
            }
        }

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

        // Remove marker
        const markerPath = path.join(projectDir, ".logbook", ".hooks-registered");
        if (fs.existsSync(markerPath)) {
            fs.unlinkSync(markerPath);
        }
    } catch {
        // Silent failure
    }
}
