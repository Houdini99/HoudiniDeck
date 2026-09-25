// The toggle family: two actions taking turns. The first press runs `on` and the button lights up;
// the next runs `off`. Which one is next is kept per button (ButtonStates), so every device agrees.
import type { Action } from '../../shared/schema.ts';
import type { ButtonStates } from '../button-state.ts';
import { ActionError, needButton, type ActionCtx, type Executor, type Phase } from './executor.ts';

export interface ToggleDeps {
  /** Runs a side through the executor registry (a macro side runs its steps). */
  run: (action: Action, phase: Phase, ctx?: ActionCtx) => Promise<void>;
  states: Pick<ButtonStates, 'toggle' | 'setToggle'>;
}

export function toggleExecutor(deps: ToggleDeps): Executor<'toggle'> {
  /** Buttons whose side is still running, so a quick second press doesn't run the same side twice. */
  const busy = new Set<string>();

  return async (action, _phase, ctx) => {
    const { buttonId } = needButton(ctx);
    if (busy.has(buttonId)) throw new ActionError('Still busy with the last press');
    busy.add(buttonId);
    try {
      const on = deps.states.toggle(buttonId);
      // Only a side that worked flips the button, so a failed "on" can simply be pressed again.
      await deps.run(on ? action.off : action.on, { kind: 'press' }, ctx);
      deps.states.setToggle(buttonId, !on);
    } finally {
      busy.delete(buttonId);
    }
  };
}
