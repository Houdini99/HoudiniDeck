import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpError, applyOp } from '../server/deck/ops.ts';
import { emptyObsState } from '../shared/obs-types.ts';
import { DeckSchema, type Deck } from '../shared/schema.ts';
import { seqId } from './helpers.ts';

const ctx = { obs: emptyObsState(), newId: seqId };

function deck(): Deck {
  return {
    version: 1,
    revision: 3,
    homePageId: 'p1',
    pages: [
      { id: 'p1', name: 'Main', rows: 3, cols: 5, buttons: { '0-0': { id: 'a', label: 'A' }, '0-1': { id: 'b', label: 'B' } } },
      { id: 'p2', name: 'Two', rows: 2, cols: 2, buttons: { '0-0': { id: 'c', label: 'C' } } },
    ],
  };
}

const valid = (d: Deck) => assert.ok(DeckSchema.safeParse(d).success, 'result should be a valid deck');

test('button.set adds, replaces and deletes', () => {
  let d = applyOp(deck(), { op: 'button.set', pageId: 'p1', slot: '1-1', button: { label: 'New' } }, ctx).deck;
  const added = d.pages[0].buttons['1-1'];
  assert.equal(added.label, 'New');
  assert.ok(added.id, 'a new button gets an id');

  d = applyOp(d, { op: 'button.set', pageId: 'p1', slot: '1-1', button: { ...added, label: 'Renamed' } }, ctx).deck;
  assert.equal(d.pages[0].buttons['1-1'].id, added.id, 're-saving keeps the id');
  assert.equal(d.pages[0].buttons['1-1'].label, 'Renamed');

  d = applyOp(d, { op: 'button.set', pageId: 'p1', slot: '1-1', button: null }, ctx).deck;
  assert.equal(d.pages[0].buttons['1-1'], undefined);
  valid(d);
});

test('button.set mints a fresh id when the id is used elsewhere', () => {
  const { deck: d } = applyOp(deck(), { op: 'button.set', pageId: 'p1', slot: '2-0', button: { id: 'c', label: 'Copy' } }, ctx);
  assert.notEqual(d.pages[0].buttons['2-0'].id, 'c');
  valid(d);
});

test('button.set rejects slots outside the grid', () => {
  assert.throws(() => applyOp(deck(), { op: 'button.set', pageId: 'p2', slot: '5-5', button: { label: 'x' } }, ctx), OpError);
});

test('button.move moves into an empty slot and swaps with an occupied one', () => {
  let d = applyOp(deck(), { op: 'button.move', from: { pageId: 'p1', slot: '0-0' }, to: { pageId: 'p1', slot: '2-4' } }, ctx).deck;
  assert.equal(d.pages[0].buttons['2-4'].id, 'a');
  assert.equal(d.pages[0].buttons['0-0'], undefined);

  d = applyOp(d, { op: 'button.move', from: { pageId: 'p1', slot: '2-4' }, to: { pageId: 'p1', slot: '0-1' } }, ctx).deck;
  assert.equal(d.pages[0].buttons['0-1'].id, 'a');
  assert.equal(d.pages[0].buttons['2-4'].id, 'b');
  valid(d);
});

test('button.move to another page without a slot takes the first free one', () => {
  const { deck: d, data } = applyOp(deck(), { op: 'button.move', from: { pageId: 'p1', slot: '0-1' }, to: { pageId: 'p2' } }, ctx);
  assert.equal(data?.slot, '0-1');
  assert.equal(d.pages[1].buttons['0-1'].id, 'b');
  assert.equal(d.pages[0].buttons['0-1'], undefined);
});

test('button.duplicate copies into the next free slot with a new id', () => {
  const { deck: d, data } = applyOp(deck(), { op: 'button.duplicate', pageId: 'p1', slot: '0-0' }, ctx);
  const copy = d.pages[0].buttons[data?.slot as string];
  assert.equal(copy.label, 'A');
  assert.notEqual(copy.id, 'a');
  valid(d);
});

test('page.update shrinking drops buttons that no longer fit', () => {
  const { deck: d } = applyOp(deck(), { op: 'page.update', pageId: 'p1', rows: 1, cols: 1, name: 'Tiny' }, ctx);
  assert.deepEqual(Object.keys(d.pages[0].buttons), ['0-0']);
  assert.equal(d.pages[0].name, 'Tiny');
  valid(d);
});

test('page.delete refuses the last page and re-homes the deck', () => {
  const { deck: d } = applyOp(deck(), { op: 'page.delete', pageId: 'p1' }, ctx);
  assert.equal(d.homePageId, 'p2');
  assert.throws(() => applyOp(d, { op: 'page.delete', pageId: 'p2' }, ctx), /last page/);
});

test('page.add inserts after a page and page.move reorders', () => {
  let r = applyOp(deck(), { op: 'page.add', name: 'Audio', rows: 2, cols: 4, afterPageId: 'p1' }, ctx);
  assert.equal(r.deck.pages[1].name, 'Audio');
  r = applyOp(r.deck, { op: 'page.move', pageId: r.data?.pageId as string, toIndex: 0 }, ctx);
  assert.equal(r.deck.pages[0].name, 'Audio');
  valid(r.deck);
});

test('folder.create adds a page with a Back button and links to it', () => {
  const { deck: d, data } = applyOp(deck(), { op: 'folder.create', pageId: 'p1', slot: '1-0', name: 'Scenes' }, ctx);
  const folder = d.pages.find((p) => p.id === data?.pageId)!;
  assert.equal(folder.name, 'Scenes');
  assert.equal(folder.buttons['0-0'].tap?.type, 'deck.back');
  assert.deepEqual(d.pages[0].buttons['1-0'].tap, { type: 'deck.page', pageId: folder.id });
  assert.equal(d.pages.indexOf(folder), 1, 'the folder page sits right after its parent');
  valid(d);
});

test('deck.import validates the file and requests a backup', () => {
  assert.throws(() => applyOp(deck(), { op: 'deck.import', deck: { version: 1, pages: [] } }, ctx), /not a valid deck/);
  const imported = { ...deck(), homePageId: 'p2' };
  const r = applyOp(deck(), { op: 'deck.import', deck: imported }, ctx);
  assert.equal(r.backup, 'import');
  assert.equal(r.deck.homePageId, 'p2');
});

test('deck.generateStarter needs OBS and fills a fresh deck in place', () => {
  const fresh: Deck = { version: 1, revision: 0, homePageId: 'home', pages: [{ id: 'home', name: 'Main', rows: 3, cols: 5, buttons: {} }] };
  assert.throws(() => applyOp(fresh, { op: 'deck.generateStarter' }, ctx), /Connect to OBS/);

  const obs = emptyObsState('connected');
  obs.scenes = [{ name: 'Intro' }, { name: 'Game' }];
  obs.inputs = { Mic: { name: 'Mic', kind: 'x', audio: true }, Cam: { name: 'Cam', kind: 'y', audio: false } };
  const r = applyOp(fresh, { op: 'deck.generateStarter' }, { obs, newId: seqId });
  assert.equal(r.deck.pages.length, 1);
  const page = r.deck.pages[0];
  assert.equal(page.id, 'home');
  const types = Object.values(page.buttons).map((b) => b.tap?.type);
  assert.equal(types.filter((t) => t === 'obs.scene').length, 2);
  assert.equal(types.filter((t) => t === 'obs.mute').length, 1, 'only audio inputs get mute buttons');
  assert.ok(types.includes('obs.stream') && types.includes('obs.record'));
  assert.equal(Object.values(page.buttons).find((b) => b.tap?.type === 'obs.stream')?.confirm, true);
  valid(r.deck);
});

test('ops never mutate the deck they were given', () => {
  const original = deck();
  const snapshot = structuredClone(original);
  applyOp(original, { op: 'button.move', from: { pageId: 'p1', slot: '0-0' }, to: { pageId: 'p2' } }, ctx);
  applyOp(original, { op: 'page.delete', pageId: 'p2' }, ctx);
  assert.deepEqual(original, snapshot);
});
