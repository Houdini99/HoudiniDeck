// The macro family: several actions in a row, with pauses. Steps run through the same executors
// as buttons do; the schema keeps macros and page navigation out of the steps.
import type { Action } from '../../shared/schema.ts';
import { errorMessage, type Logger } from '../log.ts';
import { ActionError, type ActionCtx, type Executor, type Phase } from './executor.ts';

export interface MacroDeps {
  run: (action: Action, phase: Phase, ctx?: ActionCtx) => Promise<void>;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function macroExecutor(deps: MacroDeps): Executor<'macro'> {
  const sleep = deps.sleep ?? wait;
  /** Macros in progress (the deck's action objects), so a second tap doesn't start a second run. */
  const running = new WeakSet<object>();

  return async (macro, _phase, ctx) => {
    if (running.has(macro)) throw new ActionError('This macro is still running');
    running.add(macro);
    const failed: string[] = [];
    try {
      for (const [i, step] of macro.steps.entries()) {
        if ('delayMs' in step) {
          await sleep(step.delayMs);
          continue;
        }
        try {
          await deps.run(step.action, { kind: 'press' }, ctx);
        } catch (err) {
          if (!(err instanceof ActionError)) deps.log.error(`Macro step ${i + 1} failed:`, err);
          const why = err instanceof ActionError ? err.message : 'something went wrong';
          if (macro.stopOnError) throw new ActionError(`Step ${i + 1}: ${why}`);
          failed.push(`step ${i + 1}: ${why}`);
          deps.log.debug(`Macro step ${i + 1} failed, continuing: ${errorMessage(err)}`);
        }
      }
    } finally {
      running.delete(macro);
    }
    if (failed.length) throw new ActionError(`Some steps failed (${failed.join('; ')})`);
  };
}
