// Toggle, Counter and Timer buttons: their executors, the saved state, and the timers' OBS text.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { counterExecutor } from '../server/actions/counter.ts';
import { ActionError, type ActionCtx, type Phase } from '../server/actions/executor.ts';
import { TimerTexts, timerExecutor } from '../server/actions/timer.ts';
import { toggleExecutor } from '../server/actions/toggle.ts';
import { ButtonStates } from '../server/button-state.ts';
import { ExtStore } from '../server/ext-store.ts';
import { silentLogger } from '../server/log.ts';
import type { Action, ActionOf, Deck, ObsRef } from '../shared/schema.ts';
import { nextTimerState, timerReading, timerText } from '../shared/timers.ts';
import { memoryStates, tempDir, waitFor } from './helpers.ts';

const press: Phase = { kind: 'press' };
const on = (buttonId: string): ActionCtx => ({ pageId: 'p', buttonId });

function deckWith(buttons: Deck['pages'][number]['buttons']): Deck {
  return { version: 1, revision: 0, homePageId: 'p', pages: [{ id: 'p', name: 'P', rows: 3, cols: 5, buttons }] };
}

test('a toggle runs its sides in turn, lights up in between, and only flips when the side worked', async () => {
  const states = memoryStates();
  const ran: string[] = [];
  let fail = false;
  const run = async (action: Action, _phase: Phase, ctx?: ActionCtx) => {
    ran.push(`${action.type}@${ctx?.buttonId}`);
    if (fail) throw new ActionError('Nope');
  };
  const execute = toggleExecutor({ run, states });
  const toggle: ActionOf<'toggle'> = { type: 'toggle', on: { type: 'obs.stream', mode: 'start' }, off: { type: 'obs.stream', mode: 'stop' } };

  await execute(toggle, press, on('t'));
  assert.equal(states.toggle('t'), true, 'on after the first press');
  assert.deepEqual(ran, ['obs.stream@t'], 'the side runs for the toggle’s own button');
  await execute({ ...toggle, off: { type: 'obs.record', mode: 'stop' } }, press, on('t'));
  assert.equal(states.toggle('t'), false);
  assert.equal(ran[1], 'obs.record@t', 'the second press runs the other side');

  fail = true;
  await assert.rejects(execute(toggle, press, on('t')), /Nope/);
  assert.equal(states.toggle('t'), false, 'a failed side leaves it off, so the next press tries again');
  assert.equal(states.toggle('other'), false, 'each button has its own state');
});

test('a toggle refuses a second press while its side still runs', async () => {
  let release!: () => void;
  const run = () => new Promise<void>((resolve) => (release = resolve));
  const execute = toggleExecutor({ run, states: memoryStates() });
  const toggle: ActionOf<'toggle'> = { type: 'toggle', on: { type: 'obs.stream', mode: 'start' }, off: { type: 'obs.stream', mode: 'stop' } };
  const first = execute(toggle, press, on('t'));
  await assert.rejects(execute(toggle, press, on('t')), /Still busy/);
  release();
  await first;
});

test('counters add, subtract and reset, per button or for another counter button', async () => {
  const states = memoryStates();
  const deck = deckWith({
    '0-0': { id: 'deaths', tap: { type: 'counter', mode: 'add' } },
    '0-1': { id: 'minus', tap: { type: 'counter', mode: 'add', step: -1, target: 'deaths' } },
  });
  const execute = counterExecutor({ states, getDeck: () => deck, setText: async () => assert.fail('no text source') });
  await execute({ type: 'counter', mode: 'add' }, press, on('deaths'));
  await execute({ type: 'counter', mode: 'add', step: 5 }, press, on('deaths'));
  assert.equal(states.counter('deaths'), 6);
  await execute({ type: 'counter', mode: 'add', step: -1, target: 'deaths' }, press, on('minus'));
  assert.equal(states.counter('deaths'), 5, 'a button pointing at another counter changes that one');
  assert.equal(states.counter('minus'), 0);
  await execute({ type: 'counter', mode: 'set' }, press, on('deaths'));
  assert.equal(states.counter('deaths'), 0, 'set without a value resets to 0');
  await execute({ type: 'counter', mode: 'set', value: -3 }, press, on('deaths'));
  assert.equal(states.counter('deaths'), -3);
  await assert.rejects(
    execute({ type: 'counter', mode: 'add', target: 'gone' }, press, on('minus')),
    (err: Error) => err instanceof ActionError && /no longer exists/.test(err.message),
  );
});

test('a counter writes its count into the OBS text source its button names, and says when it can’t', async () => {
  const states = memoryStates();
  const source: ObsRef = { name: 'Death Text' };
  const deck = deckWith({
    '0-0': {
      id: 'deaths',
      tap: { type: 'counter', mode: 'add', textSource: source, textFormat: 'Deaths: {n}' },
      longPress: { type: 'counter', mode: 'set' },
    },
    '0-1': { id: 'minus', tap: { type: 'counter', mode: 'add', step: -1, target: 'deaths' } },
  });
  const written: string[] = [];
  let obsUp = true;
  const setText = async (ref: ObsRef, text: string) => {
    if (!obsUp) throw new ActionError('OBS is not connected');
    written.push(`${ref.name}=${text}`);
  };
  const execute = counterExecutor({ states, getDeck: () => deck, setText });
  await execute({ type: 'counter', mode: 'add' }, press, on('deaths'));
  await execute({ type: 'counter', mode: 'add', step: 2 }, press, on('deaths'));
  await execute({ type: 'counter', mode: 'add', step: -1, target: 'deaths' }, press, on('minus'));
  await execute({ type: 'counter', mode: 'set' }, press, on('deaths'));
  assert.deepEqual(written, ['Death Text=Deaths: 1', 'Death Text=Deaths: 3', 'Death Text=Deaths: 2', 'Death Text=Deaths: 0']);

  obsUp = false;
  await assert.rejects(
    execute({ type: 'counter', mode: 'add' }, press, on('deaths')),
    (err: Error) => err instanceof ActionError && err.message === 'Counted 1, but the OBS text didn’t change: OBS is not connected',
  );
  assert.equal(states.counter('deaths'), 1, 'the count still changed');
});

test('timers: start, pause, resume, reset and restart; a finished countdown resets on the next tap', () => {
  let s = nextTimerState('toggle', undefined, 1000);
  assert.deepEqual(s, { elapsedMs: 0, startedAt: 1000 }, 'start');
  s = nextTimerState('toggle', s, 4000);
  assert.deepEqual(s, { elapsedMs: 3000 }, 'pause keeps what it counted');
  s = nextTimerState('toggle', s, 10_000);
  assert.deepEqual(s, { elapsedMs: 3000, startedAt: 10_000 }, 'resume');
  assert.deepEqual(nextTimerState('reset', s, 11_000), { elapsedMs: 0 });
  assert.deepEqual(nextTimerState('restart', s, 11_000), { elapsedMs: 0, startedAt: 11_000 });
  assert.deepEqual(nextTimerState('toggle', { elapsedMs: 0, startedAt: 0 }, 61_000, 60), { elapsedMs: 0 }, 'done: the tap silences it');

  const countdown = { durationSec: 300 };
  assert.deepEqual(timerReading(countdown, undefined, 0), { seconds: 300, running: false, done: false, left: 1 });
  const running = timerReading(countdown, { elapsedMs: 0, startedAt: 0 }, 1500);
  assert.equal(running.seconds, 299, 'counts down in whole seconds, rounded up');
  assert.equal(running.running, true);
  const done = timerReading(countdown, { elapsedMs: 0, startedAt: 0 }, 400_000);
  assert.deepEqual(done, { seconds: 0, running: false, done: true, left: 0 });
  assert.equal(timerReading({}, { elapsedMs: 59_999 }, 0).seconds, 59, 'a stopwatch counts up, rounded down');

  assert.equal(timerText({ durationSec: 300, textFormat: 'Starting in {time}' }, undefined, 0), 'Starting in 5:00');
  assert.equal(timerText({ durationSec: 60, doneText: 'Live now!' }, { elapsedMs: 60_000 }, 0), 'Live now!');
  assert.equal(timerText({ durationSec: 60 }, { elapsedMs: 60_000 }, 0), '0:00');
  assert.equal(timerText({}, { elapsedMs: 3_723_000 }, 0), '1:02:03');
});

test('the timer executor controls a button’s own timer or another one, with that one’s countdown', async () => {
  const states = memoryStates();
  const deck = deckWith({
    '0-0': { id: 'brb', tap: { type: 'timer', mode: 'toggle', durationSec: 60 }, longPress: { type: 'timer', mode: 'reset' } },
    '0-1': { id: 'macro', tap: { type: 'timer', mode: 'restart', target: 'brb' } },
  });
  let now = 1000;
  let updates = 0;
  const execute = timerExecutor({ states, getDeck: () => deck, texts: { update: () => void updates++ }, now: () => now });
  await execute({ type: 'timer', mode: 'toggle', durationSec: 60 }, press, on('brb'));
  assert.deepEqual(states.timer('brb'), { elapsedMs: 0, startedAt: 1000 });
  now = 70_000;
  await execute({ type: 'timer', mode: 'toggle', target: 'brb' }, press, on('macro'));
  assert.deepEqual(states.timer('brb'), { elapsedMs: 0 }, 'uses brb’s 60 s: it was done, so the tap reset it');
  await execute({ type: 'timer', mode: 'restart', target: 'brb' }, press, on('macro'));
  assert.deepEqual(states.timer('brb'), { elapsedMs: 0, startedAt: 70_000 });
  assert.equal(states.timer('macro'), undefined);
  assert.equal(updates, 3, 'OBS texts are updated after each change');
  await assert.rejects(execute({ type: 'timer', mode: 'toggle', target: 'nope' }, press, on('macro')), /no longer exists/);
});

test('timer texts: written on change, every second while running, only when different, and again after OBS reconnects', async () => {
  const states = memoryStates();
  const deck = deckWith({
    '0-0': { id: 'brb', tap: { type: 'timer', mode: 'toggle', durationSec: 3, textSource: { name: 'Countdown' }, doneText: 'Back!' } },
    '0-1': { id: 'plain', tap: { type: 'timer', mode: 'toggle' } },
  });
  const written: string[] = [];
  let now = 0;
  const texts = new TimerTexts({ getDeck: () => deck, states, setText: async (_ref, text) => void written.push(text), log: silentLogger, now: () => now });
  texts.update();
  assert.deepEqual(written, ['0:03'], 'a stopped countdown shows its full time');
  texts.update();
  assert.deepEqual(written, ['0:03'], 'unchanged text isn’t sent again');

  states.setTimer('brb', { elapsedMs: 0, startedAt: 0 });
  now = 1200;
  texts.update();
  assert.deepEqual(written, ['0:03', '0:02']);
  now = 3000;
  await waitFor(() => written.length === 3, 2000, 'the next tick');
  assert.equal(written[2], 'Back!', 'the done text once it ran out');
  texts.resync();
  assert.equal(written.at(-1), 'Back!', 'written again after a reconnect');
  assert.equal(written.length, 4);
  texts.stop();
});

test('button state is saved to button-state.json and read back; junk and deleted buttons are dropped', async (t) => {
  const tmp = await tempDir();
  t.after(tmp.cleanup);
  const deck = deckWith({ '0-0': { id: 'deaths' }, '0-1': { id: 'lights' }, '0-2': { id: 'brb' } });
  const store = new ExtStore();
  const states = await ButtonStates.load(tmp.dir, store, deck, silentLogger);
  states.setCounter('deaths', 12);
  states.setToggle('lights', true);
  states.setTimer('brb', { elapsedMs: 5000, startedAt: 123 });
  states.setToggle('lights', false);
  states.setToggle('lights', true);
  await states.flush();
  const saved: Record<string, Record<string, unknown>> = JSON.parse(await readFile(join(tmp.dir, 'button-state.json'), 'utf8'));
  assert.deepEqual(saved, { counters: { deaths: 12 }, toggles: { lights: true }, timers: { brb: { elapsedMs: 5000, startedAt: 123 } } });

  const edited: Record<string, Record<string, unknown>> = structuredClone(saved);
  edited.counters.gone = 3; // a button that no longer exists
  edited.counters['bad id!'] = 1;
  edited.toggles.brb = 'yes';
  edited.timers.deaths = { elapsedMs: -5 };
  await writeFile(join(tmp.dir, 'button-state.json'), JSON.stringify(edited));
  const again = new ExtStore();
  await ButtonStates.load(tmp.dir, again, deck, silentLogger);
  assert.deepEqual(again.state.counters, { deaths: 12 });
  assert.deepEqual(again.state.toggles, { lights: true });
  assert.deepEqual(again.state.timers, { brb: { elapsedMs: 5000, startedAt: 123 } });

  await writeFile(join(tmp.dir, 'button-state.json'), '{ not json');
  const broken = new ExtStore();
  await ButtonStates.load(tmp.dir, broken, deck, silentLogger);
  assert.deepEqual(broken.state.counters, {}, 'an unreadable file starts from zero');
});
