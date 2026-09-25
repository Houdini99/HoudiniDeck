import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLORS, missingFields } from '../shared/actions-meta.ts';
import { emptyExtState, type ExtState, type PlayerInfo } from '../shared/ext-types.ts';
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

const visual = (button: Button, s = obs(), now = 0, ext = emptyExtState()) => buttonVisual(button, { obs: s, deck, ext, now });

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
  const ctx = { obs: obs(), deck, ext: emptyExtState(), now: 0 };
  assert.equal(buttonVisual(button, ctx).ring, 'program', 'live state: Game is on program');
  assert.equal(buttonVisual(button, ctx, { forceActive: false }).ring, undefined);
  const other: Button = { id: 'b', tap: { type: 'obs.scene', scene: { name: 'Chat' }, target: 'auto' } };
  assert.equal(buttonVisual(other, ctx, { forceActive: true }).ring, 'program');
});

function withPlayers(players: Record<string, PlayerInfo | null>, available = true): ExtState {
  return { media: { available, players }, audio: { available: true } };
}

const song: PlayerInfo = { instance: 'spotify', status: 'Playing', artist: 'Daft Punk', title: 'One More Time', art: 'https://i.scdn.co/image/x' };

test('media keys: dim without a player, pause icon while playing, song and art when asked', () => {
  const playPause: Button = { id: 'm', tap: { type: 'media.player', command: 'playPause' } };
  assert.equal(visual(playPause).disabled, true, 'no player known yet');
  assert.equal(visual(playPause, obs(), 0, withPlayers({ '': null })).disabled, true, 'no player running');
  assert.equal(visual(playPause, obs(), 0, withPlayers({ '': song }, false)).disabled, true, 'playerctl missing');

  const playing = visual(playPause, obs(), 0, withPlayers({ '': song }));
  assert.equal(playing.active, true);
  assert.deepEqual(playing.icon, { set: 'mdi', name: 'pause' });
  assert.equal(playing.label, 'Play/Pause');
  assert.equal(playing.image, undefined, 'no art unless the button asks for it');

  const nowPlaying: Button = { id: 'n', tap: { type: 'media.player', command: 'playPause', nowPlaying: true } };
  const shown = visual(nowPlaying, obs(), 0, withPlayers({ '': song }));
  assert.equal(shown.label, 'One More Time');
  assert.equal(shown.image, 'https://i.scdn.co/image/x');
  assert.equal(shown.badge, undefined);
  const paused = visual(nowPlaying, obs(), 0, withPlayers({ '': { ...song, status: 'Paused' } }));
  assert.equal(paused.active, false);
  assert.equal(paused.badge, 'PAUSED');
  assert.deepEqual(visual({ ...nowPlaying, icon: { emoji: '🎵' } }, obs(), 0, withPlayers({ '': song })).image, undefined, 'a chosen icon wins');

  const next = visual({ id: 'x', tap: { type: 'media.player', command: 'next' } }, obs(), 0, withPlayers({ '': song }));
  assert.equal(next.active, false, 'only play/pause lights up');
  assert.deepEqual(next.icon, { set: 'mdi', name: 'skip-next' });
});

test('media keys for a named player follow that player', () => {
  const spotify: Button = { id: 's', tap: { type: 'media.player', command: 'playPause', player: 'spotify', nowPlaying: true } };
  const firefox: PlayerInfo = { instance: 'firefox.instance_1', status: 'Paused', artist: '', title: 'A video', art: undefined };
  const v = visual(spotify, obs(), 0, withPlayers({ '': firefox, spotify: song }));
  assert.equal(v.active, true);
  assert.equal(v.label, 'One More Time');
  assert.equal(visual(spotify, obs(), 0, withPlayers({ '': firefox, spotify: null })).disabled, true);
});

test('player names can’t pass for command-line options', async () => {
  const { ActionSchema } = await import('../shared/schema.ts');
  const parse = (player: string) => ActionSchema.safeParse({ type: 'media.player', command: 'next', player }).success;
  assert.equal(parse('spotify'), true);
  assert.equal(parse('firefox.instance_12'), true);
  assert.equal(parse('--list-all'), false);
  assert.equal(parse('-p'), false);
  assert.equal(parse('spotify,%any'), false);
});

test('checkboxes are never "missing"', () => {
  assert.deepEqual(missingFields({ type: 'media.player', command: 'next' }), []);
});
