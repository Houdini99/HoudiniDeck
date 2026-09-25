// The actions added after Phase 3: how their buttons look, what the schema accepts, the catalog's icons,
// deck edits (undo/redo, copy to a page), and Open Website.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ActionError } from '../server/actions/executor.ts';
import { DeckHistory, opLabel } from '../server/deck/history.ts';
import { OpError, applyOp } from '../server/deck/ops.ts';
import { openUrl, openUrlCommand } from '../server/system/open-url.ts';
import { ACTION_META, ACTION_TYPES, actionIcon, actionActiveIcon, isStepType, missingFields } from '../shared/actions-meta.ts';
import { deckActions } from '../shared/deck-utils.ts';
import { emptyExtState, type ExtState } from '../shared/ext-types.ts';
import { buttonVisual } from '../shared/feedback.ts';
import { formatClock, formatTimeOfDay, parseClock } from '../shared/format.ts';
import { emptyObsState } from '../shared/obs-types.ts';
import { ActionSchema, DeckSchema, type Action, type Button, type Deck, type IconRef } from '../shared/schema.ts';
import { seqId } from './helpers.ts';

function deckWith(buttons: Deck['pages'][number]['buttons'], more: Deck['pages'] = []): Deck {
  return { version: 1, revision: 0, homePageId: 'p', pages: [{ id: 'p', name: 'Main', rows: 3, cols: 5, buttons }, ...more] };
}

const look = (button: Button, deck: Deck, ext: ExtState = emptyExtState(), now = 0, commands = false) =>
  buttonVisual(button, { obs: emptyObsState('connected'), deck, ext, now, commands, platform: 'linux' });

test('a toggle lights up while on, named after its first action', () => {
  const button: Button = { id: 't', tap: { type: 'toggle', on: { type: 'obs.stream', mode: 'start' }, off: { type: 'obs.record', mode: 'stop' } } };
  const deck = deckWith({ '0-0': button });
  const off = look(button, deck);
  assert.equal(off.active, false);
  assert.deepEqual(off.icon, { set: 'mdi', name: 'toggle-switch-off-outline' });
  assert.equal(off.label, 'Go Live', 'labelled after the first action');
  const ext = emptyExtState();
  ext.toggles.t = true;
  const on = look(button, deck, ext);
  assert.equal(on.active, true);
  assert.deepEqual(on.icon, { set: 'mdi', name: 'toggle-switch' });
  assert.equal(on.bg, ACTION_META.toggle.activeBg);
});

test('buttons with a Run Command inside (a toggle side or macro step) are dimmed while commands are off', () => {
  const button: Button = {
    id: 't',
    tap: { type: 'toggle', on: { type: 'macro', steps: [{ action: { type: 'system.command', command: 'x' } }], stopOnError: true }, off: { type: 'obs.stream', mode: 'stop' } },
  };
  const deck = deckWith({ '0-0': button });
  assert.equal(look(button, deck).disabled, true);
  assert.ok(!look(button, deck, emptyExtState(), 0, true).disabled);
  assert.ok(deckActions(deck).some((a) => a.type === 'system.command'), 'deckActions finds it');
});

test('counters show their count, also on buttons that point at them', () => {
  const home: Button = { id: 'deaths', label: 'Deaths', tap: { type: 'counter', mode: 'add' } };
  const minus: Button = { id: 'minus', tap: { type: 'counter', mode: 'add', step: -1, target: 'deaths' } };
  const orphan: Button = { id: 'orphan', tap: { type: 'counter', mode: 'add', target: 'gone' } };
  const deck = deckWith({ '0-0': home, '0-1': minus, '0-2': orphan });
  const ext = emptyExtState();
  ext.counters.deaths = 42;
  assert.equal(look(home, deck, ext).gauge?.text, '42');
  assert.equal(look(home, deck, ext).label, 'Deaths');
  assert.equal(look(minus, deck, ext).gauge?.text, '42');
  assert.equal(look(minus, deck, ext).label, '−1');
  assert.equal(look(orphan, deck, ext).missing, true);
  assert.equal(look({ id: 'new', tap: { type: 'counter', mode: 'add' } }, deck, ext).gauge?.text, '0');
});

test('timers show the time left, light up while running, and flash when done', () => {
  const brb: Button = { id: 'brb', tap: { type: 'timer', mode: 'toggle', durationSec: 300 }, longPress: { type: 'timer', mode: 'reset' } };
  const remote: Button = { id: 'r', tap: { type: 'timer', mode: 'restart', target: 'brb' } };
  const watch: Button = { id: 'w', tap: { type: 'timer', mode: 'toggle' } };
  const deck = deckWith({ '0-0': brb, '0-1': remote, '0-2': watch });
  const ext = emptyExtState();
  assert.deepEqual(look(brb, deck, ext).gauge, { text: '5:00', level: 1, tone: undefined });
  ext.timers.brb = { elapsedMs: 0, startedAt: 0 };
  const running = look(brb, deck, ext, 295_500);
  assert.equal(running.gauge?.text, '0:05');
  assert.equal(running.gauge?.tone, 'warm', 'the last ten seconds');
  assert.equal(running.active, true);
  assert.equal(running.bg, ACTION_META.timer.activeBg);
  assert.equal(look(remote, deck, ext, 295_500).gauge?.text, '0:05', 'a button pointing at it shows the same');
  const done = look(brb, deck, ext, 301_000);
  assert.equal(done.gauge?.text, '0:00');
  assert.equal(done.alert, true);
  assert.equal(done.active, false);
  ext.timers.w = { elapsedMs: 61_000 };
  assert.equal(look(watch, deck, ext).gauge?.text, '1:01');
  assert.equal(look(watch, deck, ext).label, 'Stopwatch');
});

test('clocks show the time of day (and the date); sounds light up while they play', () => {
  const clock: Button = { id: 'c', tap: { type: 'clock', seconds: true } };
  const deck = deckWith({ '0-0': clock });
  const at = new Date(2026, 8, 25, 14, 5, 9).getTime();
  assert.equal(look(clock, deck, emptyExtState(), at).gauge?.text, '14:05:09');
  assert.equal(look(clock, deck, emptyExtState(), at).label, '', 'no label by default');
  assert.ok(look({ id: 'd', tap: { type: 'clock', date: true } }, deck, emptyExtState(), at).gauge?.detail, 'the date under it');
  assert.equal(formatTimeOfDay(new Date(2026, 8, 25, 0, 7), { hour12: true }), '12:07 AM');
  assert.equal(formatTimeOfDay(new Date(2026, 8, 25, 13, 7), { hour12: true }), '1:07 PM');

  const horn: Button = { id: 'h', tap: { type: 'sound.play', sound: 'aaaaaaaaaaaaaaaa.mp3', name: 'Air horn.mp3', mode: 'toggle' } };
  const stop: Button = { id: 's', tap: { type: 'sound.stop' } };
  const ext = emptyExtState();
  assert.equal(look(horn, deck, ext).label, 'Air horn');
  assert.equal(look(stop, deck, ext).active, false);
  ext.sounds = ['h/aaaaaaaaaaaaaaaa.mp3'];
  assert.equal(look(horn, deck, ext).active, true);
  assert.deepEqual(look(horn, deck, ext).icon, { set: 'mdi', name: 'stop' }, 'toggle mode: tap to stop');
  assert.equal(look(stop, deck, ext).active, true, 'Stop All lights up while anything plays');
  assert.equal(buttonVisual(horn, { obs: emptyObsState(), deck, ext, now: 0, platform: 'darwin' }).disabled, true, 'Linux and Windows only');
});

test('durations: typed as m:ss and shown the same way', () => {
  assert.equal(parseClock('5:00'), 300);
  assert.equal(parseClock(' 90 '), 90);
  assert.equal(parseClock('1:30:00'), 5400);
  assert.equal(parseClock('1:2:3:4'), undefined);
  assert.equal(parseClock('abc'), undefined);
  assert.equal(parseClock(''), undefined);
  assert.equal(formatClock(300), '5:00');
  assert.equal(formatClock(59.9), '0:59');
  assert.equal(formatClock(3600), '1:00:00');
});

test('the schema: toggle sides and macro steps can’t hold, drag or just show; sounds need an upload; only web addresses open', () => {
  const ok = (action: unknown) => ActionSchema.safeParse(action).success;
  const toggle = (side: unknown) => ({ type: 'toggle', on: side, off: { type: 'obs.stream', mode: 'stop' } });
  assert.ok(ok(toggle({ type: 'obs.stream', mode: 'start' })));
  assert.ok(ok(toggle({ type: 'macro', steps: [{ action: { type: 'counter', mode: 'add', target: 'x' } }] })), 'a macro side with a counter step');
  assert.ok(!ok(toggle({ type: 'obs.mute', input: { name: 'Mic' }, mode: 'pushToTalk' })), 'no push-to-talk');
  assert.ok(!ok(toggle({ type: 'obs.volume', input: { name: 'Mic' } })), 'no fader');
  assert.ok(!ok(toggle({ type: 'toggle', on: { type: 'obs.stream' }, off: { type: 'obs.stream' } })), 'no toggle in a toggle');
  assert.ok(!ok(toggle({ type: 'deck.back' })), 'no navigation');
  assert.ok(!ok({ type: 'macro', steps: [{ action: { type: 'clock' } }] }), 'a clock is no macro step');
  assert.ok(!ok({ type: 'macro', steps: [{ action: { type: 'system.stats', metric: 'cpu' } }] }), 'a display is no macro step');
  assert.ok(ok({ type: 'macro', steps: [{ action: { type: 'timer', mode: 'restart', target: 'brb' } }, { action: { type: 'sound.play', sound: 'aaaaaaaaaaaaaaaa.wav' } }] }));

  assert.ok(!ok({ type: 'sound.play', sound: '' }), 'a sound needs an upload');
  assert.ok(!ok({ type: 'sound.play', sound: '../../etc/passwd' }));
  assert.ok(!ok({ type: 'sound.play', sound: 'aaaaaaaaaaaaaaaa.png' }), 'not an image');
  assert.ok(!ok({ type: 'sound.play', sound: 'aaaaaaaaaaaaaaaa.mp3', volume: 0 }));
  assert.ok(ok({ type: 'system.openUrl', url: 'https://dashboard.twitch.tv/' }));
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ms-settings:display', 'ftp://x']) {
    assert.ok(!ok({ type: 'system.openUrl', url }), url);
  }
  assert.ok(!ok({ type: 'timer', mode: 'toggle', durationSec: 0 }));
  assert.ok(ok({ type: 'obs.text', input: { name: 'BRB Text' } }), 'no text clears it');
  assert.equal((ActionSchema.parse({ type: 'obs.text', input: { name: 'BRB Text' } }) as { text: string }).text, '');
  assert.ok(ok({ type: 'deck.pageStep', direction: 'previous' }));
  assert.ok(!ok({ type: 'deck.pageStep', direction: 'up' }));
});

test('the editor: step types, required fields inside toggles, and every icon exists', () => {
  assert.equal(isStepType('counter'), true);
  assert.equal(isStepType('sound.play'), true);
  for (const type of ['macro', 'toggle', 'clock', 'system.stats', 'obs.volume', 'deck.pageStep'] as const) assert.equal(isStepType(type), false, type);
  const toggle: Action = { type: 'toggle', on: { type: 'http.request', method: 'POST', url: '' }, off: { type: 'sound.play', sound: '', mode: 'toggle' } };
  assert.deepEqual(missingFields(toggle), ['first press: url', 'next press: sound']);

  const mdi = createRequire(import.meta.url)('@iconify-json/mdi/icons.json') as { icons: Record<string, unknown>; aliases: Record<string, unknown> };
  const icons: IconRef[] = [];
  for (const type of ACTION_TYPES) {
    const action = ACTION_META[type].create() as Action;
    icons.push(actionIcon(action));
    const active = actionActiveIcon(action);
    if (active) icons.push(active);
  }
  const missing = icons.filter((i) => 'set' in i && i.set === 'mdi' && !mdi.icons[i.name] && !mdi.aliases[i.name]);
  assert.deepEqual(missing, []);
});

test('undo and redo walk back and forth through edits; a new edit clears what could be redone', () => {
  const history = new DeckHistory();
  const ctx = { obs: emptyObsState(), newId: seqId, history };
  let deck = deckWith({});
  const step = (op: Parameters<typeof applyOp>[1]) => {
    const result = applyOp(deck, op, ctx);
    const before = deck;
    deck = { ...result.deck, revision: deck.revision + 1 };
    if (result.history === 'undo') history.undone(before);
    else if (result.history === 'redo') history.redone(before);
    else history.record(before, deck, opLabel(op));
  };
  // Functions, not expressions: assertions would narrow values that step() changes.
  const label = (slot: string) => deck.pages[0].buttons[slot]?.label;
  const info = () => history.info;
  assert.throws(() => step({ op: 'deck.undo' }), (err: Error) => err instanceof OpError && err.message === 'There is nothing to undo');

  step({ op: 'button.set', pageId: 'p', slot: '0-0', button: { label: 'A' } });
  step({ op: 'button.set', pageId: 'p', slot: '0-1', button: { label: 'B' } });
  step({ op: 'button.set', pageId: 'p', slot: '0-0', button: null });
  assert.deepEqual(info(), { undo: 'deleted button', redo: undefined });
  step({ op: 'deck.undo' });
  assert.equal(label('0-0'), 'A', 'the deleted button is back');
  assert.deepEqual(info(), { undo: 'button change', redo: 'deleted button' });
  step({ op: 'deck.undo' });
  assert.equal(label('0-1'), undefined);
  step({ op: 'deck.redo' });
  assert.equal(label('0-1'), 'B');
  assert.ok(DeckSchema.safeParse(deck).success);

  step({ op: 'page.move', pageId: 'p', toIndex: 0 }); // changes nothing: not recorded
  assert.deepEqual(info(), { undo: 'button change', redo: 'deleted button' });
  step({ op: 'deck.setHome', pageId: 'p' });
  step({ op: 'button.set', pageId: 'p', slot: '1-1', button: { label: 'C' } });
  assert.equal(info().redo, undefined, 'a new edit ends the redo trail');
});

test('undo can’t bring back a Run Command button while commands are off', () => {
  const history = new DeckHistory();
  const withCommand = deckWith({ '0-0': { id: 'c', tap: { type: 'system.command', command: 'x' } } });
  const without = deckWith({});
  history.record(withCommand, without, 'deleted button');
  assert.throws(() => applyOp(without, { op: 'deck.undo' }, { obs: emptyObsState(), newId: seqId, history, commandsEnabled: false }), /turned off/);
  assert.equal(applyOp(without, { op: 'deck.undo' }, { obs: emptyObsState(), newId: seqId, history, commandsEnabled: true }).history, 'undo');
});

test('toggle sides count as Run Command buttons for the commands-off check', () => {
  const deck = deckWith({});
  const button = { tap: { type: 'toggle' as const, on: { type: 'system.command' as const, command: 'x' }, off: { type: 'obs.stream' as const, mode: 'stop' as const } } };
  assert.throws(() => applyOp(deck, { op: 'button.set', pageId: 'p', slot: '0-0', button }, { obs: emptyObsState(), newId: seqId }), /turned off/);
});

test('a button can be copied to another page', () => {
  const deck = deckWith({ '0-0': { id: 'a', label: 'A', tap: { type: 'counter', mode: 'add' } } }, [
    { id: 'q', name: 'Two', rows: 1, cols: 1, buttons: {} },
  ]);
  const ctx = { obs: emptyObsState(), newId: seqId };
  const result = applyOp(deck, { op: 'button.duplicate', pageId: 'p', slot: '0-0', toPageId: 'q' }, ctx);
  const copy = result.deck.pages[1].buttons['0-0'];
  assert.equal(copy.label, 'A');
  assert.notEqual(copy.id, 'a', 'a new id, so it counts on its own');
  assert.deepEqual(result.data, { slot: '0-0', pageId: 'q' });
  assert.throws(() => applyOp(result.deck, { op: 'button.duplicate', pageId: 'p', slot: '0-0', toPageId: 'q' }, ctx), /“Two” is full/);
});

test('Open Website: xdg-open on Linux, the URL handler on Windows, only http(s), readable failures', async () => {
  assert.deepEqual(openUrlCommand('https://x.test/', 'linux'), { cmd: 'xdg-open', args: ['https://x.test/'] });
  const win = openUrlCommand('https://x.test/?a=1&b=2', 'win32');
  assert.match(win.cmd, /rundll32\.exe$/i);
  assert.deepEqual(win.args, ['url.dll,FileProtocolHandler', 'https://x.test/?a=1&b=2']);

  const launched: string[][] = [];
  const launch = async (cmd: string, args: string[]) => {
    launched.push([cmd, ...args]);
    return 0;
  };
  await openUrl('https://example.com/a b"c', launch, 'linux');
  assert.deepEqual(launched[0], ['xdg-open', 'https://example.com/a%20b%22c'], 'spaces and quotes are encoded');
  await assert.rejects(openUrl('file:///etc/passwd', launch, 'linux'), /Only http/);
  await assert.rejects(openUrl('--help', launch, 'linux'), /Only http/);
  assert.equal(launched.length, 1);

  await assert.rejects(
    openUrl('https://x.test/', async () => 4, 'linux'),
    (err: Error) => err instanceof ActionError && /desktop session/.test(err.message),
  );
  const enoent = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' });
  await assert.rejects(openUrl('https://x.test/', async () => Promise.reject(enoent), 'linux'), /not installed/);
  await openUrl('https://x.test/', async () => null, 'linux'); // still running after a second: fine
});

test('OBS Stats tiles: stream health while live, OBS load always', () => {
  const obs = emptyObsState('connected');
  obs.stats = { cpu: 12.345, memoryMb: 500, fps: 59.94, renderSkipped: 1, renderTotal: 1000, outputSkipped: 30, outputTotal: 1000 };
  const deck = deckWith({});
  const tile = (metric: 'fps' | 'cpu' | 'bitrate' | 'dropped' | 'render' | 'encode') =>
    buttonVisual({ id: metric, tap: { type: 'obs.stats', metric } }, { obs, deck, ext: emptyExtState(), now: 0 });
  assert.equal(tile('fps').gauge?.text, '60');
  assert.equal(tile('fps').label, 'FPS');
  assert.equal(tile('cpu').gauge?.text, '12.3%');
  assert.equal(tile('render').gauge?.text, '0.1%');
  assert.deepEqual(tile('encode').gauge, { text: '3.0%', detail: '30 frames', level: 0.6, tone: 'hot' });
  assert.equal(tile('bitrate').disabled, true, 'dimmed while not live');
  assert.equal(tile('dropped').gauge?.text, '–');

  obs.stream = { state: 'started', durationMs: 0, sampledAt: 0, bitrateKbps: 6012, skippedFrames: 12, totalFrames: 1000, congestion: 0.3 };
  assert.deepEqual(tile('bitrate').gauge, { text: '6.0', detail: 'Mbit/s', tone: 'warm' });
  assert.equal(tile('dropped').gauge?.text, '1.2%');
  assert.equal(tile('dropped').gauge?.tone, 'warm');
  obs.stream.bitrateKbps = 850;
  assert.equal(tile('bitrate').gauge?.text, '850');
  assert.equal(buttonVisual({ id: 'x', tap: { type: 'obs.stats', metric: 'fps' } }, { obs: emptyObsState(), deck, ext: emptyExtState(), now: 0 }).offline, true);
});

test('label position and size reach the look; anything else is refused', () => {
  const v = look({ id: 'x', label: 'Hi', labelPos: 'top', labelSize: 'large' }, deckWith({}));
  assert.deepEqual([v.labelPos, v.labelSize], ['top', 'large']);
  assert.equal(DeckSchema.safeParse(deckWith({ '0-0': { id: 'x', labelPos: 'left' as never } })).success, false);
});

test('a page can be duplicated; counters pointing inside it point at the copies', () => {
  const deck = deckWith({
    '0-0': { id: 'deaths', tap: { type: 'counter', mode: 'add' } },
    '0-1': { id: 'minus', tap: { type: 'macro', steps: [{ action: { type: 'counter', mode: 'add', step: -1, target: 'deaths' } }], stopOnError: true } },
    '0-2': { id: 'far', tap: { type: 'timer', mode: 'restart', target: 'elsewhere' } },
  }, [{ id: 'q', name: 'Other', rows: 1, cols: 1, buttons: { '0-0': { id: 'elsewhere', tap: { type: 'timer', mode: 'toggle' } } } }]);
  const { deck: next, data } = applyOp(deck, { op: 'page.duplicate', pageId: 'p' }, { obs: emptyObsState(), newId: seqId });
  assert.ok(DeckSchema.safeParse(next).success);
  const copy = next.pages[1];
  assert.equal(copy.id, (data as { pageId: string }).pageId);
  assert.equal(copy.name, 'Main copy');
  assert.equal(next.pages[2].id, 'q', 'right after the original');
  const newDeaths = copy.buttons['0-0'].id;
  assert.notEqual(newDeaths, 'deaths');
  const step = (copy.buttons['0-1'].tap as { steps: { action: { target?: string } }[] }).steps[0].action;
  assert.equal(step.target, newDeaths, 'the macro step follows the copied counter');
  assert.equal((copy.buttons['0-2'].tap as { target?: string }).target, 'elsewhere', 'buttons on other pages stay the target');
  assert.equal((deck.pages[0].buttons['0-1'].tap as { steps: { action: { target?: string } }[] }).steps[0].action.target, 'deaths', 'the original is untouched');
});
