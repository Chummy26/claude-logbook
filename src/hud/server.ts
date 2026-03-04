/**
 * server.ts — Local HUD web server for logbook.
 *
 * Exposes a tiny localhost dashboard so operators can inspect:
 * - context snapshot (% and token estimates)
 * - risk score and contributing factors
 * - memory health counts
 * - current compact ETA
 *
 * Runs optional side-by-side with MCP stdio transport.
 */

import * as http from "node:http";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import { URL } from "node:url";
import { getContextSnapshot } from "./monitor.js";
import { assessRisk } from "./risk.js";
import { buildHudMetrics, renderStatusLine } from "./overlay.js";
import type { MemoryStore } from "../memory/store.js";

export interface HudServerConfig {
    projectDir: string;
    store: MemoryStore;
    port?: number;
    host?: string;
    mcpToolCount?: number;
}

export interface HudServerInstance {
    host: string;
    port: number;
    close: () => Promise<void>;
}

let activeServer: http.Server | null = null;

const DEFAULT_HUD_HOST = "127.0.0.1";

function getHudHost(): string {
    return process.env.LOGBOOK_HUD_HOST || DEFAULT_HUD_HOST;
}

function getHudPort(): number {
    const raw = process.env.LOGBOOK_HUD_PORT;
    if (!raw) return 0;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65_535) {
        return 0;
    }

    return parsed;
}

function isHudEnabled(): boolean {
    const disabled = process.env.LOGBOOK_HUD_DISABLED?.trim().toLowerCase();
    return !(disabled === "1" || disabled === "true");
}

function getVersion(): string {
    try {
        const packagePath = path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            "../../package.json"
        );
        if (fs.existsSync(packagePath)) {
            const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
            return pkg.version || "0.0.0";
        }
    } catch {
        // ignore
    }

    return "0.0.0";
}

function buildStatusPayload(projectDir: string, store: MemoryStore) {
    const snapshot = getContextSnapshot(projectDir);
    const risk = assessRisk(snapshot, store);
    const metrics = buildHudMetrics(snapshot, risk, store);
    const counts = store.getAllMemoryCount();
    const state = store.getState();

    return {
        version: getVersion(),
        generatedAt: new Date().toISOString(),
        project: {
            path: projectDir,
            name: path.basename(projectDir),
        },
        snapshot,
        risk,
        metrics,
        memory: {
            active: counts.active,
            archived: counts.archived,
            superseded: counts.superseded,
            total: counts.total,
        },
        hooks: {
            projectInitialized: fs.existsSync(path.join(projectDir, ".logbook")),
            mcpJson: fs.existsSync(path.join(projectDir, ".mcp.json")),
            lastUpdated: state.lastUpdated,
        },
        statusLine: renderStatusLine(metrics),
    };
}

function renderHudPage(data: ReturnType<typeof buildStatusPayload>): string {
    const status = data.statusLine;

    const safe = (value: unknown) =>
        String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>logbook HUD</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, system-ui, Arial, sans-serif;
        background: #0c1021;
        color: #f5f7ff;
      }
      body {
        margin: 0;
        padding: 2rem;
      }
      .container {
        max-width: 860px;
        margin: 0 auto;
      }
      h1 {
        margin: 0 0 1rem;
        letter-spacing: 0.02em;
      }
      .subtitle {
        color: #aab2d0;
        margin-bottom: 1.5rem;
      }
      .card {
        background: #131a31;
        border: 1px solid #2f3a66;
        border-radius: 10px;
        padding: 1rem;
        margin-bottom: 1rem;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: 0.75rem;
      }
      .metric {
        background: #0f1730;
        border: 1px solid #26345e;
        border-radius: 8px;
        padding: 0.7rem;
      }
      .metric .label {
        color: #7f8bb7;
        font-size: 0.9rem;
      }
      .metric .value {
        margin-top: 0.35rem;
        font-size: 1.2rem;
        font-weight: 600;
      }
      .status {
        font-family: "Courier New", monospace;
        font-size: 0.9rem;
        white-space: pre;
        background: #080e1f;
        border: 1px solid #243061;
        border-radius: 8px;
        padding: 0.7rem;
      }
      .footer {
        font-size: 0.82rem;
        color: #8b93b3;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>logbook HUD (localhost)</h1>
      <div class="subtitle">${safe(data.project.name)} · ${safe(data.project.path)}</div>

      <div class="card">
        <div class="status">${safe(status)}</div>
      </div>

      <div class="grid">
        <div class="metric">
          <div class="label">Context</div>
          <div class="value">${safe(data.snapshot.usagePercent)}% (${safe(data.snapshot.totalTokens)} / ${safe(data.snapshot.maxTokens)})</div>
        </div>
        <div class="metric">
          <div class="label">Risk</div>
          <div class="value">${safe(data.risk.level)} (${safe(data.risk.score)})</div>
        </div>
        <div class="metric">
          <div class="label">Tools</div>
          <div class="value">${safe(data.metrics.activeTools)}</div>
        </div>
        <div class="metric">
          <div class="label">Memory</div>
          <div class="value">${safe(data.memory.active)} active / ${safe(data.memory.total)} total</div>
        </div>
      </div>

      <div class="card" style="margin-top:1rem;">
        <div><strong>Risk factors</strong></div>
        <div class="status">${data.risk.factors
            .map((f) => `• ${safe(f.name)}: ${safe(f.description)}`)
            .join("\n")}
        </div>
      </div>

      <div class="footer">version ${safe(data.version)} · updated ${safe(data.generatedAt)}</div>
    </div>
    <script>
      async function refreshHud() {
        const r = await fetch('/api/status');
        const data = await r.json();
        const statusLine = document.querySelector('.status');
        statusLine.textContent = data.statusLine;
      }
      setInterval(refreshHud, 3000);
    </script>
  </body>
</html>`;
}

/**
 * Start the HUD server on localhost.
 */
export async function startHudServer(
    config: HudServerConfig
): Promise<HudServerInstance | null> {
    if (!isHudEnabled()) return null;
    if (activeServer) {
        // already running
        const address = activeServer.address();
        if (typeof address === "object" && address?.port) {
            return {
                host: getHudHost(),
                port: address.port,
                close: async () => stopHudServer(),
            };
        }
        return null;
    }

    const host = config.host || getHudHost();
    const port = config.port ?? getHudPort();
    const store = config.store;

    const server = http.createServer((req, res) => {
        try {
            const parsed = new URL(req.url || "/", `http://${host}`);
            const projectDir = path.resolve(config.projectDir);

            if (parsed.pathname === "/" || parsed.pathname === "/index.html") {
                const payload = buildStatusPayload(projectDir, store);
                const html = renderHudPage(payload);
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(html);
                return;
            }

            if (parsed.pathname === "/api/status") {
                const payload = buildStatusPayload(projectDir, store);
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(payload));
                return;
            }

            if (parsed.pathname === "/api/health") {
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: true }));
                return;
            }

            if (parsed.pathname === "/api/statusline") {
                const payload = buildStatusPayload(projectDir, store);
                res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
                res.end(payload.statusLine);
                return;
            }

            res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "not_found" }));
        } catch {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "hud_internal_error" }));
        }
    });

    const startedPort = await new Promise<number>((resolve, reject) => {
        const onError = (err: unknown) => {
            activeServer = null;
            reject(err);
        };
        server.once("error", onError);
        server.listen(port, host, () => {
            server.off("error", onError);
            const address = server.address();
            if (typeof address === "object" && address !== null) {
                resolve(address.port);
            } else {
                resolve(port || 0);
            }
        });
    });
    activeServer = server;

    return {
        host,
        port: startedPort,
        close: async () => stopHudServer(),
    };
}

/**
 * Stop any running HUD server and release the port.
 */
export async function stopHudServer(): Promise<void> {
    if (!activeServer) return;

    await new Promise<void>((resolve) => {
        activeServer!.close(() => {
            resolve();
        });
    });

    activeServer = null;
}

/**
 * Return a resolved HUD listener URL when available.
 */
export function getHudUrl(): string | null {
    if (!activeServer) return null;

    const address = activeServer.address();
    if (!address || typeof address === "string") return null;

    return `http://${getHudHost()}:${address.port}`;
}
