/**
 * dsh-cortex-agency — companion layer for dsh-cortex.
 *
 * Design rules, in order of importance:
 *   1. Off by default. Nothing runs until `enabled: true`.
 *   2. Driven by the host heartbeat (cortex.onTick). A fallback timer exists
 *      only for old hosts that do not publish tick hooks; it is unref'ed and
 *      cleared on dispose.
 *   3. Every write goes through cortex.write() into its own scope, with
 *      `facts: []` so inner monologue never becomes a user fact.
 *   4. It never sends messages, never writes outside its scope and never
 *      modifies the prompt.
 */
import os from 'node:os';
import path from 'node:path';
import { openAgencyStore } from './src/store.js';
import { createAgencyEngine } from './src/engine.js';

export const name = 'cortex-agency';
export const inject = ['cortex'];

let Schema = null;
try {
  const mod = await import('@deepseek-ai/schemastery');
  Schema = mod.default ?? mod;
} catch {
  Schema = null;
}

export const Config = Schema ? Schema.object({
  enabled: Schema.boolean().default(false).description('总开关；默认关闭，打开后才会有空闲沉思'),
  dataRoot: Schema.string().description('agency 数据目录，默认 DSH_HOME/cortex-agency'),
  dbFile: Schema.string().description('agency SQLite 文件；默认 dataRoot/agency.sqlite'),
  scope: Schema.string().default('agency').description('写入 cortex 的 scope；与用户记忆分区'),
  idleMinutes: Schema.natural().default(30).description('空闲多少分钟后才允许进入内在循环'),
  maxThoughtsPerDay: Schema.natural().default(12).description('每天最多几条内在沉思（token 预算）'),
  minGapMinutes: Schema.natural().default(60).description('同一个驱力两次发言之间的最小间隔'),
  globalGapMinutes: Schema.natural().default(25).description('任意两条沉思之间的全局硬间隔，防止不同驱力接力连发'),
  similarityThreshold: Schema.number().default(0.35).description('与最近几条沉思的二gram相似度上限，超了先重写、再超就放弃'),
  maxAttempts: Schema.natural().default(1).description('相似度超限后的重写次数'),
  maxCatchUpMinutes: Schema.natural().default(30).description('单次 tick 最多补算多少分钟驱力，防止长时间空档一次把驱力灌满'),
  maxTokens: Schema.natural().default(220).description('单条沉思的 token 上限'),
  recallMemory: Schema.boolean().default(true).description('沉思前先读最近的真实记忆（只读，不写入用户分区）'),
  memoryScope: Schema.string().default('global').description('读记忆用的 scope'),
  memoryLimit: Schema.natural().default(3).description('每次读几条记忆'),
  selfName: Schema.string().description('内在声音的自称；默认取 cortex 的 persona.selfName'),
}) : undefined;

function formatStatus(status) {
  const lines = [
    `开关：${status.enabled ? '开' : '关'} · 分区：${status.scope}`,
    `驱力：${status.drives.map((drive) => `${drive.name} ${Math.round(drive.potential * 100)}`).join(' / ')}`,
    `预算：今日 ${status.budget.usedToday}/${status.budget.maxThoughtsPerDay} · 全局间隔 ${status.budget.globalGapMinutes ?? '-'} 分钟 · 单驱力 ${status.budget.minGapMinutes} 分钟 · 单条 ${status.budget.maxTokens} token`,
    `累计：沉思 ${status.stats.thoughts} 条 · 活跃目标 ${status.stats.goals} 条`,
  ];
  if (status.stats.lastThoughtAt) lines.push(`上次沉思：${status.stats.lastThoughtAt}`);
  if (status.guards) lines.push(`闸：相似度 <${status.guards.similarityThreshold}（重写 ${status.guards.maxAttempts} 次）· 单次补算 ≤${status.guards.maxCatchUpMinutes} 分钟`);
  lines.push(`LLM：${status.llm ? '可用' : '不可用（不会编造）'}`);
  return lines.join('\n');
}

function toolDefinition(engine, store) {
  return {
    name: 'cortex_agency',
    description: 'Inspect the dsh-cortex-agency companion: drive pool, rumination budget and recent inner thoughts. Off by default; never sends messages. Actions: status / thoughts / step.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['status', 'thoughts', 'step', 'alignment'] },
        limit: { type: 'number', description: 'thoughts 返回条数，默认 5' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
    },
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      if (args.action === 'status') return { text: formatStatus(engine.status()) };
      if (args.action === 'thoughts') {
        const rows = store.listThoughts({ limit: Math.max(1, Math.min(50, Number(args.limit) || 5)) });
        if (!rows.length) return { text: '还没有内在沉思。' };
        return { text: rows.map((row) => `- ${row.at} [${row.drive}] ${row.text}`).join('\n') };
      }
      if (args.action === 'step') {
        const result = await engine.step({ at: Date.now(), idle: true });
        return { text: result.created ? `写了一条：${result.created}` : `没有写：${result.skipped ?? 'unknown'}` };
      }
      if (args.action === 'alignment') {
        const result = engine.alignment();
        const lines = [`清单对照（只读，不合并）：agency ${result.agencyGoals} 条 · cortex ${result.cortexItems} 条`];
        if (result.matched.length) lines.push(`两边都有：\n${result.matched.map((item) => `- ${item.agency} ≈ ${item.cortex}`).join('\n')}`);
        if (result.onlyAgency.length) lines.push(`只在 agency：\n${result.onlyAgency.map((text) => `- ${text}`).join('\n')}`);
        if (result.onlyCortex.length) lines.push(`只在 cortex：\n${result.onlyCortex.map((text) => `- ${text}`).join('\n')}`);
        return { text: lines.join('\n') };
      }
      return { text: `未知 action：${args.action}` };
    },
    presentCall: () => ({ card: 'generic', title: 'Cortex Agency', kind: 'other' }),
  };
}

export async function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? null;
  const cortex = ctx?.get?.('cortex') ?? null;
  if (!cortex) {
    logger?.warn?.('cortex-agency: dsh-cortex is not loaded; staying idle');
    return;
  }

  const dataRoot = config.dataRoot || path.join(os.homedir(), '.dsh', 'cortex-agency');
  const dbFile = config.dbFile || path.join(dataRoot, 'agency.sqlite');
  const store = openAgencyStore({ file: dbFile });
  const engine = createAgencyEngine({
    cortex,
    store,
    config: { ...config, enabled: config.enabled === true },
    logger,
    selfName: config.selfName || cortex.config?.persona?.selfName || '你',
  });

  let lastActivity = Date.now();
  let running = false;
  let fallbackTimer = null;
  let disposed = false;

  const idleMinutes = Math.max(1, Number(config.idleMinutes ?? 30));

  function isIdle(at = Date.now()) {
    return (at - lastActivity) / 60_000 >= idleMinutes;
  }

  async function heartbeat(report = null) {
    if (disposed || running) return { skipped: 'busy' };
    if (config.enabled !== true) return { skipped: 'disabled' };
    if (!isIdle()) return { skipped: 'active' };
    running = true;
    try {
      const result = await engine.step({ at: Date.now(), idle: true });
      if (report?.steps) report.steps.agency = { skipped: result.skipped ?? null, created: Boolean(result.created) };
      return result;
    } catch (error) {
      logger?.warn?.(`cortex-agency tick failed: ${error instanceof Error ? error.message : String(error)}`);
      return { skipped: 'error', error: error instanceof Error ? error.message : String(error) };
    } finally {
      running = false;
    }
  }

  function wire() {
    const disposers = [];
    if (typeof cortex.onTick === 'function') {
      disposers.push(cortex.onTick((report) => { void heartbeat(report); }));
    } else {
      fallbackTimer = setInterval(() => { void heartbeat(); }, 60_000);
      fallbackTimer?.unref?.();
    }
    if (typeof ctx?.on === 'function') {
      disposers.push(ctx.on('session/event', () => { lastActivity = Date.now(); }));
    }
    if (typeof ctx?.provide === 'function') {
      const disposeService = ctx.provide('cortexAgency', {
        status: () => engine.status(),
        step: (options) => engine.step({ ...options, at: options?.at ?? Date.now() }),
        thoughts: (options) => store.listThoughts(options),
      });
      if (typeof disposeService === 'function') disposers.push(disposeService);
    }
    const tools = ctx?.get?.('tools') ?? null;
    if (tools && typeof tools.register === 'function') {
      const disposeTool = tools.register(toolDefinition(engine, store));
      if (typeof disposeTool === 'function') disposers.push(disposeTool);
    }
    return () => {
      disposed = true;
      if (fallbackTimer) clearInterval(fallbackTimer);
      for (const dispose of disposers.reverse()) {
        try { dispose?.(); } catch { /* unloading is quiet */ }
      }
      try { engine.close(); } catch { /* quiet */ }
    };
  }

  try {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(wire, 'cortex-agency: idle loop');
    } else {
      const cleanup = wire();
      if (typeof ctx?.on === 'function') ctx.on('dispose', cleanup);
    }
  } catch (error) {
    disposed = true;
    logger?.warn?.(`cortex-agency wiring failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
