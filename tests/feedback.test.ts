import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLORS, missingFields } from '../shared/actions-meta.ts';
import { buttonVisual } from '../shared/feedback.ts';
import { emptyObsState, type ObsState } from '../shared/obs-types.ts';
import type { Button, Deck } from '../shared/schema.ts';

const deck: Deck = { version: 1, revision: 0, homePageId: 'p', pages: [{ id: 'p', name: 'Main', rows: 1, cols: 1, buttons: {} }] };

function obs(): ObsState {
  const s = emptyObsState('connected');
  s.scenes = [{ name: 'Game', uuid: 'u1' }, { name: 'Chat', uuid: 'u2' }];
  s.programScene = 'Game';
  s.inputs = { Mic: { name: 'Mic', kind: 'k', audio: true, muted: true, volumeMul: 0.125, volumeDb: -18 } };
  return s;
}

const visual = (button: Button, s = obs(), now = 0) => buttonVisual(button, { obs: s, deck, now });

test('scene buttons: red ring on program, green ring on preview, found by uuid after rename', () => {
  assert.equal(visual({ id: 'a', tap: { type: 'obs.scene', scene: { name: 'Game' }, target: 'auto' } }).ring, 'program');
  const s = obs();
  s.studioMode = true;
  s.previewScene = 'Chat';
  const renamed = visual({ id: 'b', tap: { type: 'obs.scene', scene: { name: 'Old name', uuid: 'u2' }, target: 'auto' } }, s);
  assert.equal(renamed.ring, 'preview');
  assert.equal(renamed.label, 'Chat', 'auto label follows the rename');
  assert.equal(visual({ id: 'c', tap: { type: 'obs.scene', scene: { name: 'Nope' }, target: 'auto' } }).missing, true);
});

test('OBS actions look offline while disconnected; navigation does not', () => {
  const s = emptyObsState('disconnected');
  assert.equal(visual({ id: 'a', tap: { type: 'obs.stream', mode: 'toggle' } }, s).offline, true);
  assert.equal(visual({ id: 'b', tap: { type: 'deck.back' } }, s).offline, undefined);
});

test('mute: active when muted, uses the action’s active icon and color', () => {
  const v = visual({ id: 'a', tap: { type: 'obs.mute', input: { name: 'Mic' }, mode: 'toggle' } });
  assert.equal(v.active, true);
  assert.deepEqual(v.icon, { set: 'mdi', name: 'microphone-off' });
  assert.equal(v.bg, COLORS.red);
  const ptt = visual({ id: 'b', tap: { type: 'obs.mute', input: { name: 'Mic' }, mode: 'pushToTalk' } });
  assert.equal(ptt.active, false, 'push-to-talk lights up while talking (unmuted)');
});

test('custom icon and colors win over the action defaults', () => {
  const v = visual({
    id: 'a',
    label: 'My mic',
    icon: { emoji: '🎙️' },
    bg: '#112233',
    active: { bg: '#445566' },
    tap: { type: 'obs.mute', input: { name: 'Mic' }, mode: 'toggle' },
  });
  assert.deepEqual(v.icon, { emoji: '🎙️' });
  assert.equal(v.bg, '#445566');
  assert.equal(v.label, 'My mic');
});

test('stream and record badges run a clock from the last sample', () => {
  const s = obs();
  s.stream = { state: 'started', durationMs: 3_600_000, sampledAt: 1000 };
  assert.equal(visual({ id: 'a', tap: { type: 'obs.stream', mode: 'toggle' } }, s, 6000).badge, 'LIVE 1:00:05');
  s.record = { state: 'started', durationMs: 65_000, sampledAt: 1000, paused: true };
  const rec = visual({ id: 'b', tap: { type: 'obs.record', mode: 'toggle' } }, s, 99_000);
  assert.equal(rec.badge, 'PAUSED 01:05', 'a paused clock does not advance');
  s.stream.state = 'starting';
  assert.equal(visual({ id: 'c', tap: { type: 'obs.stream', mode: 'toggle' } }, s).busy, true);
});

test('volume fader reports its position with the cubic taper', () => {
  const v = visual({ id: 'a', tap: { type: 'obs.volume', input: { name: 'Mic' } } });
  assert.equal(v.fader?.pos, 0.5);
  assert.equal(v.fader?.muted, true);
});

test('missingFields lists required fields that are still empty', () => {
  assert.deepEqual(missingFields({ type: 'obs.scene', scene: { name: '' }, target: 'auto' }), ['Scene']);
  assert.deepEqual(missingFields({ type: 'obs.transition' }), []);
  assert.deepEqual(missingFields({ type: 'obs.filter', source: { name: 'Mic' }, filter: '', mode: 'toggle' }), ['Filter']);
});

test('the editor can preview the normal and active look of a scene button', () => {
  const button: Button = { id: 'a', tap: { type: 'obs.scene', scene: { name: 'Game' }, target: 'auto' } };
  const ctx = { obs: obs(), deck, now: 0 };
  assert.equal(buttonVisual(button, ctx).ring, 'program', 'live state: Game is on program');
  assert.equal(buttonVisual(button, ctx, { forceActive: false }).ring, undefined);
  const other: Button = { id: 'b', tap: { type: 'obs.scene', scene: { name: 'Chat' }, target: 'auto' } };
  assert.equal(buttonVisual(other, ctx, { forceActive: true }).ring, 'program');
});
