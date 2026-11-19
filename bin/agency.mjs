#!/usr/bin/env node
/**
 * dsh-cortex-agency inspector. Read-only.
 *
 *   node bin/agency.mjs status
 *   node bin/agency.mjs thoughts --limit 10
 */
import os from 'node:os';
import path from 'node:path';
import { openAgencyStore } from '../src/store.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'status';
const rootArg = args.indexOf('--data-root');
const dataRoot = rootArg >= 0 ? args[rootArg + 1] : path.join(os.homedir(), '.dsh', 'cortex-agency');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 10;

const store = openAgencyStore({ file: path.join(dataRoot, 'agency.sqlite') });
try {
  if (command === 'thoughts') {
    for (const row of store.listThoughts({ limit })) {
      console.log(`${row.at} [${row.drive}] ${row.text}${row.trace_id ? `  → ${row.trace_id}` : ''}`);
    }
    process.exit(0);
  }
  const drives = store.loadDrives();
  console.log(JSON.stringify({
    dataRoot,
    drives: drives.map((drive) => ({ id: drive.id, name: drive.name, potential: Number(drive.potential.toFixed(3)), threshold: drive.threshold })),
    stats: store.stats(),
  }, null, 2));
} finally {
  store.close();
}
