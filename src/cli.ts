#!/usr/bin/env node

/**
 * cli.ts — project install helper for logbook.
 *
 * Supports:
 *   logbook-cc init [dir]           Write/update .mcp.json for the project.
 *   logbook-cc --help               Show usage.
 *   logbook-cc                       Start MCP server (default, for Claude).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoRegisterHooks } from "./setup.js";
import { runServer } from "./server.js";

const ROOT_COLORS = {
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    reset: "\x1b[0m",
};

function currentDir(): string {
    return path.dirname(fileURLToPath(import.meta.url));
}

function hasArg(args: string[], flag: string): boolean {
    return args.includes(flag);
}

function resolveProjectDir(rawArg?: string): string {
    return path.resolve(rawArg || ".");
}

function resolveServerPath(): string {
    return path.join(currentDir(), "server.js");
}

function commandHelp() {
    console.log(`
${ROOT_COLORS.cyan}logbook${ROOT_COLORS.reset} — install helper and MCP entrypoint

Usage:
  logbook-cc init [projectDir]    Generate .mcp.json for a project
  logbook-cc --help               Show this help

Default:
  Running without a recognized command starts the MCP server.
`);
}

function writeProjectConfig(projectDir: string): void {
    const mcpPath = path.join(projectDir, ".mcp.json");
    const serverPath = resolveServerPath();
    const projectPath = path.resolve(projectDir);

    let config: Record<string, unknown> = {};
    if (existsSync(mcpPath)) {
        try {
            config = JSON.parse(readFileSync(mcpPath, "utf-8"));
        } catch {
            config = {};
        }
    }

    if (!config.mcpServers || typeof config.mcpServers !== "object") {
        config.mcpServers = {};
    }

    (config.mcpServers as Record<string, unknown>).logbook = {
        command: "node",
        args: [serverPath, projectPath],
    };

    writeFileSync(mcpPath, JSON.stringify(config, null, 2));
}

async function runInit(args: string[]): Promise<void> {
    const target = args[0] && !args[0].startsWith("-") ? args[0] : ".";
    const projectDir = resolveProjectDir(target);

    writeProjectConfig(projectDir);

    if (!hasArg(args, "--skip-hooks")) {
        autoRegisterHooks(projectDir);
    }

    console.log(`${ROOT_COLORS.green}✓${ROOT_COLORS.reset} logbook initialized in: ${ROOT_COLORS.yellow}${projectDir}${ROOT_COLORS.reset}`);
    console.log(`${ROOT_COLORS.cyan}  MCP entry:${ROOT_COLORS.reset} ${path.relative(process.cwd(), projectDir) || "."}/.mcp.json`);
}

async function main() {
    const args = process.argv.slice(2);
    const first = args[0];

    if (!first) {
        await runServer([]);
        return;
    }

    const command = first.toLowerCase();
    if (command === "--help" || command === "-h" || command === "help") {
        commandHelp();
        return;
    }

    if (command === "init") {
        await runInit(args.slice(1));
        return;
    }

    if (command.startsWith("-")) {
        commandHelp();
        return;
    }

    // Fallback: treat all args as server positional args.
    await runServer(args);
}

main().catch((err) => {
    console.error(`${ROOT_COLORS.yellow}[logbook]${ROOT_COLORS.reset}`, err);
    process.exit(1);
});
