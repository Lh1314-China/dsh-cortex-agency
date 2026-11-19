import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../index.js';

function fakeCortex() {
  const writes = [];
  const tickHandlers = [];
  return {
    writes,
    tickHandlers,
    config: { persona: { selfName: '助手' } },
    llm: { available: () => true, complete: async () => '独处的时候，海面很安静。' },
    write(input) { writes.push(input); return { trace: { id: `trc_${writes.length}` } }; },
    onTick(handler) { tickHandlers.push(handler); return () => { const i = tickHandlers.indexOf(handler); if (i >= 0) tickHandlers.splice(i, 1); }; },
  };
}

test('apply wires the heartbeat, provides the service and cleans up', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-agency-wiring-'));
  const cortex = fakeCortex();
  const provided = {};
  const cleanups = [];
  const events = [];
  const registered = [];
  const tools = { register: (tool) => { registered.push(tool); return () => { const i = registered.indexOf(tool); if (i >= 0) registered.splice(i, 1); }; } };
  const ctx = {
    logger: { warn() {}, info() {} },
    get: (name) => (name === 'cortex' ? cortex : name === 'tools' ? tools : null),
    effect: (fn) => { cleanups.push(fn()); },
    on: (name, handler) => { events.push({ name, handler }); return () => {}; },
    provide: (name, value) => { provided[name] = value; return () => {}; },
  };
  try {
    await apply(ctx, { enabled: false, dataRoot: dir, dbFile: path.join(dir, 'agency.sqlite'), idleMinutes: 30 });
    assert.equal(cortex.tickHandlers.length, 1);
    assert.ok(provided.cortexAgency);
    assert.equal(typeof provided.cortexAgency.status, 'function');
    assert.equal(provided.cortexAgency.status().enabled, false);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, 'cortex_agency');
    const statusText = await registered[0].execute({ action: 'status' });
    assert.match(statusText.text, /开关/);
    assert.match(statusText.text, /驱力/);
    cortex.tickHandlers[0]({ steps: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cortex.writes.length, 0, 'disabled agency must not write');
    assert.ok(existsSync(path.join(dir, 'agency.sqlite')));
    for (const cleanup of cleanups.reverse()) cleanup();
    assert.equal(cortex.tickHandlers.length, 0, 'cleanup must detach the heartbeat');
    assert.equal(registered.length, 0, 'cleanup must unregister the tool');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply survives a host without cortex', async () => {
  const ctx = { logger: { warn() {} }, get: () => null };
  await apply(ctx, { enabled: true, dataRoot: os.tmpdir() });
});
