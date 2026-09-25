// Readings for System Stats tiles, every 2 seconds and only for the metrics some browser shows:
// CPU load (/proc/stat), memory (/proc/meminfo), CPU temperature (hwmon) and NVIDIA GPU (nvidia-smi).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { StatMetric, StatsState } from '../../shared/ext-types.ts';
import type { ExtStore } from '../ext-store.ts';
import type { Logger } from '../log.ts';
import type { Runner } from './process.ts';

const POLL_MS = 2000;
/** CPU load needs two readings; the second comes this soon after the first. */
const FIRST_CPU_DELTA_MS = 500;
/** hwmon drivers for CPU temperature: AMD (k10temp, zenpower) and Intel (coretemp). */
const CPU_SENSORS = ['k10temp', 'zenpower', 'coretemp'];

export interface CpuTimes {
  busy: number;
  total: number;
}

/** The first line of /proc/stat: cpu user nice system idle iowait irq softirq steal … */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (values.length < 5 || values.some((v) => !Number.isFinite(v))) return null;
  const total = values.reduce((a, b) => a + b, 0);
  const idle = values[3] + values[4]; // idle + iowait
  return { busy: total - idle, total };
}

export function cpuPercent(before: CpuTimes, after: CpuTimes): number | undefined {
  const total = after.total - before.total;
  if (total <= 0) return undefined;
  return Math.min(100, Math.max(0, ((after.busy - before.busy) / total) * 100));
}

/** Used = MemTotal − MemAvailable (what the desktop's system monitor shows), in bytes. */
export function parseMeminfo(text: string): { used: number; total: number } | null {
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1]);
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (!(total > 0) || !Number.isFinite(available)) return null;
  return { used: (total - available) * 1024, total: total * 1024 };
}

/** `nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits` */
export function parseNvidiaSmi(stdout: string): StatsState['gpu'] {
  const first = stdout.trim().split('\n')[0] ?? '';
  const [util, temp, memUsed, memTotal] = first.split(',').map((v) => Number(v.trim()));
  if ([util, temp, memUsed, memTotal].some((v) => !Number.isFinite(v)) || !(memTotal > 0)) return null;
  return { util, temp, memUsed, memTotal };
}

export interface StatsWatcherDeps {
  store: ExtStore;
  run: Runner;
  log: Logger;
  /** For tests: where /proc and /sys/class/hwmon are. */
  procRoot?: string;
  hwmonRoot?: string;
  pollMs?: number;
}

export class StatsWatcher {
  private wanted = new Set<StatMetric>();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private lastCpu?: CpuTimes;
  /** The CPU temperature file: undefined until looked up, null if there is none. */
  private tempFile?: string | null;
  private nvidiaMissing = false;
  private readonly deps: StatsWatcherDeps;

  constructor(deps: StatsWatcherDeps) {
    this.deps = deps;
  }

  private get stats(): StatsState {
    return this.deps.store.state.stats;
  }

  /** The metrics on screen anywhere; none stops the polling. */
  setWanted(metrics: Iterable<StatMetric>): void {
    const next = new Set(metrics);
    const same = next.size === this.wanted.size && [...next].every((m) => this.wanted.has(m));
    if (same) return;
    const starting = this.wanted.size === 0 && next.size > 0;
    this.wanted = next;
    if (next.size === 0) return this.stop();
    if (starting) {
      this.nvidiaMissing = false; // may have been installed meanwhile
      this.timer = setInterval(() => void this.poll(), this.deps.pollMs ?? POLL_MS);
    }
    void this.poll();
  }

  stop(): void {
    this.wanted.clear();
    clearInterval(this.timer);
    this.timer = undefined;
    this.lastCpu = undefined;
    if (Object.keys(this.stats).length === 0) return;
    for (const key of Object.keys(this.stats)) delete this.stats[key as keyof StatsState];
    this.deps.store.changed();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const next: StatsState = {};
      const wants = (...metrics: StatMetric[]) => metrics.some((m) => this.wanted.has(m));
      if (wants('cpu')) next.cpu = await this.readCpu();
      if (wants('memory')) next.memory = await this.readMemory();
      if (wants('cpuTemp')) next.cpuTemp = await this.readCpuTemp();
      if (wants('gpu', 'gpuTemp', 'gpuMemory')) next.gpu = await this.readGpu();
      if (this.wanted.size === 0) return; // stopped meanwhile
      this.apply(next);
      if (wants('cpu') && next.cpu === undefined) setTimeout(() => void this.poll(), FIRST_CPU_DELTA_MS);
    } finally {
      this.polling = false;
    }
  }

  private apply(next: StatsState): void {
    const before = JSON.stringify(this.stats);
    for (const key of Object.keys(this.stats) as (keyof StatsState)[]) if (!(key in next)) delete this.stats[key];
    Object.assign(this.stats, next);
    if (JSON.stringify(this.stats) !== before) this.deps.store.changed();
  }

  private async readCpu(): Promise<number | null | undefined> {
    const times = parseProcStat(await this.read(join(this.deps.procRoot ?? '/proc', 'stat')));
    if (!times) return null;
    const before = this.lastCpu;
    this.lastCpu = times;
    return before ? (cpuPercent(before, times) ?? this.stats.cpu ?? undefined) : undefined;
  }

  private async readMemory(): Promise<StatsState['memory']> {
    return parseMeminfo(await this.read(join(this.deps.procRoot ?? '/proc', 'meminfo')));
  }

  private async readCpuTemp(): Promise<number | null> {
    if (this.tempFile === undefined) this.tempFile = await this.findTempSensor();
    if (!this.tempFile) return null;
    const milli = Number((await this.read(this.tempFile)).trim());
    if (Number.isFinite(milli) && milli > 0) return milli / 1000;
    this.tempFile = undefined; // look it up again next time (hwmon numbers can change)
    return null;
  }

  /** hwmon numbers change between boots, so the sensor is found by its driver name. */
  private async findTempSensor(): Promise<string | null> {
    const root = this.deps.hwmonRoot ?? '/sys/class/hwmon';
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      return null;
    }
    for (const sensor of CPU_SENSORS) {
      for (const dir of dirs) {
        if ((await this.read(join(root, dir, 'name'))).trim() === sensor) return join(root, dir, 'temp1_input');
      }
    }
    return null;
  }

  private async readGpu(): Promise<StatsState['gpu']> {
    if (this.nvidiaMissing) return null;
    try {
      const res = await this.deps.run('nvidia-smi', [
        '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total',
        '--format=csv,noheader,nounits',
      ]);
      if (res.code !== 0) this.deps.log.debug(`nvidia-smi failed: ${res.stderr.trim() || `exit code ${res.code}`}`);
      return res.code === 0 ? parseNvidiaSmi(res.stdout) : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.nvidiaMissing = true;
      else this.deps.log.debug(`Could not run nvidia-smi: ${(err as Error).message}`);
      return null;
    }
  }

  private async read(path: string): Promise<string> {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return '';
    }
  }
}
