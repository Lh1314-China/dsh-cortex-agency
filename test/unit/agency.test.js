import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAgencyStore } from '../../src/store.js';
import { createAgencyEngine } from '../../src/engine.js';
import { evolveDrives, aboveThreshold, DEFAULT_DRIVES, driveGapMs } from '../../src/drives.js';

// Distinct on purpose: the similarity gate would refuse a repeated default.
const VARIED_TEXTS = [
  '海面很平，咱想把今天没说完的话再想一遍。',
  '今天把清单一条条核过，每条都有落处，不必再翻第二遍。',
  '联结像远处的灯，不用喊，知道有人在就够了。',
  '那条规则的边界还没摸清，明天得再看一眼。',
];

function fakeCortex({ texts = null, available = true, searchItems = [], selfSnapshot = null, traces = null } = {}) {
  const writes = [];
  const prompts = [];
  const systems = [];
  const searches = [];
  let calls = 0;
  const repos = Array.isArray(traces)
    ? { traces: { list: ({ limit } = {}) => traces.slice(0, Math.max(1, Number(limit) || traces.length)) } }
    : undefined;
  return {
    writes,
    prompts,
    systems,
    searches,
    repos,
    config: { persona: { selfName: '助手' } },
    self: () => selfSnapshot,
    llm: {
      available: () => available,
      complete: async (options) => {
        prompts.push(options?.prompt ?? '');
        systems.push(options?.system ?? '');
        const index = calls;
        calls += 1;
        if (Array.isArray(texts)) return texts[Math.min(index, texts.length - 1)];
        return VARIED_TEXTS[index % VARIED_TEXTS.length];
      },
    },
    write(input) {
      writes.push(input);
      return { trace: { id: `trc_${writes.length}` } };
    },
    search(query, options) {
      searches.push({ query, options });
      return { items: searchItems };
    },
  };
}

function setup(options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-agency-'));
  const store = openAgencyStore({ file: path.join(dir, 'agency.sqlite') });
  const cortex = fakeCortex(options);
  const engine = createAgencyEngine({
    cortex,
    store,
    config: {
      enabled: true,
      scope: 'agency',
      maxThoughtsPerDay: 3,
      minGapMinutes: 60,
      maxTokens: 200,
      // These tests jump hours ahead and rely on the old "fill everything"
      // behaviour; the catch-up cap has its own dedicated test.
      maxCatchUpMinutes: 24 * 60,
      ...options.config,
    },
    selfName: '助手',
  });
  return { dir, store, cortex, engine };
}

test('disabled engine does nothing', async () => {
  const { dir, store, cortex, engine } = setup({ config: { enabled: false } });
  try {
    const result = await engine.step({ at: Date.parse('2026-11-15T10:00:00Z'), idle: true });
    assert.equal(result.skipped, 'disabled');
    assert.equal(cortex.writes.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('active session blocks rumination', async () => {
  const { dir, store, engine } = setup();
  try {
    const result = await engine.step({ at: Date.parse('2026-11-15T10:00:00Z'), idle: false });
    assert.equal(result.skipped, 'active');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drives evolve with elapsed time', () => {
  const grown = evolveDrives(DEFAULT_DRIVES, 180);
  assert.ok(grown[0].potential > DEFAULT_DRIVES[0].potential);
  assert.ok(aboveThreshold(grown).length > 0);
});

test('an idle, pressured engine writes one thought into its own scope', async () => {
  const { dir, store, cortex, engine } = setup();
  try {
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at: t0, idle: true });
    const later = t0 + 3 * 60 * 60 * 1000;
    const result = await engine.step({ at: later, idle: true });
    assert.ok(result.created, `expected a thought, got ${JSON.stringify(result)}`);
    assert.equal(cortex.writes.length, 1);
    const write = cortex.writes[0];
    assert.equal(write.scopeId, 'agency');
    assert.equal(write.kind, 'reflection');
    assert.equal(write.source, 'agency:inner');
    assert.deepEqual(write.facts, []);
    assert.match(write.text, /^【内在沉思】/);
    assert.equal(store.stats().thoughts, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rumination is grounded in recent memories but writes only to its own scope', async () => {
  const { dir, store, cortex, engine } = setup({
    searchItems: [{ id: 'trc_mem_1', title: '用户的话', snippet: '助手会记住这件事。', layer: 'L2' }],
  });
  try {
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at: t0, idle: true });
    const result = await engine.step({ at: t0 + 3 * 60 * 60 * 1000, idle: true });
    assert.ok(result.created);
    assert.equal(result.memoryUsed, 1);
    assert.equal(cortex.searches.length, 1);
    assert.equal(cortex.searches[0].options.scopeId, 'global', 'reads the user scope');
    assert.match(cortex.prompts[0], /最近真实发生过/);
    assert.match(cortex.prompts[0], /记住这件事/);
    assert.equal(cortex.writes[0].scopeId, 'agency', 'writes only to the agency scope');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory grounding can be turned off', async () => {
  const { dir, store, cortex, engine } = setup({ config: { recallMemory: false } });
  try {
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at: t0, idle: true });
    const result = await engine.step({ at: t0 + 3 * 60 * 60 * 1000, idle: true });
    assert.ok(result.created);
    assert.equal(result.memoryUsed, 0);
    assert.equal(cortex.searches.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('alignment compares agency goals with cortex lists but never merges them', () => {
  const { dir, store, engine } = setup({
    selfSnapshot: {
      working: [{ text: '把鱼塘上限抬到 20' }],
      goals: [{ title: '写下一版 0.4.31' }],
    },
  });
  try {
    const at = '2026-11-15T08:00:00.000Z';
    store.addGoal({ id: 'g_align', drive: 'order', text: '把鱼塘上限抬到 20', priority: 0.8, at, expiresAt: '2026-11-16T08:00:00.000Z' });
    const result = engine.alignment();
    assert.equal(result.agencyGoals, 1);
    assert.equal(result.cortexItems, 2);
    assert.equal(result.matched.length, 1);
    assert.match(result.matched[0].cortex, /鱼塘上限/);
    assert.equal(result.onlyAgency.length, 0);
    assert.equal(result.onlyCortex.length, 1);
    assert.match(result.onlyCortex[0], /0\.4\.31/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drive spacing doubles per thought and caps', () => {
  assert.equal(driveGapMs(0, { minGapMs: 60_000 }), 60_000);
  assert.equal(driveGapMs(1, { minGapMs: 60_000 }), 120_000);
  assert.equal(driveGapMs(10, { minGapMs: 60_000, maxGapMs: 600_000 }), 600_000);
});

test('a drive that just spoke is cooling, and an all-cooling tick skips', async () => {
  const { dir, store, engine } = setup({ config: { maxThoughtsPerDay: 20, minGapMinutes: 60, globalGapMinutes: 1 } });
  try {
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at: t0, idle: true });
    const t1 = t0 + 4 * 60 * 60 * 1000;
    const first = await engine.step({ at: t1, idle: true });
    assert.ok(first.created);
    for (const id of ['curiosity', 'connection', 'order', 'expression']) {
      store.addThought({ id: `thg_${id}_t1`, at: new Date(t1).toISOString(), drive: id, text: '刚刚说过', source: 'agency:inner', llm: false });
    }
    const second = await engine.step({ at: t1 + 60_000, idle: true });
    assert.equal(second.skipped, 'cooldown');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daily budget and cooldown both hold', async () => {
  const { dir, store, cortex, engine } = setup({ config: { maxThoughtsPerDay: 1, minGapMinutes: 1 } });
  try {
    let at = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at, idle: true });
    at += 2 * 60 * 60 * 1000;
    const first = await engine.step({ at, idle: true });
    assert.ok(first.created);
    at += 2 * 60 * 60 * 1000;
    const second = await engine.step({ at, idle: true });
    assert.equal(second.skipped, 'daily-budget');
    assert.equal(cortex.writes.length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without an LLM the engine skips instead of inventing text', async () => {
  const { dir, store, cortex, engine } = setup({ available: false });
  try {
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at: t0, idle: true });
    const result = await engine.step({ at: t0 + 4 * 60 * 60 * 1000, idle: true });
    assert.equal(result.skipped, 'no-llm');
    assert.equal(cortex.writes.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a drive above threshold also gets one active goal', async () => {
  const { dir, store, engine } = setup();
  try {
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at: t0, idle: true });
    const result = await engine.step({ at: t0 + 4 * 60 * 60 * 1000, idle: true });
    assert.ok(Array.isArray(result.goals));
    assert.ok(result.goals.length >= 1);
    assert.equal(store.stats().goals, result.goals.length);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a global floor stops different drives from firing minute by minute', async () => {
  const { dir, store, cortex, engine } = setup({ config: { maxThoughtsPerDay: 20, minGapMinutes: 1, globalGapMinutes: 25 } });
  try {
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at: t0, idle: true });
    const t1 = t0 + 4 * 60 * 60 * 1000;
    const first = await engine.step({ at: t1, idle: true });
    assert.ok(first.created, `expected the first thought, got ${JSON.stringify(first)}`);

    // A different drive is still over threshold and has no per-drive cooldown,
    // but one minute later the global floor still refuses.
    const second = await engine.step({ at: t1 + 60_000, idle: true });
    assert.equal(second.skipped, 'global-cooldown');
    assert.equal(cortex.writes.length, 1);

    // Once the floor has passed it may speak again.
    const third = await engine.step({ at: t1 + 26 * 60_000, idle: true });
    assert.ok(third.created, `expected a thought after the global gap, got ${JSON.stringify(third)}`);
    assert.equal(cortex.writes.length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the prompt carries the local clock so it cannot invent "tonight"', async () => {
  const { dir, store, cortex, engine } = setup();
  try {
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at: t0, idle: true });
    await engine.step({ at: t0 + 4 * 60 * 60 * 1000, idle: true });
    const prompt = cortex.prompts[0];
    assert.match(prompt, /现在是 \d{4}-\d{2}-\d{2} 周[日一二三四五六] \d{2}:\d{2}（本地时间）/);
    assert.match(prompt, /别凭感觉说「今晚」/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the prompt tells it not to echo its own imagery', async () => {
  const { dir, store, cortex, engine } = setup({ config: { maxThoughtsPerDay: 10, minGapMinutes: 1, globalGapMinutes: 25 } });
  try {
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at: t0, idle: true });
    const t1 = t0 + 4 * 60 * 60 * 1000;
    await engine.step({ at: t1, idle: true });
    // The first thought has nothing to echo yet; the second one does.
    await engine.step({ at: t1 + 26 * 60_000, idle: true });
    assert.ok(cortex.prompts.length >= 2, `expected two completes, got ${cortex.prompts.length}`);
    assert.match(cortex.systems[0], /不要复用之前写过的比喻/);
    assert.match(cortex.prompts[1], /上次想过（只当参照，不要复用其中的比喻/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status reports both the per-drive and the global gap', () => {
  const { dir, store, engine } = setup({ config: { minGapMinutes: 60, globalGapMinutes: 25 } });
  try {
    const status = engine.status();
    assert.equal(status.budget.globalGapMinutes, 25);
    assert.equal(status.budget.minGapMinutes, 60);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a long silence cannot slam every drive to full in one tick', async () => {
  const { dir, store, cortex, engine } = setup({ config: { maxCatchUpMinutes: 30, maxThoughtsPerDay: 20 } });
  try {
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at: t0, idle: true });
    const result = await engine.step({ at: t0 + 24 * 60 * 60 * 1000, idle: true });
    const top = Math.max(...store.loadDrives().map((drive) => drive.potential));
    // 安定 starts at 0.25 and may grow by at most 30 * 0.005 = 0.15.
    assert.ok(top <= 0.41, `expected capped growth, got ${top}`);
    assert.equal(result.skipped, 'no-pressure');
    assert.equal(cortex.writes.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a thought that merely repeats the last one is refused, not written', async () => {
  const dup = '今晚很静，灯亮着，纸摊着就摊着，不急着收，坐着就好。';
  const { dir, store, cortex, engine } = setup({
    texts: [dup, dup, dup],
    config: { maxThoughtsPerDay: 10, globalGapMinutes: 1, minGapMinutes: 1 },
  });
  try {
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at: t0, idle: true });
    const t1 = t0 + 4 * 60 * 60 * 1000;
    const first = await engine.step({ at: t1, idle: true });
    assert.ok(first.created);
    const second = await engine.step({ at: t1 + 2 * 60_000, idle: true });
    assert.equal(second.skipped, 'repetitive');
    assert.equal(cortex.writes.length, 1);
    assert.equal(cortex.prompts.length, 3, 'one compose for the first thought, original + rewrite for the second');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a near-duplicate gets exactly one rewrite before it is accepted', async () => {
  const dup = '今晚很静，灯亮着，纸摊着就摊着，不急着收，坐着就好。';
  const fresh = '下午那份规则清单里第三条我还没吃透，明天得把它拆开看。';
  const { dir, store, cortex, engine } = setup({
    texts: [dup, dup, fresh],
    config: { maxThoughtsPerDay: 10, globalGapMinutes: 1, minGapMinutes: 1 },
  });
  try {
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at: t0, idle: true });
    const t1 = t0 + 4 * 60 * 60 * 1000;
    await engine.step({ at: t1, idle: true });
    const second = await engine.step({ at: t1 + 2 * 60_000, idle: true });
    assert.equal(second.created, fresh);
    assert.ok(second.similarity < 0.35, `similarity should drop, got ${second.similarity}`);
    assert.equal(cortex.writes.length, 2);
    assert.match(cortex.prompts[2], /上一版跟最近说过的话太像了/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rumination is anchored in recent real traces, not a keyword search', async () => {
  const traces = [
    { id: 'trc_a', kind: 'observation', title: '给 whale-sight 开耳朵', recordedAt: '2026-11-17T06:48:00.000Z' },
    { id: 'trc_b', kind: 'reflection', title: '不该充当事件的自省', recordedAt: '2026-11-17T06:50:00.000Z' },
    { id: 'trc_c', kind: 'utterance', title: '用户说不用每三分钟冒泡', recordedAt: '2026-11-17T07:10:00.000Z' },
  ];
  const { dir, store, cortex, engine } = setup({ traces });
  try {
    const t0 = Date.parse('2026-11-15T10:00:00Z');
    await engine.step({ at: t0, idle: true });
    const result = await engine.step({ at: t0 + 4 * 60 * 60 * 1000, idle: true });
    assert.ok(result.created);
    const prompt = cortex.prompts[0];
    assert.match(prompt, /最近真实发生过/);
    assert.match(prompt, /whale-sight/);
    assert.match(prompt, /不用每三分钟冒泡/);
    assert.doesNotMatch(prompt, /不该充当事件的自省/);
    assert.equal(result.memoryUsed, 2, 'reflections are filtered out of the anchors');
    assert.equal(cortex.searches.length, 0, 'recent traces replace the keyword search');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('status reports the similarity and catch-up guards', () => {
  const { dir, store, engine } = setup({ config: { similarityThreshold: 0.4, maxCatchUpMinutes: 20 } });
  try {
    const status = engine.status();
    assert.equal(status.guards.similarityThreshold, 0.4);
    assert.equal(status.guards.maxCatchUpMinutes, 20);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
