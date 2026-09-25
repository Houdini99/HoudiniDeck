// The Windows side (server/system/windows/), on any system: key codes, what goes to the helper, the
// media watcher against a fake helper, and the helper protocol against a stand-in process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ActionError } from '../server/actions/executor.ts';
import { systemExecutor } from '../server/actions/system.ts';
import { ExtStore } from '../server/ext-store.ts';
import { silentLogger } from '../server/log.ts';
import { lanAddresses } from '../server/network.ts';
import { safeFileName } from '../server/obs/execute.ts';
import { AudioWatcher } from '../server/system/audio.ts';
import { HelperUnavailableError, WinHelper, type WinMediaState, type WinRequester } from '../server/system/windows/helper.ts';
import { windowsKey, windowsKeyEvents } from '../server/system/windows/keys.ts';
import { WindowsMediaWatcher, pickSession, playerName } from '../server/system/windows/media.ts';
import { windowsVolumeRequest } from '../server/system/windows/volume.ts';
import { KEYS } from '../shared/keys.ts';
import type { ActionOf, Deck } from '../shared/schema.ts';
import { waitFor } from './helpers.ts';

type Request = { op: string; args: Record<string, unknown> };

/** A helper that records requests and answers from a table. */
function fakeRequester(answer: (op: string, args: Record<string, unknown>) => unknown = () => null) {
  const requests: Request[] = [];
  const helper: WinRequester = {
    async request<T>(op: string, args: Record<string, unknown> = {}) {
      requests.push({ op, args });
      return answer(op, args) as T;
    },
  };
  return { helper, requests };
}

test('keys become the scan codes of the same key positions on Windows', () => {
  assert.deepEqual(windowsKey(KEYS.KEY_A.code), { scan: 0x1e });
  assert.deepEqual(windowsKey(KEYS.KEY_Z.code), { scan: 0x2c }, 'a position: Windows maps it through the layout (Y on a German one)');
  assert.deepEqual(windowsKey(KEYS.KEY_LEFTCTRL.code), { scan: 0x1d });
  assert.deepEqual(windowsKey(KEYS.KEY_RIGHTCTRL.code), { scan: 0x1d, extended: true });
  assert.deepEqual(windowsKey(KEYS.KEY_LEFTMETA.code), { scan: 0x5b, extended: true }, 'Super is the Windows key');
  assert.deepEqual(windowsKey(KEYS.KEY_UP.code), { scan: 0x48, extended: true });
  assert.deepEqual(windowsKey(KEYS.KEY_KPENTER.code), { scan: 0x1c, extended: true });
  assert.deepEqual(windowsKey(KEYS.KEY_F12.code), { scan: 0x58 });
  assert.deepEqual(windowsKey(KEYS.KEY_F13.code), { scan: 0x64, vk: 0x7c });
  assert.deepEqual(windowsKey(KEYS.KEY_F24.code), { scan: 0x76, vk: 0x87 });
  assert.deepEqual(windowsKey(KEYS.KEY_VOLUMEUP.code), { scan: 0x30, extended: true, vk: 0xaf });
  assert.deepEqual(windowsKey(KEYS.KEY_PAUSE.code), { scan: 0x45, vk: 0x13 });
  const missing = Object.keys(KEYS).filter((name) => !windowsKey(KEYS[name].code));
  assert.deepEqual(missing, ['KEY_MICMUTE'], 'every other key exists on Windows');
});

test('key events: press in order, release in reverse; hold buttons split them', () => {
  const ctrlM = ['KEY_LEFTCTRL', 'KEY_M'];
  assert.deepEqual(windowsKeyEvents(ctrlM), [0x1d, 0, 0, 0, 0x32, 0, 0, 0, 0x32, 0, 0, 1, 0x1d, 0, 0, 1]);
  assert.deepEqual(windowsKeyEvents(ctrlM, 'down'), [0x1d, 0, 0, 0, 0x32, 0, 0, 0]);
  assert.deepEqual(windowsKeyEvents(['KEY_LEFTMETA', 'KEY_F13'], 'up'), [0x64, 0, 0x7c, 1, 0x5b, 1, 0, 1]);
  assert.throws(() => windowsKeyEvents(['KEY_MICMUTE']), (err: Error) => err instanceof ActionError && /no Mic Mute key/.test(err.message));
});

test('on Windows, System Volume and Keyboard Shortcut buttons go to the helper', async () => {
  const { helper, requests } = fakeRequester();
  let refreshed = 0;
  const run = async () => assert.fail('no Linux programs on Windows');
  const execute = systemExecutor({ run, audio: { refresh: async () => void refreshed++ }, commandsEnabled: false, windows: helper });
  const volume = (a: Partial<ActionOf<'system.volume'>>): ActionOf<'system.volume'> => ({ type: 'system.volume', target: 'output', mode: 'toggleMute', ...a });

  await execute(volume({}), { kind: 'press' });
  await execute(volume({ mode: 'fader', target: 'input' }), { kind: 'fader', pos: 1.4 });
  await execute({ type: 'system.hotkey', keys: ['KEY_LEFTCTRL', 'KEY_M'], hold: true }, { kind: 'hold', down: true });
  assert.deepEqual(requests, [
    { op: 'volume.set', args: { target: 'output', mode: 'toggleMute' } },
    { op: 'volume.set', args: { target: 'input', mode: 'set', value: 1 } },
    { op: 'keys', args: { events: [0x1d, 0, 0, 0, 0x32, 0, 0, 0] } },
  ]);
  assert.equal(refreshed, 2, 'the volume is read again after each change');

  assert.deepEqual(windowsVolumeRequest(volume({ mode: 'step' }), { kind: 'press' }), { mode: 'step', value: 5 });
  assert.deepEqual(windowsVolumeRequest(volume({ mode: 'step', step: -10 }), { kind: 'press' }), { mode: 'step', value: -10 });
  assert.deepEqual(windowsVolumeRequest(volume({ mode: 'mute' }), { kind: 'press' }), { mode: 'mute' });
  assert.deepEqual(windowsVolumeRequest(volume({ mode: 'fader' }), { kind: 'press' }), { mode: 'toggleMute' }, 'tapping a fader mutes');
});

test('on Windows, the volume watcher asks the helper; a helper that can’t start dims the buttons', async (t) => {
  let unavailable = false;
  const { helper, requests } = fakeRequester((_op, args) => {
    if (unavailable) throw new HelperUnavailableError('Windows PowerShell couldn’t start the deck’s helper');
    return args.target === 'output' ? { volume: 0.3, muted: false } : null;
  });
  const store = new ExtStore();
  const watcher = new AudioWatcher({ store, run: async () => assert.fail('no wpctl on Windows'), windows: helper, log: silentLogger, pollMs: 20 });
  t.after(() => watcher.stop());
  const deck: Deck = {
    version: 1,
    revision: 0,
    homePageId: 'p',
    pages: [
      {
        id: 'p',
        name: 'P',
        rows: 1,
        cols: 2,
        buttons: {
          '0-0': { id: 'a', tap: { type: 'system.volume', target: 'output', mode: 'fader' } },
          '0-1': { id: 'b', tap: { type: 'system.volume', target: 'input', mode: 'toggleMute' } },
        },
      },
    ],
  };
  watcher.setDeck(deck);
  watcher.setActive(true);
  await waitFor(() => store.state.audio.input === null, 1000, 'both read');
  assert.deepEqual(store.state.audio.output, { volume: 0.3, muted: false });
  assert.deepEqual(requests[0], { op: 'volume.get', args: { target: 'output' } });

  unavailable = true;
  await waitFor(() => !store.state.audio.available, 1000, 'marked unavailable');
});

test('Windows player names and which session a button means', () => {
  assert.equal(playerName('Spotify.exe'), 'spotify');
  assert.equal(playerName('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'), 'spotify');
  assert.equal(playerName('Chrome'), 'chrome');
  assert.equal(playerName('308046B0AF4A39CB'), 'firefox');
  assert.equal(playerName('{6D809377-6AF0-444B-8957-A3773F02200E}\\VideoLAN\\VLC\\vlc.exe'), 'vlc');

  const session = (id: string, status: string) => ({ id, status, artist: '', title: id });
  const state: WinMediaState = {
    current: 'Chrome',
    sessions: [session('Spotify.exe', 'Paused'), session('Chrome', 'Paused'), session('MSEdge', 'Playing')],
  };
  assert.equal(pickSession(state, '')?.id, 'Chrome', 'the one Windows shows');
  assert.equal(pickSession({ ...state, current: null }, '')?.id, 'MSEdge', 'else one that plays');
  assert.equal(pickSession(state, 'Spotify')?.id, 'Spotify.exe', 'names ignore case');
  assert.equal(pickSession(state, 'vlc'), undefined);
});

class FakeMediaHelper extends EventEmitter<{ media: [WinMediaState] }> {
  watching = false;
  requests: Request[] = [];
  state: WinMediaState = { current: null, sessions: [] };
  accepted = true;
  setMediaWatch(on: boolean): void {
    this.watching = on;
  }
  async request<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ op, args });
    return (op === 'media.control' ? { accepted: this.accepted } : this.state) as T;
  }
}

function mediaDeck(...players: (string | undefined)[]): Deck {
  const buttons = Object.fromEntries(
    players.map((player, i) => [`0-${i}`, { id: `b${i}`, tap: { type: 'media.player' as const, command: 'playPause' as const, player } }]),
  );
  return { version: 1, revision: 0, homePageId: 'p', pages: [{ id: 'p', name: 'P', rows: 1, cols: 5, buttons }] };
}

test('the Windows media watcher only runs for decks with media buttons, while someone looks', () => {
  const helper = new FakeMediaHelper();
  const store = new ExtStore();
  const watcher = new WindowsMediaWatcher({ store, helper, log: silentLogger });
  watcher.setDeck(mediaDeck());
  watcher.setActive(true);
  assert.equal(helper.watching, false, 'no PowerShell for a deck without media buttons');
  watcher.setDeck(mediaDeck(undefined, 'spotify'));
  assert.equal(helper.watching, true);

  helper.emit('media', {
    current: 'Chrome',
    sessions: [
      { id: 'Chrome', status: 'Playing', artist: 'A', title: 'Video', art: 'C:\\Temp\\art\\Chrome.img', artHash: 'aaa' },
      { id: 'Spotify.exe', status: 'Paused', artist: 'B', title: 'Song' },
    ],
  });
  const players = store.state.media.players;
  assert.equal(players['']?.instance, 'chrome');
  assert.equal(players['']?.status, 'Playing');
  assert.deepEqual(players.spotify, { instance: 'spotify', status: 'Paused', artist: 'B', title: 'Song' });
  const art = players['']!.art!;
  assert.match(art, /^\/api\/media\/art\/[a-f0-9]{32}$/);
  assert.equal(watcher.artFile(art.split('/').pop()!), 'C:\\Temp\\art\\Chrome.img');

  // The same file with a new picture in it gets a new URL, so browsers don't show the cached one.
  helper.emit('media', { current: 'Chrome', sessions: [{ id: 'Chrome', status: 'Playing', artist: 'A', title: 'Video', art: 'C:\\Temp\\art\\Chrome.img', artHash: 'bbb' }] });
  assert.notEqual(store.state.media.players['']!.art, art);
  assert.equal(watcher.artFile(art.split('/').pop()!), undefined, 'the old token is gone');
  assert.equal(store.state.media.players.spotify, null, 'Spotify closed');

  watcher.setActive(false);
  assert.equal(helper.watching, false);
  assert.deepEqual(store.state.media.players, {});
});

test('Windows media buttons press the player they show; errors from the media API dim them', async () => {
  const helper = new FakeMediaHelper();
  const store = new ExtStore();
  const watcher = new WindowsMediaWatcher({ store, helper, log: silentLogger });
  const press = (player?: string) => watcher.command({ type: 'media.player', command: 'next', player });

  await assert.rejects(press(), /No media player is running/);
  await assert.rejects(press('spotify'), /“spotify” is not running/);
  helper.state = { current: 'Spotify.exe', sessions: [{ id: 'Spotify.exe', status: 'Playing', artist: '', title: '' }] };
  await press();
  assert.deepEqual(helper.requests.at(-1), { op: 'media.control', args: { id: 'Spotify.exe', command: 'next' } });
  helper.accepted = false;
  await assert.rejects(press('Spotify'), /spotify can’t do that right now/);
  assert.deepEqual(await watcher.listPlayers(), ['spotify']);

  watcher.setDeck(mediaDeck(undefined));
  watcher.setActive(true);
  helper.emit('media', { current: null, sessions: [], error: 'Class not registered' });
  assert.equal(store.state.media.available, false);
  assert.equal(helper.watching, false, 'and it stops asking');
});

const FAKE_HELPER = fileURLToPath(new URL('./fake-win-helper.ts', import.meta.url));

function fakeHelper(opts: { fail?: boolean; timeoutMs?: number } = {}) {
  let starts = 0;
  const helper = new WinHelper({
    log: silentLogger,
    spawn: () => {
      starts++;
      return spawn(process.execPath, [FAKE_HELPER], { stdio: 'pipe', env: { ...process.env, FAKE_HELPER_FAIL: opts.fail ? '1' : '' } });
    },
    timeoutMs: opts.timeoutMs ?? 2000,
    startTimeoutMs: 5000,
    cooldownMs: [300],
  });
  return { helper, starts: () => starts };
}

test('the helper protocol: answers, errors, text beyond ASCII, and media updates', async (t) => {
  const { helper, starts } = fakeHelper();
  t.after(() => helper.stop());
  const echo = await helper.request<{ raw: string; name: string }>('echo', { name: 'Motörhead – Ace of Spades' });
  assert.equal(echo.name, 'Motörhead – Ace of Spades');
  assert.ok(!/[^\x20-\x7e]/.test(echo.raw), 'the request itself is plain ASCII on the wire');
  await assert.rejects(helper.request('fail'), (err: Error) => err instanceof ActionError && err.message === 'Element nicht gefunden');

  const updates: WinMediaState[] = [];
  helper.on('media', (state) => updates.push(state));
  helper.setMediaWatch(true);
  await waitFor(() => updates.length === 1, 2000, 'media update');
  assert.equal(starts(), 1, 'one process for everything');
});

test('a helper that stops is started again, and watching resumes', async (t) => {
  const { helper, starts } = fakeHelper();
  t.after(() => helper.stop());
  const updates: WinMediaState[] = [];
  helper.on('media', (state) => updates.push(state));
  helper.setMediaWatch(true);
  await waitFor(() => updates.length === 1, 2000, 'first update');
  await assert.rejects(helper.request('crash'), /The Windows helper stopped/);
  await waitFor(() => updates.length === 2, 3000, 'update from the new helper');
  assert.equal(starts(), 2);
  assert.deepEqual(await helper.request('echo', { n: 1 }).then((d) => (d as { n: number }).n), 1);
});

test('a helper that hangs is replaced; one that can’t start is retried only after a pause', async (t) => {
  const hanging = fakeHelper({ timeoutMs: 200 });
  t.after(() => hanging.helper.stop());
  await hanging.helper.request('echo'); // started and ready
  await assert.rejects(hanging.helper.request('hang'), /didn’t answer in time/);
  await hanging.helper.request('echo');
  assert.equal(hanging.starts(), 2);

  const broken = fakeHelper({ fail: true });
  t.after(() => broken.helper.stop());
  await assert.rejects(broken.helper.request('echo'), (err: Error) => err instanceof HelperUnavailableError && /compilation failed/.test(err.message));
  await assert.rejects(broken.helper.request('echo'), HelperUnavailableError);
  assert.equal(broken.starts(), 1, 'not started again during the pause');
  await new Promise((r) => setTimeout(r, 350));
  await assert.rejects(broken.helper.request('echo'), HelperUnavailableError);
  assert.equal(broken.starts(), 2);
});

test('pairing addresses skip Windows’ virtual adapters and prefer Ethernet and Wi-Fi', () => {
  const v4 = (address: string) => [{ address, family: 'IPv4' as const, internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }];
  const interfaces = {
    'vEthernet (WSL (Hyper-V firewall))': v4('172.20.64.1'),
    'VirtualBox Host-Only Network': v4('192.168.56.1'),
    Tailscale: v4('100.64.0.5'),
    'Ethernet 2': v4('169.254.10.20'),
    WLAN: v4('192.168.1.20'),
    'Loopback Pseudo-Interface 1': [{ ...v4('127.0.0.1')[0], internal: true }],
  };
  assert.deepEqual(lanAddresses(interfaces as unknown as Parameters<typeof lanAddresses>[0]), ['192.168.1.20', '100.64.0.5']);
});

test('screenshot file names avoid characters Windows forbids', () => {
  assert.equal(safeFileName('Game: "Live" <1080p>/cam?|*'), 'Game_ _Live_ _1080p__cam___');
});
