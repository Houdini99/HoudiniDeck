// The counter family: a number per Counter button (ButtonStates), optionally mirrored into an OBS
// text source, e.g. "Deaths: 12" on stream.
import { counterDefinitions } from '../../shared/deck-utils.ts';
import type { Deck, ObsRef } from '../../shared/schema.ts';
import { counterText, nextCount } from '../../shared/timers.ts';
import type { ButtonStates } from '../button-state.ts';
import { errorMessage } from '../log.ts';
import { ActionError, needButton, type Executor } from './executor.ts';
import type { TextSetter } from './obs.ts';

export interface CounterDeps {
  states: Pick<ButtonStates, 'counter' | 'setCounter'>;
  getDeck: () => Deck;
  setText: TextSetter;
}

export function counterExecutor(deps: CounterDeps): Executor<'counter'> {
  return async (action, _phase, ctx) => {
    const id = action.target ?? needButton(ctx).buttonId;
    const deck = deps.getDeck();
    if (action.target && counterDefinitions(deck, action.target).length === 0) {
      throw new ActionError('The counter this button changes no longer exists');
    }
    const count = nextCount(action, deps.states.counter(id));
    deps.states.setCounter(id, count);
    await showCount(deps, deck, id, count);
  };
}

/** Write the count into the text sources the counter's button names (each once). */
async function showCount(deps: CounterDeps, deck: Deck, id: string, count: number): Promise<void> {
  const done = new Set<string>();
  for (const def of counterDefinitions(deck, id)) {
    const source: ObsRef | undefined = def.textSource?.name ? def.textSource : undefined;
    if (!source || done.has(source.name)) continue;
    done.add(source.name);
    try {
      await deps.setText(source, counterText(def.textFormat, count));
    } catch (err) {
      throw new ActionError(`Counted ${count}, but the OBS text didn’t change: ${errorMessage(err)}`);
    }
  }
}
