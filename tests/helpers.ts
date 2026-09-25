import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ButtonStateAccess } from '../server/button-state.ts';
import { emptyExtState, type ExtState, type TimerState } from '../shared/ext-types.ts';

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'vsd-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Poll until fn returns something truthy (or throw after timeoutMs). */
export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 3000, label = 'condition'): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

let counter = 0;
export const seqId = () => `id${++counter}`;

/** Counters, toggles and timers in memory (ButtonStates without the file). */
export function memoryStates(state: ExtState = emptyExtState()): ButtonStateAccess & { state: ExtState } {
  return {
    state,
    counter: (id) => state.counters[id] ?? 0,
    setCounter: (id, n) => void (state.counters[id] = n),
    toggle: (id) => state.toggles[id] ?? false,
    setToggle: (id, on) => void (state.toggles[id] = on),
    timer: (id) => state.timers[id],
    setTimer: (id, t: TimerState) => void (state.timers[id] = t),
  };
}
