# 📓 logbook

> **Persistent memory + surgical patch engine + real-time context HUD for Claude Code.**  
> One command to install. Zero config. Everything stays local.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-green.svg)](https://modelcontextprotocol.io/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-orange.svg)](https://code.claude.com/)
[![Status: WIP](https://img.shields.io/badge/Status-Work%20In%20Progress-red.svg)]()

---

## The problem

Every Claude Code session starts from zero. Four hours of debugging, three architectural decisions, fifteen "why we didn't use X" moments — gone the second you close the terminal. Meanwhile, the context window silently degrades past 147K tokens while you keep sending prompts into a model that's already starting to hallucinate. And when Claude *does* edit your code, it rewrites entire files when only 3 lines needed to change.

**logbook fixes all three.**

---

## Install

```bash
claude mcp add logbook -- npx logbook-cc
```

That's it. On first connection, logbook registers its own background hooks and starts protecting your sessions automatically. No JSON to edit. No paths to configure.

### Verify

Open any Claude Code session and check your statusline:

```
[logbook] ctx: 12% | risk: LOW | tools: 7 | memory: active
```

---

## How it works

logbook is a **single MCP server** that registers itself as a Claude Code plugin. Internally it uses two mechanisms — one visible to Claude, one invisible:

```
┌─────────────────────────────────────────────────────────────────┐
│  claude mcp add logbook -- npx logbook-cc                       │
│  (one command — this is all the user ever runs)                 │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
          ┌──────────────────────────┐
          │      MCP Server          │  ← Claude calls these tools
          │                          │    when it needs them
          │  • memory_search         │
          │  • memory_save           │
          │  • patch_apply           │
          │  • context_status        │
          │  • memory_recall         │
          │  • memory_delete         │
          │  • memory_stats          │
          └──────────┬───────────────┘
                     │ on first connection, auto-registers:
                     ▼
          ┌──────────────────────────┐
          │   Claude Code Hooks      │  ← runs silently in background
          │   (internal, invisible)  │    user never touches these
          │                          │
          │  Stop       → save session state
          │  PreCompact → snapshot before compaction
          │  SessionEnd → finalize memory + update CLAUDE.md
          └──────────────────────────┘
```

The MCP layer handles what Claude actively requests. The hook layer handles everything that needs to happen passively — capturing context, feeding the HUD, updating memory. The user only ever sees the `claude mcp add` line.

---

## What it does

### 🧠 Memory Layer — no more amnesia

- Persists every session: prompts, outputs, decisions, diffs, test results
- Hybrid retrieval: token + tag matching over local session memory with recency/confidence scoring
- Auto-injects relevant past context into new sessions via CLAUDE.md
- Immutable versioning — rewind to any previous state, branch from any point
- Two tiers: Tier 1 compact briefing (~150 lines in CLAUDE.md), Tier 2 full store queried on demand

### 📊 Context HUD — know before you crash

Real-time overlay showing:

| Metric | Why it matters |
|--------|---------------|
| `ctx%` — current usage | Quality degrades at ~147K tokens, not the advertised 200K |
| `risk` — hallucination risk estimate | Based on context saturation + repetition patterns |
| `tools` — active MCP schemas | Each MCP server costs 2K–17K tokens before you type anything |
| `compact ETA` — when auto-compact will fire | Avoid being interrupted 90% through a task |

Works in terminal and auto-adjusts formatting for VSCode-aware environments. No configuration is needed for either path.

### 🔧 Patch Engine — surgical edits only

Instead of rewriting entire files:

1. **Parse** with language-aware symbol extraction (regex-first fallback; tree-sitter integration is planned)
2. **Plan** the minimal change — only the functions/nodes that actually need to change
3. **Apply** a surgical diff — 3 lines changed, not 300
4. **Generate** regression tests for patched symbols (when requested)
5. **Verify** no collateral damage before the edit lands

---

## Architecture

```
logbook/
├── src/
│   ├── server.ts             # MCP server entry — tools, resources, prompts
│   ├── setup.ts              # Auto-registers hooks on first connection
│   ├── memory/
│   │   ├── store.ts          # Local session-memory store + retrieval + consolidation
│   │   ├── hooks.ts          # Stop / PreCompact / SessionEnd handlers
│   │   └── inject.ts         # CLAUDE.md auto-update (<!-- logbook --> block)
│   ├── hud/
│   │   ├── monitor.ts        # Context window tracker
│   │   ├── risk.ts           # Hallucination risk scorer
│   │   └── overlay.ts        # Terminal statusline + environment-aware formatting
│   └── patch/
│       ├── parser.ts         # Language-aware symbol extraction (regex-first parser)
│       ├── planner.ts        # Minimal diff planner (Myers algorithm)
│       ├── applier.ts        # Surgical patch applier
│       └── testgen.ts        # Auto regression test generator
├── CLAUDE.md                 # (auto-generated) — logbook manages this block
├── package.json
└── README.md
```

---

## Roadmap

### v0.1 — MVP (Weeks 1–2)
- [x] Repo scaffold
- [x] MCP server with `memory_search`, `memory_save`, `context_status`, `memory_recall`, `memory_delete`, `memory_stats`, and `patch_apply` tools
- [x] Auto-register hooks on first connection (`setup.ts`)
- [x] Memory store + two-tier CLAUDE.md inject
- [x] Context HUD (terminal statusline)

### v0.2 — Patch Engine (Week 3)
- [ ] tree-sitter multi-language parser
- [ ] Minimal diff planner
- [ ] Surgical applier
- [ ] Regression test generator (Jest / pytest / go test)

### v0.3 — Polish
- [ ] VSCode status bar extension
- [ ] Context quality score (not just percentage)
- [ ] Configurable memory scopes (project / user / org)
- [ ] `npx logbook-cc` published to npm

### v1.0 — Stable
- [ ] Rust core (memory store + patch engine)
- [ ] Python + JS bindings
- [ ] Published open spec — other orchestrators can implement logbook-compatible memory

---

## FAQ

**Q: Does this work with Claude.ai web, not just Claude Code?**  
Not yet. The hook system and context polling depend on Claude Code CLI. Web support is on the roadmap.

**Q: Does it send my code anywhere?**  
No. Everything stays local. Logbook persists only local `.logbook` state files and updates `CLAUDE.md` in the current workspace. The MCP server makes no external network calls.

**Q: Will this conflict with my existing CLAUDE.md?**  
No. logbook writes inside a clearly delimited block (`<!-- logbook:start -->` / `<!-- logbook:end -->`). Your manual content is never modified.

**Q: What if I already have other hooks configured?**  
logbook appends to the existing hooks array — it never overwrites. If you already have a `Stop` hook, both run.

**Q: Why TypeScript first, not Rust?**  
Speed to MVP. The current stack is built in TypeScript for fast iteration, and the Claude Code MCP SDK has first-class TypeScript support. Rust core is planned for v1.0 once the API is stable.

---

## Contributing

This is Week-1 software. PRs are welcome, especially:

- Language grammars for the patch engine (tree-sitter bindings)
- HUD backends (Neovim, Emacs, JetBrains)
- Memory retrieval strategies
- Regression test templates per language

Open an issue before starting anything large.

---

## License

MIT — see [LICENSE](LICENSE).

---

---

# 🙏 Credits

logbook is built directly on the work of several open-source projects. The contributions listed below are **foundational, not incidental** — without them, this project would not exist in its current form.

---

### 🧠 [`yuvalsuede/memory-mcp`](https://github.com/yuvalsuede/memory-mcp)

> **Primary source — Memory Layer architecture**

The session hook design, the two-tier CLAUDE.md injection pattern (compact briefing in Tier 1, full store queried on demand in Tier 2), and the `Stop` / `PreCompact` / `SessionEnd` wiring in `src/memory/hooks.ts` are directly derived from `memory-mcp`.

The core insight this project introduced — *"Claude Code already reads CLAUDE.md on every session start; hooks capture knowledge; CLAUDE.md delivers it"* — is the architectural backbone of logbook's memory layer.

```
Files directly derived:
  src/memory/hooks.ts     (~70% derived)
  src/memory/inject.ts    (~60% derived)
```

**License:** MIT · **Author:** Yuval Suede  
**Repo:** https://github.com/yuvalsuede/memory-mcp

---

### 🗄️ [`nicholaspsmith/lance-context`](https://github.com/nicholaspsmith/lance-context) + [LanceDB](https://github.com/lancedb/lancedb)

> **Primary source — Persistent storage stack**

`src/memory/store.ts` is inspired by Lance Context’s architecture and was adapted to a minimal local-first store for this project. The design goal remains the same: treat memory as a versioned project store with dedupe, confidence scoring, and consolidation behavior that can be rewound or branched.

```
Files directly derived:
  src/memory/store.ts     (~65% derived from lance-context patterns)
```

**License:** MIT  
**Author:** Nicholas P. Smith (lance-context)  
**Repo:** https://github.com/nicholaspsmith/lance-context

---

### 🔧 [`ComposioHQ/agent-orchestrator`](https://github.com/ComposioHQ/agent-orchestrator)

> **Partial source — Patch Engine diff logic**

The worktree isolation model and the approach for determining *which* files belong to a given change informed logbook's patch planner design. The `reactions` config pattern — routing CI failure signals back to the agent that caused them — is the direct precedent for how logbook's patch engine handles verification failures.

```
Files inspired by (not direct copies):
  src/patch/applier.ts    (~40% inspired by reactions pattern)
  src/patch/planner.ts    (file-scoping design pattern)
```

**License:** MIT · **Author:** ComposioHQ  
**Repo:** https://github.com/ComposioHQ/agent-orchestrator

---

### 🌳 [tree-sitter](https://github.com/tree-sitter/tree-sitter) community

> **Foundational dependency and roadmap target — the Patch Engine**

tree-sitter is the intended parser backend for true AST-level surgical editing and stable node IDs. The current implementation ships a regex-based parser first to keep the patch engine fully functional without external grammar setup, with tree-sitter migration planned in a future release.

**License:** MIT · **Original author:** Max Brunsfeld  
**Maintained by:** The tree-sitter open-source community  
**Repo:** https://github.com/tree-sitter/tree-sitter  
**Website:** https://tree-sitter.github.io

---

### Additional acknowledgements

| Project | What we learned |
|---------|----------------|
| [`thedotmack/claude-mem`](https://github.com/thedotmack/claude-mem) | Timeline UI and observation pipeline — studied, not copied (AGPL-3.0) |
| [`nwiizo/ccswarm`](https://github.com/nwiizo/ccswarm) | Rust-native multi-agent architecture patterns |
| [`cognee`](https://github.com/topoteretes/cognee) | LanceDB + SQLite + graph tri-store design — studied, not copied |
| [`hesreallyhim/awesome-claude-code`](https://github.com/hesreallyhim/awesome-claude-code) | Ecosystem map — essential for understanding the gap logbook fills |
| Anthropic [Claude Code docs](https://code.claude.com/docs) | Hook system spec, CLAUDE.md format, Tool Search, auto-memory design |

---

*If you are one of the authors listed above and believe something was misattributed or used incorrectly, please open an issue. We take attribution seriously.*
