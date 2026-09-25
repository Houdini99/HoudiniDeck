// What every action executor shares. Each family of actions (all types with the same prefix, like
// obs.* or http.*) has one executor; the registry in registry.ts maps prefixes to executors.
import type { Action, ActionType } from '../../shared/schema.ts';

/** An expected failure with a message fit for the person pressing the button. */
export class ActionError extends Error {}

/** How the button was used: a tap, the press or release of a hold button, or a fader position (0..1). */
export type Phase = { kind: 'press' } | { kind: 'hold'; down: boolean } | { kind: 'fader'; pos: number };

/**
 * The button an action runs for; for macro steps and toggle sides, the macro's or toggle's button.
 * Counters, timers, toggles and sounds keep their state per button.
 */
export interface ActionCtx {
  pageId: string;
  buttonId: string;
}

type PrefixOf<T extends string> = T extends `${infer P}.${string}` ? P : T;

/** 'obs' for obs.scene, 'deck' for deck.back, … (a type without a dot is its own family). */
export type ActionPrefix = PrefixOf<ActionType>;

export type ActionOfPrefix<P extends ActionPrefix> = Extract<Action, { type: P | `${P}.${string}` }>;

/** Runs one family of actions. Throw ActionError for failures the user should see. */
export type Executor<P extends ActionPrefix = ActionPrefix> = (action: ActionOfPrefix<P>, phase: Phase, ctx?: ActionCtx) => Promise<void>;

/** A complete map, so adding a family of actions without an executor doesn't compile. */
export type ExecutorRegistry = { [P in ActionPrefix]: Executor<P> };

export function actionPrefix(type: ActionType): ActionPrefix {
  return type.split('.')[0] as ActionPrefix;
}

/** Run an action with the executor for its family. */
export function runAction(registry: ExecutorRegistry, action: Action, phase: Phase, ctx?: ActionCtx): Promise<void> {
  const execute = registry[actionPrefix(action.type)] as Executor;
  return execute(action, phase, ctx);
}

/** The button an action that keeps state per button runs for (tests may leave it out; presses never do). */
export function needButton(ctx: ActionCtx | undefined): ActionCtx {
  if (!ctx) throw new Error('This action needs to know its button');
  return ctx;
}
