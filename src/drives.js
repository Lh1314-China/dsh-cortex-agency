/**
 * Drive pool. This is a deliberately small, inspectable model: each drive
 * accumulates pressure over idle time and releases when it is expressed.
 * It is not a claim about feelings; it is a scheduler that decides *when*
 * an inner thought is worth spending tokens on.
 */
export const DEFAULT_DRIVES = Object.freeze([
  { id: 'curiosity', name: '好奇', potential: 0.15, fillPerMin: 0.004, threshold: 0.65, release: 0.35 },
  { id: 'connection', name: '联结', potential: 0.10, fillPerMin: 0.003, threshold: 0.60, release: 0.30 },
  { id: 'order', name: '安定', potential: 0.25, fillPerMin: 0.005, threshold: 0.70, release: 0.40 },
  { id: 'expression', name: '表达', potential: 0.12, fillPerMin: 0.0035, threshold: 0.62, release: 0.30 },
]);

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function evolveDrives(drives, elapsedMinutes, { idleFactor = 1 } = {}) {
  const span = Math.max(0, Number(elapsedMinutes) || 0) * clamp01(idleFactor);
  return drives.map((drive) => ({
    ...drive,
    potential: clamp01((Number(drive.potential) || 0) + span * (Number(drive.fillPerMin) || 0)),
  }));
}

export function pickDrive(drives) {
  let best = null;
  for (const drive of drives) {
    if (!best || Number(drive.potential) > Number(best.potential)) best = drive;
  }
  return best;
}

export function releaseDrive(drives, id) {
  return drives.map((drive) => (drive.id === id ? { ...drive, potential: clamp01(Number(drive.potential) - (Number(drive.release) || 0)) } : drive));
}

export function aboveThreshold(drives) {
  return drives.filter((drive) => Number(drive.potential) >= Number(drive.threshold));
}

/**
 * Per-drive spacing: the more often a drive has been expressed, the longer it
 * waits before it may speak again. This is the same curve cortex uses for
 * recall access, applied to rumination instead.
 */
export function driveGapMs(thoughtCount, { minGapMs = 3_600_000, maxGapMs = 21_600_000 } = {}) {
  const count = Math.max(0, Math.min(8, Number(thoughtCount) || 0));
  const base = Math.max(1_000, Number(minGapMs) || 3_600_000);
  const max = Math.max(base, Number(maxGapMs) || 21_600_000);
  return Math.min(max, base * (2 ** count));
}
