// Live scene pictures: taken only for wanted scenes while OBS is connected, and only changes go out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { silentLogger } from '../server/log.ts';
import { SceneThumbnails } from '../server/obs/thumbnails.ts';
import { emptyExtState } from '../shared/ext-types.ts';
import { buttonVisual } from '../shared/feedback.ts';
import { emptyObsState } from '../shared/obs-types.ts';
import type { Button, Deck } from '../shared/schema.ts';
import { waitFor } from './helpers.ts';

function fakeObs() {
  const calls: Record<string, unknown>[] = [];
  let frame = 0;
  const obs = {
    connected: true,
    client: {
      call: async (_type: string, data: Record<string, unknown>) => {
        calls.push(data);
        if (data.sourceName === 'Gone') throw new Error('No source was found');
        // "Static" never changes; "Game" changes every time.
        return { imageData: `data:image/jpg;base64,${data.sourceName === 'Static' ? 'AAAA' : `frame${frame++}`}` };
      },
    },
  };
  return { obs, calls };
}

test('pictures are taken for wanted scenes only, and only new ones are passed on', async (t) => {
  const { obs, calls } = fakeObs();
  const thumbs = new SceneThumbnails({ obs: obs as never, log: silentLogger, intervalMs: 20 });
  t.after(() => thumbs.stop());
  const rounds: Record<string, string>[] = [];
  thumbs.on('images', (changed) => rounds.push(changed));

  thumbs.setWanted(['Static', 'Game', 'Gone', 'Game']);
  await waitFor(() => rounds.length >= 3, 2000, 'three rounds');
  assert.deepEqual(Object.keys(rounds[0]).sort(), ['Game', 'Static']);
  assert.equal(rounds[0].Static, 'data:image/jpeg;base64,AAAA', 'labelled image/jpeg');
  assert.deepEqual(Object.keys(rounds[1]), ['Game'], 'an unchanged picture isn’t sent again');
  assert.deepEqual(calls[0], { sourceName: 'Static', imageFormat: 'jpg', imageWidth: 256, imageCompressionQuality: 70 });
  assert.equal(new Set(calls.map((c) => c.sourceName)).size, 3, 'each scene once per round');

  thumbs.setWanted([]);
  assert.deepEqual(thumbs.images, {}, 'forgotten when no one looks');
  const count = calls.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(calls.length <= count + 3, 'stops asking OBS');

  obs.connected = false;
  thumbs.setWanted(['Game']);
  await new Promise((r) => setTimeout(r, 80));
  const offline = calls.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls.length, offline, 'nothing while OBS is away');
});

test('scene buttons show their live picture when asked to, unless they have an icon of their own', () => {
  const obs = emptyObsState('connected');
  obs.scenes = [{ name: 'Game', uuid: 'g' }];
  obs.programScene = 'Game';
  const deck: Deck = { version: 1, revision: 0, homePageId: 'p', pages: [{ id: 'p', name: 'P', rows: 1, cols: 1, buttons: {} }] };
  const thumbs = { Game: 'data:image/jpeg;base64,AAAA' };
  const look = (button: Button) => buttonVisual(button, { obs, deck, ext: emptyExtState(), now: 0, thumbs });
  const scene = { type: 'obs.scene' as const, scene: { name: 'Game', uuid: 'g' }, target: 'auto' as const };
  assert.equal(look({ id: 'a', tap: { ...scene, preview: true } }).image, thumbs.Game);
  assert.equal(look({ id: 'a', tap: { ...scene, preview: true } }).ring, 'program', 'still ringed');
  assert.equal(look({ id: 'b', tap: scene }).image, undefined);
  assert.equal(look({ id: 'c', icon: { emoji: '🎮' }, tap: { ...scene, preview: true } }).image, undefined);
});
