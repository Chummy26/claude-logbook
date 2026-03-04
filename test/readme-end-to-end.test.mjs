import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  mkdtempSync, 
  writeFileSync, 
  readFileSync, 
  existsSync, 
  rmSync,
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
import { buildHudMetrics, renderStatusLine, renderDetailedHud } from '../dist/hud/overlay.js';
import { autoRegisterHooks, areHooksRegistered, removeHooks } from '../dist/setup.js';
import { heuristicExtract } from '../dist/memory/hooks.js';

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

    // exactly one start marker and one end marker
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

test('patch pipeline plans, previews, applies, and generates tests', () => {
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
    assert.ok(plan.targets.length >= 1);
    assert.equal(detectLanguage(targetPath), 'typescript');
    assert.ok(parseFile(targetPath).length >= 1);
    assert.ok(formatPatchPlan(plan).includes('Patch Plan'));

    const preview = previewPatch(plan);
    assert.ok(preview?.includes('sum'));

    const result = applyPatch(plan);
    assert.ok(result.success);
    assert.equal(result.totalLines >= 4, true);

    const after = readFileSync(targetPath, 'utf-8');
    assert.ok(after.includes('const sum'));

    const tests = generateTests(plan);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].filePath, join(root, 'patch_target.test.ts'));
    assert.ok(tests[0].content.includes("describe('add'"));
    assert.equal(getTestCommand('typescript'), 'npx jest --passWithNoTests');
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
    const firstStop = JSON.parse(JSON.stringify(firstSettings.hooks?.Stop));
    assert.ok(containsLogbookHook(firstSettings.hooks?.Stop));
    assert.ok(containsLogbookHook(firstSettings.hooks?.PreCompact));
    assert.ok(containsLogbookHook(firstSettings.hooks?.SessionEnd));

    autoRegisterHooks(root);
    const secondSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.equal(JSON.stringify(firstStop), JSON.stringify(secondSettings.hooks?.Stop));

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

test('README architecture references correspond to implementation files', () => {
  const readme = readFileSync(resolve('README.md'), 'utf-8');
  assert.ok(readme.includes('logbook/'));

  const expectedFiles = [
    'src/server.ts',
    'src/setup.ts',
    'src/memory/store.ts',
    'src/memory/hooks.ts',
    'src/memory/inject.ts',
    'src/hud/monitor.ts',
    'src/hud/risk.ts',
    'src/hud/overlay.ts',
    'src/patch/parser.ts',
    'src/patch/planner.ts',
    'src/patch/applier.ts',
    'src/patch/testgen.ts',
  ];

  for (const file of expectedFiles) {
    assert.ok(existsSync(resolve(file)), `Missing file: ${file}`);
  }
});
