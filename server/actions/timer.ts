// The timer family: a countdown or stopwatch per Timer button (ButtonStates). The clock itself is just
// a start time, so the browsers work out what to show; TimerTexts keeps OBS text sources up to date.
import { buttonTimer, timerDefinition } from '../../shared/deck-utils.ts';
import type { Deck } from '../../shared/schema.ts';
import { nextTimerState, timerReading, timerText } from '../../shared/timers.ts';
import type { ButtonStates } from '../button-state.ts';
import { errorMessage, type Logger } from '../log.ts';
import { ActionError, needButton, type Executor } from './executor.ts';
import type { TextSetter } from './obs.ts';

const TICK_MS = 200;

export interface TimerDeps {
  states: Pick<ButtonStates, 'timer' | 'setTimer'>;
  getDeck: () => Deck;
  /** Told after every change, to update OBS text sources. */
  texts: Pick<TimerTexts, 'update'>;
  now?: () => number;
}

export function timerExecutor(deps: TimerDeps): Executor<'timer'> {
  return async (action, _phase, ctx) => {
    const id = action.target ?? needButton(ctx).buttonId;
    const definition = timerDefinition(deps.getDeck(), id);
    if (action.target && !definition) throw new ActionError('The timer this button controls no longer exists');
    const now = deps.now?.() ?? Date.now();
    const durationSec = (definition ?? action).durationSec;
    deps.states.setTimer(id, nextTimerState(action.mode, deps.states.timer(id), now, durationSec));
    deps.texts.update();
  };
}

export interface TimerTextsDeps {
  getDeck: () => Deck;
  states: Pick<ButtonStates, 'timer'>;
  setText: TextSetter;
  log: Logger;
  now?: () => number;
}

/**
 * Writes Timer buttons' time into their OBS text sources: after each change, and every second while
 * one runs. Only changed text is sent.
 */
export class TimerTexts {
  /** What each text source was last set to. */
  private readonly written = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private readonly deps: TimerTextsDeps;

  constructor(deps: TimerTextsDeps) {
    this.deps = deps;
  }

  update(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = this.deps.now?.() ?? Date.now();
    let ticking = false;
    for (const page of this.deps.getDeck().pages) {
      for (const button of Object.values(page.buttons)) {
        const timer = buttonTimer(button);
        const source = timer?.textSource;
        if (!timer || !source?.name) continue;
        const state = this.deps.states.timer(button.id);
        if (timerReading(timer, state, now).running) ticking = true;
        const text = timerText(timer, state, now);
        if (this.written.get(source.name) === text) continue;
        this.written.set(source.name, text);
        this.deps.setText(source, text).catch((err) => {
          this.written.delete(source.name); // try again on the next tick or change
          this.deps.log.debug(`Timer text for “${source.name}” not written: ${errorMessage(err)}`);
        });
      }
    }
    if (ticking) this.timer = setTimeout(() => this.update(), TICK_MS);
  }

  /** OBS (re)connected: write every timer's text again. */
  resync(): void {
    this.written.clear();
    this.update();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
