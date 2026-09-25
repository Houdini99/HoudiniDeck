// State that belongs to deck buttons rather than to OBS or the PC: Counter counts, which Toggles are
// on, and Timer clocks. It lives in the ExtStore (so every browser sees it) and is saved to
// data/button-state.json, so a death counter or a running countdown survives a restart.
import { join } from 'node:path';
import type { TimerState } from '../shared/ext-types.ts';
import type { Deck } from '../shared/schema.ts';
import type { ExtStore } from './ext-store.ts';
import { errorMessage, type Logger } from './log.ts';
import { readJsonFile, writeJsonAtomic } from './store/files.ts';

const SAVE_DELAY_MS = 500;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Only well-formed entries of a saved map survive (the file may be old, or edited by hand). */
function entries<T>(value: unknown, valid: (v: unknown) => v is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [id, v] of Object.entries(value)) if (ID_RE.test(id) && valid(v)) out[id] = v;
  return out;
}

const isCount = (v: unknown): v is number => Number.isSafeInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isTimer = (v: unknown): v is TimerState => {
  const t = v as TimerState | null;
  return (
    !!t &&
    typeof t === 'object' &&
    Number.isFinite(t.elapsedMs) &&
    t.elapsedMs >= 0 &&
    (t.startedAt === undefined || Number.isFinite(t.startedAt))
  );
};

/** What executors need from ButtonStates (tests use an in-memory stand-in). */
export type ButtonStateAccess = Pick<ButtonStates, 'counter' | 'setCounter' | 'toggle' | 'setToggle' | 'timer' | 'setTimer'>;

export class ButtonStates {
  private saveTimer?: NodeJS.Timeout;
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly store: ExtStore;
  private readonly log: Logger;

  private constructor(path: string, store: ExtStore, log: Logger) {
    this.path = path;
    this.store = store;
    this.log = log;
  }

  /** Reads data/button-state.json; state of buttons the deck no longer has is dropped. */
  static async load(dataDir: string, store: ExtStore, deck: Deck, log: Logger): Promise<ButtonStates> {
    const states = new ButtonStates(join(dataDir, 'button-state.json'), store, log);
    let saved: Record<string, unknown> | undefined;
    try {
      saved = (await readJsonFile(states.path)) as Record<string, unknown> | undefined;
    } catch (err) {
      log.warn(`button-state.json can't be read (${errorMessage(err)}); counters and timers start from zero`);
    }
    const ids = new Set(deck.pages.flatMap((p) => Object.values(p.buttons).map((b) => b.id)));
    const keep = <T>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).filter(([id]) => ids.has(id)));
    const state = store.state;
    state.counters = keep(entries(saved?.counters, isCount));
    state.toggles = keep(entries(saved?.toggles, isBool));
    state.timers = keep(entries(saved?.timers, isTimer));
    return states;
  }

  counter(id: string): number {
    return this.store.state.counters[id] ?? 0;
  }

  setCounter(id: string, value: number): void {
    this.store.state.counters[id] = value;
    this.changed();
  }

  /** Whether the toggle is on (its first action ran last). */
  toggle(id: string): boolean {
    return this.store.state.toggles[id] ?? false;
  }

  setToggle(id: string, on: boolean): void {
    if (on) this.store.state.toggles[id] = true;
    else delete this.store.state.toggles[id];
    this.changed();
  }

  timer(id: string): TimerState | undefined {
    return this.store.state.timers[id];
  }

  setTimer(id: string, timer: TimerState): void {
    this.store.state.timers[id] = timer;
    this.changed();
  }

  /** Write any pending change now (e.g. before the server stops). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.save();
    }
    await this.saving;
  }

  private changed(): void {
    this.store.changed();
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, SAVE_DELAY_MS);
  }

  private save(): void {
    const { counters, toggles, timers } = this.store.state;
    const snapshot = structuredClone({ counters, toggles, timers });
    this.saving = this.saving
      .then(() => writeJsonAtomic(this.path, snapshot))
      .catch((err) => this.log.warn(`Could not save button-state.json: ${errorMessage(err)}`));
  }
}
