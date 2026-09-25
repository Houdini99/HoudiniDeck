// System Stats tiles: parsing /proc, hwmon and nvidia-smi, what gets read when, and how tiles look.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExtStore } from '../server/ext-store.ts';
import { silentLogger } from '../server/log.ts';
import type { Runner } from '../server/system/process.ts';
import { StatsWatcher, cpuPercent, cpuTimesOf, parseMeminfo, parseNvidiaSmi, parseProcStat } from '../server/system/stats.ts';
import { emptyExtState, type StatMetric, type StatsState } from '../shared/ext-types.ts';
import { buttonVisual } from '../shared/feedback.ts';
import { emptyObsState } from '../shared/obs-types.ts';
import { ActionSchema, type Deck } from '../shared/schema.ts';
import { tempDir, waitFor } from './helpers.ts';

const STAT_A = 'cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 50 0 50 350 50 0 0 0 0 0\n';
const STAT_B = 'cpu  400 0 200 900 100 0 0 0 0 0\ncpu0 200 0 100 450 50 0 0 0 0 0\n'; // +400 busy of +600 total
const MEMINFO = 'MemTotal:       32000000 kB\nMemFree:         1000000 kB\nMemAvailable:   24000000 kB\n';
const SMI = '37, 52, 2048, 16376\n';

test('parsers for /proc/stat, /proc/meminfo and nvidia-smi', () => {
  const a = parseProcStat(STAT_A)!;
  const b = parseProcStat(STAT_B)!;
  assert.deepEqual(a, { busy: 200, total: 1000 });
  assert.equal(Math.round(cpuPercent(a, b)!), 67);
  assert.equal(cpuPercent(a, a), undefined, 'no time passed');
  assert.equal(parseProcStat('garbage'), null);

  assert.deepEqual(parseMeminfo(MEMINFO), { used: 8000000 * 1024, total: 32000000 * 1024 });
  assert.equal(parseMeminfo('MemTotal: 5 kB\n'), null);

  assert.deepEqual(parseNvidiaSmi(SMI), { util: 37, temp: 52, memUsed: 2048, memTotal: 16376 });
  assert.deepEqual(parseNvidiaSmi('10, 40, 1, 2\n90, 80, 3, 4\n'), { util: 10, temp: 40, memUsed: 1, memTotal: 2 }, 'first GPU');
  assert.equal(parseNvidiaSmi('[N/A], 52, 2048, 16376'), null);
});

async function fakeSystem(t: { after: (fn: () => Promise<void>) => void }) {
  const tmp = await tempDir();
  t.after(tmp.cleanup);
  const proc = join(tmp.dir, 'proc');
  const hwmon = join(tmp.dir, 'hwmon');
  await mkdir(proc);
  await writeFile(join(proc, 'stat'), STAT_A);
  await writeFile(join(proc, 'meminfo'), MEMINFO);
  // The CPU sensor is found by driver name, not by its (changing) number.
  for (const [dir, name, temp] of [
    ['hwmon0', 'acpitz', '27800'],
    ['hwmon4', 'k10temp', '61250'],
    ['hwmon5', 'nvme', '39850'],
  ]) {
    await mkdir(join(hwmon, dir), { recursive: true });
    await writeFile(join(hwmon, dir, 'name'), `${name}\n`);
    await writeFile(join(hwmon, dir, 'temp1_input'), `${temp}\n`);
  }
  const smiCalls: string[][] = [];
  let smi: 'ok' | 'missing' = 'ok';
  const run: Runner = async (_cmd, args) => {
    smiCalls.push(args);
    if (smi === 'missing') throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
    return { code: 0, stdout: SMI, stderr: '' };
  };
  const store = new ExtStore();
  const watcher = new StatsWatcher({ store, run, log: silentLogger, procRoot: proc, hwmonRoot: hwmon, pollMs: 40, platform: 'linux' });
  t.after(async () => watcher.stop());
  return { proc, smiCalls, store, watcher, stats: () => store.state.stats, setSmi: (s: typeof smi) => (smi = s) };
}

test('only the metrics on screen are read, and nothing once none are', async (t) => {
  const sys = await fakeSystem(t);
  sys.watcher.setWanted(['memory', 'cpuTemp']);
  await waitFor(() => sys.stats().cpuTemp, 1000, 'first reading');
  assert.deepEqual(sys.stats(), { memory: { used: 8000000 * 1024, total: 32000000 * 1024 }, cpuTemp: 61.25 });
  assert.equal(sys.smiCalls.length, 0, 'nvidia-smi only runs for GPU tiles');

  sys.watcher.setWanted(['gpuTemp']);
  await waitFor(() => sys.stats().gpu, 1000, 'gpu reading');
  assert.deepEqual(sys.stats(), { gpu: { util: 37, temp: 52, memUsed: 2048, memTotal: 16376 } }, 'readings no one wants are dropped');

  sys.watcher.setWanted([]);
  assert.deepEqual(sys.stats(), {});
  const calls = sys.smiCalls.length;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sys.smiCalls.length, calls, 'polling stopped');
});

test('CPU load comes from the change between two readings', async (t) => {
  const sys = await fakeSystem(t);
  sys.watcher.setWanted(['cpu']);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sys.stats().cpu, undefined, 'one reading is not enough');
  await writeFile(join(sys.proc, 'stat'), STAT_B);
  await waitFor(() => sys.stats().cpu !== undefined, 2000, 'cpu load');
  assert.equal(Math.round(sys.stats().cpu!), 67);
});

test('without nvidia-smi, GPU tiles say n/a and it is not tried again', async (t) => {
  const sys = await fakeSystem(t);
  sys.setSmi('missing');
  sys.watcher.setWanted(['gpu']);
  await waitFor(() => sys.stats().gpu === null, 1000, 'gpu unavailable');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sys.smiCalls.length, 1);
});

const deck: Deck = { version: 1, revision: 0, homePageId: 'p', pages: [{ id: 'p', name: 'P', rows: 1, cols: 1, buttons: {} }] };
const tile = (metric: StatMetric, stats: StatsState) =>
  buttonVisual({ id: 's', tap: { type: 'system.stats', metric } }, { obs: emptyObsState(), deck, ext: { ...emptyExtState(), stats }, now: 0 });

test('without /proc (Windows), CPU and memory come from Node; the CPU temperature is n/a', async (t) => {
  const times = (user: number, idle: number) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  assert.deepEqual(cpuTimesOf([times(30, 70), times(10, 90)]), { busy: 40, total: 200 });
  assert.equal(cpuTimesOf([]), null);

  const store = new ExtStore();
  const run: Runner = async () => ({ code: 0, stdout: SMI, stderr: '' });
  // Paths that don't exist: nothing may be read from them.
  const watcher = new StatsWatcher({ store, run, log: silentLogger, procRoot: '/no/proc', hwmonRoot: '/no/hwmon', pollMs: 40, platform: 'win32' });
  t.after(() => watcher.stop());
  watcher.setWanted(['cpu', 'memory', 'cpuTemp', 'gpu']);
  await waitFor(() => typeof store.state.stats.cpu === 'number', 2000, 'CPU load');
  const { cpu, memory, cpuTemp, gpu } = store.state.stats;
  assert.ok(cpu! >= 0 && cpu! <= 100);
  assert.ok(memory!.total > 0 && memory!.used > 0 && memory!.used <= memory!.total);
  assert.equal(cpuTemp, null);
  assert.deepEqual(gpu, { util: 37, temp: 52, memUsed: 2048, memTotal: 16376 }, 'nvidia-smi works the same');
});

test('stats tiles show the value, a bar, and warm/hot colors', () => {
  assert.deepEqual(tile('cpu', { cpu: 42.4 }).gauge, { text: '42%', detail: undefined, level: 0.424, tone: undefined });
  assert.equal(tile('cpu', { cpu: 95 }).gauge?.tone, 'hot');
  assert.deepEqual(tile('memory', { memory: { used: 12.5 * 1024 ** 3, total: 32 * 1024 ** 3 } }).gauge, {
    text: '39%',
    detail: '12.5 GB',
    level: 12.5 / 32,
    tone: undefined,
  });
  assert.equal(tile('cpuTemp', { cpuTemp: 72.6 }).gauge?.text, '73°C');
  assert.equal(tile('cpuTemp', { cpuTemp: 72.6 }).gauge?.tone, 'warm');
  const gpu = { util: 88, temp: 84, memUsed: 14000, memTotal: 16376 };
  assert.equal(tile('gpu', { gpu }).gauge?.text, '88%');
  assert.equal(tile('gpuTemp', { gpu }).gauge?.tone, 'hot');
  assert.equal(tile('gpuMemory', { gpu }).gauge?.detail, '13.7 GB');
  assert.equal(tile('gpuMemory', { gpu }).label, 'VRAM');

  assert.equal(tile('cpu', {}).gauge?.text, '–', 'not read yet');
  const missing = tile('gpu', { gpu: null });
  assert.equal(missing.gauge?.text, 'n/a');
  assert.equal(missing.disabled, true);
});

test('stats tiles are displays: not allowed as macro steps', () => {
  const step = { action: { type: 'system.stats', metric: 'cpu' } };
  assert.equal(ActionSchema.safeParse({ type: 'macro', steps: [step] }).success, false);
});
