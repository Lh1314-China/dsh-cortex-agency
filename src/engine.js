import { aboveThreshold, driveGapMs, evolveDrives, pickDrive, releaseDrive } from './drives.js';

const GOAL_TEMPLATES = {
  curiosity: '把还没想明白的那件事，多看一层。',
  connection: '想一想上次对话里，哪句话还没接住。',
  order: '把散着的记忆收一收，别让它们互相打架。',
  expression: '把今天的感觉整理成一句能说出口的话。',
};

function iso(at) {
  return new Date(at).toISOString();
}

function dayStartIso(at) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function compact(text, max = 400) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max) : value;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * The model has no clock of its own. Without one it wrote "tonight" at noon,
 * so hand it the local wall clock: it may then be wrong about what the time
 * means, but not about what the time is.
 */
function localClock(at) {
  const date = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The agency engine. It only ever:
 *   - reads its own drive state,
 *   - writes its own thoughts/goals,
 *   - calls cortex.write() into its own scope,
 * and it never sends a message or touches another scope.
 */
export function createAgencyEngine({
  cortex,
  store,
  config = {},
  now = () => Date.now(),
  logger = null,
  selfName = '你',
} = {}) {
  if (!cortex || typeof cortex.write !== 'function') throw new Error('agency engine needs cortex.write');
  if (!store) throw new Error('agency engine needs a store');

  const scope = String(config.scope || 'agency');
  const maxThoughtsPerDay = Math.max(0, Number(config.maxThoughtsPerDay ?? 12));
  const minGapMs = Math.max(0, Number(config.minGapMinutes ?? 60)) * 60_000;
  // System-wide floor. Per-drive gaps alone let four drives take turns inside
  // four minutes — that reads as a burst, not as rumination.
  const globalGapMs = Math.max(0, Number(config.globalGapMinutes ?? 25)) * 60_000;
  const maxTokens = Math.max(80, Number(config.maxTokens ?? 220));
  // Writing nearly the same meditation twice is worse than writing none: one is
  // noise, the other is a gap. Compare against the last few and refuse.
  const similarityThreshold = Math.max(0, Math.min(1, Number(config.similarityThreshold ?? 0.35)));
  const maxAttempts = Math.max(0, Math.min(3, Number(config.maxAttempts ?? 1)));
  // A tick arriving after hours of silence used to fill every drive to 100 at
  // once, which erased the point of having different drives at all.
  const maxCatchUpMinutes = Math.max(1, Math.min(24 * 60, Number(config.maxCatchUpMinutes ?? 30)));
  const llm = config.llm ?? cortex.llm ?? null;

  function pressure(drives) {
    const above = aboveThreshold(drives);
    return (above.length ? above : drives).map((drive) => ({ id: drive.id, name: drive.name, potential: Number(drive.potential.toFixed(3)), threshold: drive.threshold }));
  }

  function status(at = now()) {
    const drives = store.loadDrives();
    return {
      enabled: config.enabled === true,
      scope,
      at: iso(at),
      drives,
      pressure: pressure(drives),
      budget: { maxThoughtsPerDay, usedToday: store.countThoughtsSince(dayStartIso(at)), minGapMinutes: Math.round(minGapMs / 60_000), globalGapMinutes: Math.round(globalGapMs / 60_000), maxTokens },
      guards: { similarityThreshold, maxAttempts, maxCatchUpMinutes },
      stats: store.stats(),
      llm: Boolean(llm?.available?.()),
    };
  }

  /**
   * Ground rumination in what actually happened. Searching for the drive name
   * ("好奇", "联结") returned almost nothing usable, so the primary source is
   * now the recent traces themselves; search stays as the fallback for hosts
   * without a trace repository. Read-only in both cases.
   */
  function recentMaterial(drive, at) {
    if (config.recallMemory === false) return [];
    const scopeId = config.memoryScope ?? 'global';
    const limit = Math.max(1, Math.min(8, Number(config.memoryLimit ?? 3)));
    const take = Math.max(limit * 6, 12);
    const traces = cortex.repos?.traces ?? null;
    let rows = null;
    try {
      if (typeof traces?.list === 'function') {
        rows = traces.list({ scopeId, limit: take });
      } else if (typeof traces?.listSince === 'function') {
        const hours = Math.max(1, Number(config.anchorHours ?? 48));
        const since = new Date(at - hours * 3_600_000).toISOString();
        const window = traces.listSince(scopeId, since, { limit: 200 });
        if (Array.isArray(window)) rows = window.slice(-take);
      }
    } catch {
      rows = null;
    }
    if (Array.isArray(rows) && rows.length) {
      const events = rows
        .filter((row) => row && row.kind !== 'reflection')
        .slice(0, limit)
        .map((row) => {
          const when = String(row.recordedAt ?? '').slice(5, 16).replace('T', ' ');
          const what = String(row.title || row.summary || row.content || '').replace(/\s+/g, ' ').trim().slice(0, 90);
          return what ? `${when} ${what}` : '';
        })
        .filter(Boolean);
      if (events.length) return events;
    }
    if (typeof cortex.search !== 'function') return [];
    try {
      const result = cortex.search(drive.name, { scopeId, limit, noBudget: true, now: at });
      return (result?.items ?? [])
        .map((item) => `${item.title ?? ''}：${item.snippet ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 120))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async function composeThought(drive, drives, at, repeatGuard = false) {
    if (!llm?.available?.() || typeof llm.complete !== 'function') return { text: null, memoryUsed: 0 };
    const recent = store.listThoughts({ limit: 3 }).map((row) => `- ${row.text}`).join('\n');
    const material = recentMaterial(drive, at);
    const text = await llm.complete({
      system: `你是${selfName}的内在声音。写一段 60-120 字的内心独白：只说给自己听，不求助、不提问、不提系统或插件，不改变任何事实。不要复用之前写过的比喻、意象和句式。`,
      prompt: [
        `现在是 ${localClock(at)}（本地时间），时段以这个为准，别凭感觉说「今晚」「早上」。`,
        `当前驱力：${drives.map((item) => `${item.name}${Math.round(item.potential * 100)}`).join(' ')}`,
        `最想往前推的是：${drive.name}`,
        material.length ? `最近真实发生过（只读，别改写这些事实）：\n${material.map((item) => `- ${item}`).join('\n')}` : '',
        recent ? `上次想过（只当参照，不要复用其中的比喻、意象和句子，也别用同样的开头）：\n${recent}` : '',
        repeatGuard ? '上一版跟最近说过的话太像了。换一个角度写：说一件具体发生过的事，或者一个还没想明白的小问题；别再说「静」「灯亮着」「坐着」这类话。' : '',
        '现在独处，写下这一刻。',
      ].filter(Boolean).join('\n'),
      maxTokens,
      temperature: 0.85,
      purpose: 'cortex-agency',
    });
    const value = compact(text, 400);
    return { text: value || null, memoryUsed: material.length };
  }

  async function step({ at = now(), idle = true, auto = true } = {}) {
    if (config.enabled !== true) return { skipped: 'disabled' };
    if (!idle) {
      store.setMeta('lastTickAt', at);
      return { skipped: 'active' };
    }
    const lastTick = Number(store.getMeta('lastTickAt')) || at;
    const elapsedMinutes = Math.max(0, Math.min(maxCatchUpMinutes, (at - lastTick) / 60_000));
    let drives = evolveDrives(store.loadDrives(), elapsedMinutes);
    store.saveDrives(drives, iso(at));
    store.setMeta('lastTickAt', at);
    store.expireGoals(iso(at));

    const goals = [];
    if (auto) {
      for (const drive of aboveThreshold(drives)) {
        if (store.activeGoalFor(drive.id, iso(at))) continue;
        const goalText = GOAL_TEMPLATES[drive.id] ?? `把「${drive.name}」这件事往前推一点。`;
        store.addGoal({
          id: `agl_${at.toString(36)}_${drive.id}`,
          drive: drive.id,
          text: goalText,
          priority: Number(drive.potential.toFixed(3)),
          at: iso(at),
          expiresAt: iso(at + 24 * 60 * 60_000),
        });
        goals.push({ drive: drive.id, text: goalText });
      }
    }

    const usedToday = store.countThoughtsSince(dayStartIso(at));
    if (usedToday >= maxThoughtsPerDay) {
      return { skipped: 'daily-budget', drives, goals, usedToday };
    }
    // Global floor, applied before the per-drive one. After a long gap every
    // drive can be over threshold at once; letting them take turns minute by
    // minute reads as a burst, not as a monologue rhythm.
    const lastAny = store.lastThoughtAt?.() ?? null;
    if (lastAny) {
      const sinceLast = at - Date.parse(lastAny);
      if (Number.isFinite(sinceLast) && sinceLast < globalGapMs) {
        return { skipped: 'global-cooldown', drives, goals, minutesSinceLast: Math.round(sinceLast / 60_000) };
      }
    }
    const above = aboveThreshold(drives);
    if (!above.length) {
      return { skipped: 'no-pressure', drives, goals };
    }
    // Per-drive spacing: a drive that has spoken recently waits longer next
    // time (doubling, capped). Another drive with no recent thought can step in.
    const maxGapMs = Math.max(minGapMs, Number(config.maxGapHours ?? 6) * 3_600_000);
    const eligible = above.filter((item) => {
      const last = store.lastThoughtForDrive?.(item.id) ?? null;
      if (!last) return true;
      const count = store.countThoughtsForDrive?.(item.id) ?? 0;
      return at - Date.parse(last) >= driveGapMs(count, { minGapMs, maxGapMs });
    });
    if (!eligible.length) {
      return { skipped: 'cooldown', drives, goals, cooling: above.map((item) => item.id) };
    }

    let created = null;
    let memoryUsed = 0;
    let maxSimilarity = 0;
    const drive = pickDrive(eligible);
    let error = null;
    if (auto) {
      const previous = store.listThoughts({ limit: 5 }).map((row) => row.text);
      for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
        try {
          const composed = await composeThought(drive, drives, at, attempt > 0);
          if (!composed.text) break;
          memoryUsed = composed.memoryUsed;
          maxSimilarity = previous.reduce((worst, text) => Math.max(worst, similarity(composed.text, text)), 0);
          if (maxSimilarity < similarityThreshold) {
            created = composed.text;
            break;
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          break;
        }
      }
    }
    if (!created) {
      const skipped = !llm?.available?.()
        ? 'no-llm'
        : (maxSimilarity >= similarityThreshold ? 'repetitive' : 'llm-failed');
      return { skipped, drives, goals, error, similarity: Number(maxSimilarity.toFixed(3)) };
    }

    const title = created.slice(0, 40);
    const written = cortex.write({
      scopeId: scope,
      text: `【内在沉思】${created}`,
      kind: 'reflection',
      title,
      source: 'agency:inner',
      actor: 'self',
      explicit: true,
      importance: 0.35,
      confidence: 0.4,
      facts: [],
      metadata: { partition: 'agency', drive: drive.id },
      now: at,
    });
    const traceId = written?.trace?.id ?? null;
    store.addThought({ id: `thg_${at.toString(36)}`, at: iso(at), drive: drive.id, text: created, source: 'agency:inner', llm: true, traceId });
    drives = releaseDrive(drives, drive.id);
    store.saveDrives(drives, iso(at));
    logger?.info?.(`cortex-agency 内在沉思（${drive.name}）：${created}`);
    return { created, drive: drive.id, traceId, memoryUsed, drives, goals, usedToday: usedToday + 1, similarity: Number(maxSimilarity.toFixed(3)) };
  }

  /**
   * Read-only comparison: agency goals next to cortex working memory/goals.
   * They are deliberately never merged — the point is to see where the two
   * timelines disagree, not to make them one list.
   */
  function alignment() {
    const own = store.listGoals({ status: 'active' });
    let snapshot = null;
    try { snapshot = cortex.self?.() ?? null; } catch { snapshot = null; }
    const working = Array.isArray(snapshot?.working) ? snapshot.working : [];
    const cortexGoals = Array.isArray(snapshot?.goals) ? snapshot.goals : [];
    const cortexTexts = [
      ...working.map((item) => item.text),
      ...cortexGoals.map((item) => item.title),
    ].map((text) => String(text ?? '').trim()).filter(Boolean);
    const matched = [];
    const onlyAgency = [];
    for (const goal of own) {
      const hit = cortexTexts.find((text) => similarity(goal.text, text) >= 0.34);
      if (hit) matched.push({ agency: goal.text, cortex: hit });
      else onlyAgency.push(goal.text);
    }
    const onlyCortex = cortexTexts.filter((text) => !own.some((goal) => similarity(goal.text, text) >= 0.34));
    return {
      agencyGoals: own.length,
      cortexItems: cortexTexts.length,
      matched,
      onlyAgency,
      onlyCortex,
    };
  }

  return { step, status, alignment, scope, close: () => store.close() };
}

function bigrams(text) {
  const value = String(text ?? '').replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
  return set;
}

function similarity(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / new Set([...left, ...right]).size;
}
