// The dispatcher with fake executors: which executor runs, with which phase, and when.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dispatcher } from '../server/actions/dispatch.ts';
import { ActionError, actionPrefix, type ExecutorRegistry, type Phase } from '../server/actions/executor.ts';
import { silentLogger } from '../server/log.ts';
import { ACTION_TYPES } from '../shared/actions-meta.ts';
import type { Action, Deck } from '../shared/schema.ts';

const deck: Deck = {
  version: 1,
  revision: 0,
  homePageId: 'p',
  pages: [
    {
      id: 'p',
      name: 'P',
      rows: 2,
      cols: 3,
      buttons: {
        '0-0': {
          id: 'scene',
          tap: { type: 'obs.scene', scene: { name: 'A' }, target: 'auto' },
          longPress: { type: 'obs.record', mode: 'toggle' },
        },
        '0-1': { id: 'ptt', tap: { type: 'obs.mute', input: { name: 'Mic' }, mode: 'pushToTalk' } },
        '0-2': { id: 'fader', tap: { type: 'obs.volume', input: { name: 'Mic' } } },
        '1-0': { id: 'back', tap: { type: 'deck.back' } },
        '1-1': { id: 'label', label: 'Just a label' },
      },
    },
  ],
};

interface Call {
  family: string;
  type: string;
  phase: Phase;
}

/** A registry whose executors only record their calls (optionally slowly, or failing). */
function setup(opts: { delayMs?: number; fail?: (phase: Phase) => boolean } = {}) {
  const calls: Call[] = [];
  const families = [...new Set(ACTION_TYPES.map(actionPrefix))];
  const executors = Object.fromEntries(
    families.map((family) => [
      family,
      async (action: Action, phase: Phase) => {
        calls.push({ family, type: action.type, phase });
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.fail?.(phase)) throw new ActionError('Failed on purpose');
      },
    ]),
  ) as ExecutorRegistry;
  const dispatcher = new Dispatcher({ executors, getDeck: () => deck, log: silentLogger });
  return { calls, dispatcher };
}

test('presses run the executor of the action’s family', async () => {
  const { calls, dispatcher } = setup();
  await dispatcher.press('p', 'scene', 'tap');
  await dispatcher.press('p', 'scene', 'longPress');
  await dispatcher.press('p', 'back', 'tap');
  assert.deepEqual(
    calls.map((c) => [c.family, c.type, c.phase.kind]),
    [
      ['obs', 'obs.scene', 'press'],
      ['obs', 'obs.record', 'press'],
      ['deck', 'deck.back', 'press'],
    ],
  );
  await assert.rejects(dispatcher.press('p', 'label', 'tap'), (err: Error) => err instanceof ActionError && /no action/.test(err.message));
  await assert.rejects(dispatcher.press('p', 'deleted', 'tap'), (err: Error) => err instanceof ActionError && /no longer exists/.test(err.message));
});

test('a held button is released when its client goes away, even if the press failed', async () => {
  const { calls, dispatcher } = setup({ fail: (phase) => phase.kind === 'hold' && phase.down });
  await assert.rejects(dispatcher.hold('c1', 'p', 'ptt', true), ActionError);
  await dispatcher.hold('c1', 'p', 'ptt', true); // still held: ignored
  await dispatcher.releaseAll('c1');
  await dispatcher.releaseAll('c1'); // nothing left to release
  assert.deepEqual(
    calls.map((c) => c.phase),
    [
      { kind: 'hold', down: true },
      { kind: 'hold', down: false },
    ],
  );
  await assert.rejects(dispatcher.hold('c1', 'p', 'scene', true), /not a hold button/);
});

test('releasing a hold runs once, and only for the client that pressed it', async () => {
  const { calls, dispatcher } = setup();
  await dispatcher.hold('c1', 'p', 'ptt', true);
  await dispatcher.hold('c2', 'p', 'ptt', false); // c2 never pressed it
  await dispatcher.hold('c1', 'p', 'ptt', false);
  await dispatcher.hold('c1', 'p', 'ptt', false);
  assert.deepEqual(
    calls.map((c) => c.phase),
    [
      { kind: 'hold', down: true },
      { kind: 'hold', down: false },
    ],
  );
});

test('fader moves collapse to the newest position while one is in flight', async () => {
  const { calls, dispatcher } = setup({ delayMs: 20 });
  await Promise.all([0.1, 0.2, 0.3, 0.9].map((pos) => dispatcher.fader('p', 'fader', pos)));
  assert.deepEqual(
    calls.map((c) => c.phase),
    [
      { kind: 'fader', pos: 0.1 },
      { kind: 'fader', pos: 0.9 },
    ],
  );
  await assert.rejects(dispatcher.fader('p', 'scene', 0.5), /not a fader/);
});
