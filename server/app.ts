// Wires the pieces together. index.ts runs this for real; tests start it on a random port.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Dispatcher } from './actions/dispatch.ts';
import { createExecutors } from './actions/registry.ts';
import { packageVersion, picturesDir, type Env } from './env.ts';
import { ExtStore } from './ext-store.ts';
import { createHttpServer } from './http.ts';
import { Hub } from './hub.ts';
import { createLogger } from './log.ts';
import { reachableUrls } from './network.ts';
import { ObsBridge } from './obs/bridge.ts';
import { DeckStore } from './store/deck-store.ts';
import { SettingsStore } from './store/settings-store.ts';
import { AudioWatcher } from './system/audio.ts';
import { MediaWatcher } from './system/media.ts';
import { runProcess, spawnLines } from './system/process.ts';
import { StatsWatcher } from './system/stats.ts';

export interface App {
  http: FastifyInstance;
  hub: Hub;
  bridge: ObsBridge;
  ext: ExtStore;
  media: MediaWatcher;
  audio: AudioWatcher;
  stats: StatsWatcher;
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

export async function startApp(env: Env): Promise<App> {
  const log = createLogger('server');
  const settingsStore = await SettingsStore.load(env.dataDir, log);
  const deckStore = await DeckStore.load(env.dataDir, log);
  const obsConfig = settingsStore.obsConfig(env);

  const bridge = new ObsBridge({ url: obsConfig.url, password: obsConfig.password, log: createLogger('obs') });
  const ext = new ExtStore();
  const media = new MediaWatcher({ store: ext, spawn: spawnLines, run: runProcess, log: createLogger('media') });
  const audio = new AudioWatcher({ store: ext, run: runProcess, log: createLogger('audio') });
  const stats = new StatsWatcher({ store: ext, run: runProcess, log: createLogger('stats') });
  for (const watcher of [media, audio]) {
    watcher.setDeck(deckStore.deck);
    deckStore.on('change', (deck) => watcher.setDeck(deck));
  }
  const actionLog = createLogger('actions');
  const dispatcher = new Dispatcher({
    executors: createExecutors({
      bridge,
      screenshotDir: join(picturesDir(), 'OBS'),
      log: actionLog,
      run: runProcess,
      media,
      audio,
      commandsEnabled: env.commandsEnabled,
    }),
    getDeck: () => deckStore.deck,
    log: actionLog,
  });
  const version = packageVersion();
  const hub = new Hub({
    env,
    deckStore,
    settingsStore,
    bridge,
    ext,
    media,
    audio,
    stats,
    dispatcher,
    buildId: await readBuildId(env.webDist),
    info: () => ({ version, hostname: os.hostname(), urls: reachableUrls(env.publicPort), commands: env.commandsEnabled }),
    log: createLogger('hub'),
  });
  const http = await createHttpServer({ env, hub, bridge, media, settingsStore, log });
  await http.listen({ host: env.host, port: env.port });
  const address = http.server.address();
  const port = typeof address === 'object' && address ? address.port : env.port;
  bridge.start();

  return {
    http,
    hub,
    bridge,
    ext,
    media,
    audio,
    stats,
    deckStore,
    settingsStore,
    port,
    async close() {
      hub.close();
      media.stop();
      audio.stop();
      stats.stop();
      await bridge.stop();
      await http.close();
    },
  };
}
