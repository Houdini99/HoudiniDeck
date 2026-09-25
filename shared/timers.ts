// Timer and Counter logic shared by the server (state changes, OBS text) and the browser (the tiles).
import { timerElapsed, type TimerState } from './ext-types.ts';
import { formatClock } from './format.ts';
import type { ActionOf } from './schema.ts';

type TimerAction = ActionOf<'timer'>;

export interface TimerReading {
  /** Whole seconds to show: left for a countdown (rounded up, so it starts at 5:00), counted for a stopwatch. */
  seconds: number;
  running: boolean;
  /** A countdown that reached zero. */
  done: boolean;
  /** How much of a countdown is left (1 → 0); undefined for a stopwatch. */
  left?: number;
}

/** What a timer shows at `now`. `timer` is the button's definition (see timerDefinition). */
export function timerReading(timer: Pick<TimerAction, 'durationSec'>, state: TimerState | undefined, now: number): TimerReading {
  const elapsed = timerElapsed(state, now);
  const running = state?.startedAt !== undefined;
  if (!timer.durationSec) return { seconds: Math.floor(elapsed / 1000), running, done: false };
  const totalMs = timer.durationSec * 1000;
  const leftMs = Math.max(0, totalMs - elapsed);
  return { seconds: Math.ceil(leftMs / 1000), running: running && leftMs > 0, done: leftMs === 0, left: leftMs / totalMs };
}

/**
 * The timer's state after a press. Start/pause on a countdown that is done resets it (the first tap
 * silences the alarm, the next one starts it again).
 */
export function nextTimerState(mode: TimerAction['mode'], state: TimerState | undefined, now: number, durationSec?: number): TimerState {
  if (mode === 'reset') return { elapsedMs: 0 };
  if (mode === 'restart') return { elapsedMs: 0, startedAt: now };
  const elapsed = timerElapsed(state, now);
  if (durationSec && elapsed >= durationSec * 1000) return { elapsedMs: 0 };
  return state?.startedAt === undefined ? { elapsedMs: elapsed, startedAt: now } : { elapsedMs: elapsed };
}

/** The text a timer writes into its OBS text source. */
export function timerText(timer: Pick<TimerAction, 'durationSec' | 'textFormat' | 'doneText'>, state: TimerState | undefined, now: number): string {
  const reading = timerReading(timer, state, now);
  if (reading.done && timer.doneText) return timer.doneText;
  return (timer.textFormat || '{time}').replaceAll('{time}', formatClock(reading.seconds));
}

/** The text a counter writes into its OBS text source. */
export function counterText(format: string | undefined, count: number): string {
  return (format || '{n}').replaceAll('{n}', String(count));
}

export const COUNTER_LIMIT = 1_000_000_000;

/** A counter after a press (kept within ±1,000,000,000). */
export function nextCount(action: Pick<ActionOf<'counter'>, 'mode' | 'step' | 'value'>, current: number): number {
  const next = action.mode === 'set' ? (action.value ?? 0) : current + (action.step ?? 1);
  return Math.min(COUNTER_LIMIT, Math.max(-COUNTER_LIMIT, next));
}
