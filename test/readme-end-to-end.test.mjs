import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readFile,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { MemoryStore } from '../dist/memory/store.js';
import { syncClaudeMd, getMemoryBlock, estimateBlockTokens } from '../dist/memory/inject.js';
import { parseFile, detectLanguage } from '../dist/patch/parser.js';
import { planPatch, formatPatchPlan } from '../dist/patch/planner.js';
import { applyPatch, previewPatch } from '../dist/patch/applier.js';
import { generateTests, getTestCommand } from '../dist/patch/testgen.js';
import { getContextSnapshot } from '../dist/hud/monitor.js';
import { assessRisk } from '../dist/hud/risk.js';
import {
  buildHudMetrics,
  renderStatusLine,
  renderDetailedHud,
} from '../dist/hud/overlay.js';
import { autoRegisterHooks, areHooksRegistered, removeHooks } from '../dist/setup.js';
import { heuristicExtract } from '../dist/memory/hooks.js';
import { startHudServer, stopHudServer } from '../dist/hud/server.js';

function withTempProject() {
  const root = mkdtempSync(join(tmpdir(), 'logbook-e2e-'));
  const reset = () => rmSync(root, { recursive: true, force: true });
  return { root, reset };
}

function containsLogbookHook(entries) {
  return Array.isArray(entries) && entries.some((entry) =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => {
      if (!h || typeof h !== 'object' || typeof h.command !== 'string') return false;
      return h.command.includes('hooks.js');
    })
  );
}

async function fetchText(url) {
  const response = await fetch(url);
  return { response, text: await response.text() };
}

async function fetchJson(url) {
  const response = await fetch(url);
  return { response, json: await response.json() };
}

test('package wiring points to compiled server entry', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'));
  assert.equal(pkg.bin['logbook-cc'], './dist/cli.js');
  assert.equal(pkg.main, 'dist/server.js');
  assert.equal(pkg.scripts['mcp:init'], 'npm run build && node dist/cli.js init .');
  assert.equal(
    pkg.scripts.test,
    'npm run build && node --test test/readme-end-to-end.test.mjs'
  );
});

test('plugin metadata is present and runnable in plugin mode', () => {
  const marketplace = JSON.parse(readFileSync(resolve('.claude-plugin/marketplace.json'), 'utf-8'));
  const pluginManifest = JSON.parse(readFileSync(resolve('.claude-plugin/plugin.json'), 'utf-8'));
  const pluginMcp = JSON.parse(readFileSync(resolve('.mcp.json'), 'utf-8'));
  const pluginHooks = JSON.parse(readFileSync(resolve('.claude-plugin/hooks.json'), 'utf-8'));

  assert.ok(Array.isArray(marketplace.plugins));
  assert.ok(marketplace.plugins.length > 0, 'Marketplace should list plugins');
  assert.equal(marketplace.plugins[0].name, 'logbook');
  assert.equal(marketplace.plugins[0].source, '.');

  assert.equal(pluginManifest.name, 'logbook');

  assert.equal(pluginMcp.mcpServers?.logbook?.command, 'node');
  assert.ok(Array.isArray(pluginMcp.mcpServers?.logbook?.args));
  assert.equal(pluginMcp.mcpServers.logbook.args[0], '${CLAUDE_PLUGIN_ROOT}/dist/cli.js');
  assert.equal(pluginMcp.mcpServers.logbook.args[1], '${CLAUDE_PROJECT_DIR}');

  assert.ok(Array.isArray(pluginHooks.Stop));
  assert.ok(containsLogbookHook(pluginHooks.Stop));
  assert.ok(containsLogbookHook(pluginHooks.PreCompact));
  assert.ok(containsLogbookHook(pluginHooks.SessionEnd));
});

test('README install section documents plugin-first setup', () => {
  const readme = readFileSync(resolve('README.md'), 'utf-8');
  assert.ok(readme.includes('/plugin marketplace add Chummy26/claude-logbook'));
  assert.ok(readme.includes('/plugin install logbook'));
  assert.equal(readme.includes('npx logbook-cc'), false);
});

test('logbook CLI can initialize project MCP configuration', () => {
  const { root, reset } = withTempProject();
  try {
    const cliPath = resolve('dist/cli.js');
    const serverPath = resolve('dist/server.js');

    const output = execFileSync(process.execPath, [cliPath, 'init', root], {
      encoding: 'utf-8',
    });
    assert.ok(output.includes('logbook initialized in'));

    const mcpPath = join(root, '.mcp.json');
    assert.ok(existsSync(mcpPath), 'Expected .mcp.json to be created');

    const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    assert.equal(mcp.mcpServers?.logbook?.command, 'node');
    assert.equal(resolve(mcp.mcpServers.logbook.args[0]), serverPath);
    assert.equal(resolve(mcp.mcpServers.logbook.args[1]), root);
  } finally {
    reset();
  }
});

test('memory persistence + CLAUDE.md injection produces stable block', () => {
  const { root, reset } = withTempProject();
  try {
    const store = new MemoryStore(root);

    const first = store.addMemory({
      type: 'decision',
      content: 'Use regex extraction for patch planning until tree-sitter lands.',
      tags: ['bootstrap'],
    });
    const second = store.addMemory({
      type: 'progress',
      content: 'Added e2e coverage for README-contract alignment.',
      tags: ['testing'],
    });
    assert.ok(first);
    assert.ok(second);

    syncClaudeMd(root, store);

    const block = getMemoryBlock(root);
    assert.ok(block, 'CLAUDE.md block exists');
    assert.ok(block.includes('Current Progress'));

    const claudePath = join(root, 'CLAUDE.md');
    const before = readFileSync(claudePath, 'utf-8');
    syncClaudeMd(root, store);
    const after = readFileSync(claudePath, 'utf-8');

    assert.equal(after.split('<!-- logbook:start -->').length, 2);
    assert.equal(after.split('<!-- logbook:end -->').length, 2);

    const results = store.searchMemories('regex parsing', 10);
    assert.equal(results.length, 1);
    assert.equal(results[0].type, 'decision');

    assert.ok(estimateBlockTokens(root) > 0);
    assert.ok(before.length > 0);
  } finally {
    reset();
  }
});

test('patch parser supports language detection and unknown extension behavior', () => {
  const { root, reset } = withTempProject();
  try {
    const tsFile = join(root, 'sample.ts');
    const mdFile = join(root, 'note.md');
    const pyFile = join(root, 'script.py');

    writeFileSync(tsFile, 'export function f() { return 1 }', 'utf-8');
    writeFileSync(pyFile, 'def f():\n    return 1', 'utf-8');
    writeFileSync(mdFile, 'just text', 'utf-8');

    assert.equal(detectLanguage(tsFile), 'typescript');
    assert.equal(detectLanguage(pyFile), 'python');
    assert.equal(detectLanguage(mdFile), null);

    assert.equal(parseFile(tsFile).length, 1);
    assert.equal(parseFile(mdFile).length, 0);
  } finally {
    reset();
  }
});

test('patch engine plans, previews, applies, and supports raw targets', () => {
  const { root, reset } = withTempProject();
  try {
    const targetPath = join(root, 'patch_target.ts');
    const oldContent = [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
    ].join('\n');

    const newContent = [
      'export function add(a: number, b: number): number {',
      '  const sum = a + b;',
      '  return sum;',
      '}',
      '',
    ].join('\n');

    writeFileSync(targetPath, oldContent, 'utf-8');
    const plan = planPatch(targetPath, oldContent, newContent, 'Track additive sum variable');
    assert.equal(plan.targets.length, 1);
    assert.equal(detectLanguage(targetPath), 'typescript');
    assert.equal(parseFile(targetPath).length, 1);
    assert.ok(formatPatchPlan(plan).includes('Patch Plan'));

    const preview = previewPatch(plan);
    assert.ok(preview?.includes('const sum'));

    const result = applyPatch(plan);
    assert.ok(result.success);
    assert.equal(typeof result.changedLines, 'number');

    const after = readFileSync(targetPath, 'utf-8');
    assert.ok(after.includes('const sum'));

    const tests = generateTests(plan);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].filePath, join(root, 'patch_target.test.ts'));
    assert.ok(tests[0].content.includes("describe('add'"));
    assert.equal(getTestCommand('typescript'), 'npx jest --passWithNoTests');

    const unsupportedPath = join(root, 'note.txt');
    writeFileSync(unsupportedPath, 'hello\nworld', 'utf-8');
    const rawPlan = planPatch(unsupportedPath, 'hello\nworld', 'hello\nthere', 'Update raw line');
    assert.equal(rawPlan.targets.length, 1);
    assert.equal(rawPlan.targets[0].nodeType, 'raw');

    const rawResult = applyPatch(rawPlan);
    assert.ok(rawResult.success);
    assert.ok(readFileSync(unsupportedPath, 'utf-8').includes('there'));
  } finally {
    reset();
  }
});

test('patch apply fails cleanly when plan is stale', () => {
  const { root, reset } = withTempProject();
  try {
    const targetPath = join(root, 'stale.ts');
    const oldContent = 'export function value() {\n  return 1;\n}\n';
    const newContent = 'export function value() {\n  return 2;\n}\n';

    writeFileSync(targetPath, oldContent, 'utf-8');

    const plan = planPatch(targetPath, oldContent, newContent, 'Change return constant');

    // modify file before applying to create a stale plan
    writeFileSync(targetPath, 'export function value() {\n  return 0;\n}\n', 'utf-8');

    const result = applyPatch(plan);
    assert.equal(result.success, false);
    assert.ok(result.targets.some((t) => !t.applied));
    assert.ok(readFileSync(targetPath, 'utf-8').includes('return 0'));
  } finally {
    reset();
  }
});

test('generateTests supports language-specific templates', () => {
  const { root, reset } = withTempProject();
  try {
    const py = join(root, 'worker.py');
    const go = join(root, 'worker.go');
    const rust = join(root, 'worker.rs');

    writeFileSync(
      py,
      'def process(x):\n    return x * 2\n',
      'utf-8'
    );
    writeFileSync(
      go,
      'package main\n\nfunc compute(x int) int {\n\treturn x * 2\n}\n',
      'utf-8'
    );
    writeFileSync(
      rust,
      'pub fn compute(x: i32) -> i32 {\n    x * 2\n}\n',
      'utf-8'
    );

    const pyPlan = planPatch(py, readFileSync(py, 'utf-8'), 'def process(x):\n    return x + 3\n', 'Adjust process');
    const goPlan = planPatch(go, readFileSync(go, 'utf-8'), 'package main\n\nfunc compute(x int) int {\n\treturn x + 3\n}\n', 'Adjust compute');
    const rustPlan = planPatch(rust, readFileSync(rust, 'utf-8'), 'pub fn compute(x: i32) -> i32 {\n    x + 3\n}\n', 'Adjust compute');

    const pyTests = generateTests(pyPlan);
    const goTests = generateTests(goPlan);
    const rustTests = generateTests(rustPlan);

    assert.equal(getTestCommand('python'), 'python -m pytest -x');
    assert.equal(getTestCommand('go'), 'go test ./...');
    assert.equal(getTestCommand('rust'), 'cargo test');

    assert.equal(pyTests.length, 1);
    assert.equal(pyTests[0].filePath.endsWith('test_worker.py'), true);
    assert.ok(pyTests[0].content.includes('regression'));

    assert.equal(goTests.length, 1);
    assert.equal(goTests[0].filePath.endsWith('worker_test.go'), true);
    assert.ok(goTests[0].content.includes('TestCompute'));

    assert.equal(rustTests.length, 1);
    assert.equal(rustTests[0].filePath.endsWith('worker_test.rs'), true);
  } finally {
    reset();
  }
});

test('context and risk pipeline returns HUD-like output', () => {
  const { root, reset } = withTempProject();
  try {
    const store = new MemoryStore(root);
    store.addMemory({
      type: 'progress',
      content: 'Tracked end-to-end verification for documentation contracts.',
      tags: ['status'],
    });

    const snapshot = getContextSnapshot(root, 120);
    assert.ok(snapshot.totalTokens >= 0);

    const risk = assessRisk(snapshot, store);
    assert.ok(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(risk.level));

    const metrics = buildHudMetrics(snapshot, risk, store, 7);
    const line = renderStatusLine(metrics);
    const detailed = renderDetailedHud(metrics, snapshot, risk);

    assert.ok(line.includes('[logbook]'));
    assert.ok(line.includes('ctx:'));
    assert.ok(line.includes('tools: 7'));
    assert.ok(detailed.includes('logbook HUD'));
  } finally {
    reset();
  }
});

test('hook installer is idempotent and cleanly removable', () => {
  const { root, reset } = withTempProject();
  try {
    const settingsPath = join(root, '.claude', 'settings.json');

    assert.equal(areHooksRegistered(root), false);
    autoRegisterHooks(root);
    assert.equal(areHooksRegistered(root), true);

    const firstSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.ok(containsLogbookHook(firstSettings.hooks?.Stop));
    assert.ok(containsLogbookHook(firstSettings.hooks?.PreCompact));
    assert.ok(containsLogbookHook(firstSettings.hooks?.SessionEnd));

    autoRegisterHooks(root);
    const secondSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.equal(
      JSON.stringify(firstSettings.hooks?.Stop),
      JSON.stringify(secondSettings.hooks?.Stop),
    );

    removeHooks(root);
    const removed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.ok(!containsLogbookHook(removed.hooks?.Stop));
    assert.equal(areHooksRegistered(root), false);
  } finally {
    reset();
  }
});

test('heuristic extraction emits memory suggestions from transcript-like text', () => {
  const extracted = heuristicExtract('USER: we decided to choose regex parsing for now', []);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].type, 'decision');
  assert.ok(extracted[0].content.includes('decided to choose regex parsing for now'));
});

test('HUD localhost exposes machine-readable and browser endpoints', async () => {
  const { root, reset } = withTempProject();
  try {
    const store = new MemoryStore(root);
    store.addMemory({
      type: 'progress',
      content: 'HUD endpoint smoke test: local monitoring available.',
      tags: ['hud'],
    });

    const server = await startHudServer({
      projectDir: root,
      store,
      host: '127.0.0.1',
      port: 0,
    });
    assert.ok(server, 'HUD server should start');

    if (!server) return;
    const base = `http://${server.host}:${server.port}`;

    const health = await fetchJson(`${base}/api/health`);
    assert.equal(health.response.status, 200);

    const api = await fetchJson(`${base}/api/status`);
    assert.equal(api.response.status, 200);
    assert.equal(api.json.project.name, resolve(root).split(/\\/).pop());
    assert.ok(api.json.snapshot.totalTokens >= 0);
    assert.ok(api.json.risk.factors?.length >= 1);

    const page = await fetchText(base);
    assert.equal(page.response.status, 200);
    assert.ok(page.text.includes('logbook HUD (localhost)'));

    await server.close();
  } finally {
    await stopHudServer();
    reset();
  }
});

test('README architecture references correspond to implementation files', () => {
  const readme = readFileSync(resolve('README.md'), 'utf-8');
  assert.ok(readme.includes('logbook/'));

  const expectedFiles = [
    '.claude-plugin/marketplace.json',
    '.claude-plugin/plugin.json',
    '.claude-plugin/hooks.json',
    '.mcp.json',
    'src/server.ts',
    'src/setup.ts',
    'src/memory/store.ts',
    'src/memory/hooks.ts',
    'src/memory/inject.ts',
    'src/hud/monitor.ts',
    'src/hud/risk.ts',
    'src/hud/overlay.ts',
    'src/hud/server.ts',
    'src/patch/parser.ts',
    'src/patch/planner.ts',
    'src/patch/applier.ts',
    'src/patch/testgen.ts',
    'test/readme-end-to-end.test.mjs',
  ];

  for (const file of expectedFiles) {
    assert.ok(existsSync(resolve(file)), `Missing file: ${file}`);
  }
});
