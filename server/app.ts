// Wires the pieces together. index.ts runs this for real; tests start it on a random port.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { deckActions } from '../shared/deck-utils.ts';
import type { Deck } from '../shared/schema.ts';
import { Dispatcher } from './actions/dispatch.ts';
import { obsTextSetter } from './actions/obs.ts';
import { createExecutors } from './actions/registry.ts';
import { TimerTexts } from './actions/timer.ts';
import { ButtonStates } from './button-state.ts';
import { packageVersion, picturesDir, type Env } from './env.ts';
import { ExtStore } from './ext-store.ts';
import { createHttpServer } from './http.ts';
import { Hub } from './hub.ts';
import { createLogger } from './log.ts';
import { reachableUrls } from './network.ts';
import { ObsBridge } from './obs/bridge.ts';
import { SceneThumbnails } from './obs/thumbnails.ts';
import { DeckStore } from './store/deck-store.ts';
import { SettingsStore } from './store/settings-store.ts';
import { AudioWatcher } from './system/audio.ts';
import { listKdeShortcuts } from './system/kde.ts';
import { MediaWatcher, type MediaSource } from './system/media.ts';
import { runProcess, spawnLines } from './system/process.ts';
import { SoundPlayer, programSoundBackend, windowsSoundBackend } from './system/sound.ts';
import { StatsWatcher } from './system/stats.ts';
import { WinHelper } from './system/windows/helper.ts';
import { WindowsMediaWatcher } from './system/windows/media.ts';
import type { Relaunch } from './update/install.ts';
import { Updater } from './update/updater.ts';

export interface App {
  http: FastifyInstance;
  hub: Hub;
  bridge: ObsBridge;
  ext: ExtStore;
  media: MediaSource;
  audio: AudioWatcher;
  stats: StatsWatcher;
  states: ButtonStates;
  sounds: SoundPlayer;
  thumbnails: SceneThumbnails;
  updater: Updater;
  deckStore: DeckStore;
  settingsStore: SettingsStore;
  /** Port actually bound (useful when env.port is 0). */
  port: number;
  close(): Promise<void>;
}

/** Changes whenever the web UI is rebuilt, so open tablets know to reload. */
async function readBuildId(webDist: string): Promise<string> {
  try {
    const html = await readFile(join(webDist, 'index.html'));
    return createHash('sha1').update(html).digest('hex').slice(0, 12);
  } catch {
    return 'dev';
  }
}

export interface StartOptions {
  /** Close the deck and start the new version in its place (index.ts does that; tests pass a fake). */
  relaunch?: (next: Relaunch) => void;
  /** Close the deck and end the program (Settings → Stop HoudiniDeck; index.ts does that, tests pass a fake). */
  stop?: () => void;
}

export async function startApp(env: Env, options: StartOptions = {}): Promise<App> {
  const log = createLogger('server');
  const settingsStore = await SettingsStore.load(env.dataDir, log);
  const deckStore = await DeckStore.load(env.dataDir, log);
  const obsConfig = settingsStore.obsConfig(env);

  const bridge = new ObsBridge({ url: obsConfig.url, password: obsConfig.password, log: createLogger('obs') });
  const ext = new ExtStore();
  // Windows has none of the Linux programs (playerctl, wpctl, ydotool); its helper does their jobs.
  const winHelper = process.platform === 'win32' ? new WinHelper({ log: createLogger('windows') }) : undefined;
  const winMedia = winHelper && new WindowsMediaWatcher({ store: ext, helper: winHelper, log: createLogger('media') });
  const media: MediaSource = winMedia ?? new MediaWatcher({ store: ext, spawn: spawnLines, run: runProcess, log: createLogger('media') });
  const audio = new AudioWatcher({ store: ext, run: runProcess, windows: winHelper, log: createLogger('audio') });
  const stats = new StatsWatcher({ store: ext, run: runProcess, log: createLogger('stats') });
  for (const watcher of [media, audio]) {
    watcher.setDeck(deckStore.deck);
    deckStore.on('change', (deck) => watcher.setDeck(deck));
  }
  if (winHelper) {
    // Starting PowerShell takes a few seconds; Keyboard Shortcut and Play Sound buttons shouldn't wait for that on their first press.
    const warmUp = (deck: Deck) => deckActions(deck).some((a) => a.type === 'system.hotkey' || a.type === 'sound.play') && winHelper.start();
    warmUp(deckStore.deck);
    deckStore.on('change', warmUp);
  }
  const states = await ButtonStates.load(env.dataDir, ext, deckStore.deck, createLogger('buttons'));
  const sounds = new SoundPlayer({
    store: ext,
    backend: winHelper ? windowsSoundBackend(winHelper) : programSoundBackend(),
    dir: join(env.dataDir, 'uploads'),
    log: createLogger('sound'),
  });
  const timerTexts = new TimerTexts({ getDeck: () => deckStore.deck, states, setText: obsTextSetter(bridge), log: createLogger('timers') });
  deckStore.on('change', () => timerTexts.update());
  // After OBS (re)connects, timers write their text sources again.
  let obsConnected = false;
  bridge.store.on('change', () => {
    if (bridge.connected && !obsConnected) timerTexts.resync();
    obsConnected = bridge.connected;
  });
  const actionLog = createLogger('actions');
  const dispatcher = new Dispatcher({
    executors: createExecutors({
      bridge,
      screenshotDir: join(await picturesDir(), 'OBS'),
      log: actionLog,
      run: runProcess,
      media,
      audio,
      commandsEnabled: () => settingsStore.settings.commands,
      windows: winHelper && winMedia && { helper: winHelper, media: winMedia },
      states,
      getDeck: () => deckStore.deck,
      timerTexts,
      sounds,
    }),
    getDeck: () => deckStore.deck,
    log: actionLog,
  });
  const version = packageVersion();
  const thumbnails = new SceneThumbnails({ obs: bridge, log: createLogger('thumbnails') });
  const updater = new Updater({
    version,
    packaging: env.packaging,
    appImagePath: env.appImagePath,
    feed: env.updateFeed,
    dataDir: env.dataDir,
    autoCheck: () => settingsStore.settings.checkUpdates,
    relaunch: options.relaunch ?? (() => log.warn('The update is installed; restart the deck to use it')),
    beforeInstall: () => states.flush(),
    log: createLogger('update'),
  });
  const hub = new Hub({
    env,
    deckStore,
    settingsStore,
    bridge,
    ext,
    media,
    audio,
    stats,
    thumbnails,
    updater,
    kdeShortcuts: async () => (process.platform === 'linux' ? listKdeShortcuts(runProcess) : []),
    dispatcher,
    stop: options.stop ?? (() => log.warn('Stopping is only possible when the deck runs through server/index.ts')),
    buildId: await readBuildId(env.webDist),
    info: () => ({
      version,
      hostname: os.hostname(),
      urls: reachableUrls(env.publicPort),
      commands: settingsStore.settings.commands,
      platform: process.platform,
      update: updater.info,
    }),
    log: createLogger('hub'),
  });
  const http = await createHttpServer({
    env,
    hub,
    bridge,
    media,
    settingsStore,
    dispatcher,
    version,
    getDeck: () => deckStore.deck,
    labelCtx: () => ({ obs: bridge.state, deck: deckStore.deck, ext: ext.state }),
    log,
  });
  await http.listen({ host: env.host, port: env.port });
  const address = http.server.address();
  const port = typeof address === 'object' && address ? address.port : env.port;
  bridge.start();
  updater.start();

  return {
    http,
    hub,
    bridge,
    ext,
    media,
    audio,
    stats,
    states,
    sounds,
    thumbnails,
    updater,
    deckStore,
    settingsStore,
    port,
    async close() {
      updater.stop();
      hub.close();
      media.stop();
      audio.stop();
      stats.stop();
      thumbnails.stop();
      timerTexts.stop();
      sounds.stopAll();
      winHelper?.stop();
      await states.flush();
      await bridge.stop();
      await http.close();
    },
  };
}
