// Macros: steps in order, pauses, failures, and which steps the schema allows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionError } from '../server/actions/executor.ts';
import { macroExecutor } from '../server/actions/macro.ts';
import { silentLogger } from '../server/log.ts';
import { missingFields } from '../shared/actions-meta.ts';
import { ActionSchema, type Action, type ActionOf, type MacroStep } from '../shared/schema.ts';

type Macro = ActionOf<'macro'>;

const scene: Action = { type: 'obs.scene', scene: { name: 'BRB' }, target: 'auto' };
const record: Action = { type: 'obs.record', mode: 'start' };
const hook: Action = { type: 'http.request', method: 'POST', url: 'http://hass.local/x' };

function setup(failOn?: (action: Action) => Error | undefined) {
  const log: string[] = [];
  const execute = macroExecutor({
    run: async (action, phase) => {
      log.push(`${action.type}:${phase.kind}`);
      const err = failOn?.(action);
      if (err) throw err;
    },
    sleep: async (ms) => void log.push(`sleep:${ms}`),
    log: silentLogger,
  });
  const run = (macro: Macro) => execute(macro, { kind: 'press' });
  return { log, run };
}

const macro = (steps: MacroStep[], stopOnError = true): Macro => ({ type: 'macro', steps, stopOnError });

test('steps run in order as presses, with the pauses in between', async () => {
  const { log, run } = setup();
  await run(macro([{ action: scene }, { delayMs: 300 }, { action: record }]));
  assert.deepEqual(log, ['obs.scene:press', 'sleep:300', 'obs.record:press']);
});

test('by default a failed step stops the macro and names the step', async () => {
  const { log, run } = setup((a) => (a.type === 'http.request' ? new ActionError('Webhook to hass.local failed: 500') : undefined));
  await assert.rejects(
    run(macro([{ action: scene }, { action: hook }, { action: record }])),
    (err: Error) => err instanceof ActionError && err.message === 'Step 2: Webhook to hass.local failed: 500',
  );
  assert.deepEqual(log, ['obs.scene:press', 'http.request:press']);
});

test('without stopOnError the other steps still run, and failures are reported at the end', async () => {
  const { log, run } = setup((a) => (a.type === 'http.request' ? new ActionError('nope') : a.type === 'obs.record' ? new Error('bug') : undefined));
  await assert.rejects(
    run(macro([{ action: hook }, { action: scene }, { action: record }], false)),
    (err: Error) => err instanceof ActionError && err.message === 'Some steps failed (step 1: nope; step 3: something went wrong)',
  );
  assert.deepEqual(log, ['http.request:press', 'obs.scene:press', 'obs.record:press']);
});

test('a second tap while the macro runs is refused; afterwards it runs again', async () => {
  let release!: () => void;
  const execute = macroExecutor({
    run: async () => {},
    sleep: () => new Promise<void>((resolve) => (release = resolve)),
    log: silentLogger,
  });
  const slow = macro([{ delayMs: 1000 }, { action: scene }]);
  const first = execute(slow, { kind: 'press' });
  await assert.rejects(execute(slow, { kind: 'press' }), /still running/);
  release();
  await first;
  const again = execute(slow, { kind: 'press' });
  release();
  await again;
});

test('the schema keeps macros, navigation, holds and faders out of the steps', () => {
  const ok = (steps: unknown[]) => ActionSchema.safeParse({ type: 'macro', steps }).success;
  assert.equal(ok([{ action: scene }, { delayMs: 500 }, { action: record }]), true);
  assert.equal(ok([]), false, 'at least one step');
  assert.equal(ok(Array.from({ length: 21 }, () => ({ delayMs: 1 }))), false, 'at most 20 steps');
  assert.equal(ok([{ action: { type: 'macro', steps: [{ delayMs: 1 }] } }]), false, 'no macros in macros');
  assert.equal(ok([{ action: { type: 'deck.back' } }]), false, 'no navigation');
  assert.equal(ok([{ action: { type: 'obs.mute', input: { name: 'Mic' }, mode: 'pushToTalk' } }]), false, 'no push-to-talk');
  assert.equal(ok([{ action: { type: 'obs.volume', input: { name: 'Mic' } } }]), false, 'no faders');
  assert.equal(ok([{ action: { type: 'system.volume', target: 'output', mode: 'fader' } }]), false, 'no system faders');
  assert.equal(ok([{ delayMs: 60_001 }]), false, 'pauses up to a minute');
  const parsed = ActionSchema.parse({ type: 'macro', steps: [{ delayMs: 1 }] });
  assert.equal(parsed.type === 'macro' && parsed.stopOnError, true, 'stops on errors by default');
});

test('the editor asks for steps, and for what each step is missing', () => {
  assert.deepEqual(missingFields(macro([])), ['Steps']);
  assert.deepEqual(missingFields(macro([{ action: { type: 'obs.scene', scene: { name: '' }, target: 'auto' } }, { delayMs: 5 }, { action: record }])), [
    'step 1 scene',
  ]);
});
