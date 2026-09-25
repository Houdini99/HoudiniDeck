// Wires the pieces together. index.ts runs this for real; tests start it on a random port.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Dispatcher } from './actions/dispatch.ts';
import { createExecutors } from './actions/registry.ts';
import { packageVersion, picturesDir, type Env } from './env.ts';
import { createHttpServer } from './http.ts';
import { Hub } from './hub.ts';
import { createLogger } from './log.ts';
import { reachableUrls } from './network.ts';
import { ObsBridge } from './obs/bridge.ts';
import { DeckStore } from './store/deck-store.ts';
import { SettingsStore } from './store/settings-store.ts';

export interface App {
  http: FastifyInstance;
  hub: Hub;
  bridge: ObsBridge;
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
  const actionLog = createLogger('actions');
  const dispatcher = new Dispatcher({
    executors: createExecutors({ bridge, screenshotDir: join(picturesDir(), 'OBS'), log: actionLog }),
    getDeck: () => deckStore.deck,
    log: actionLog,
  });
  const version = packageVersion();
  const hub = new Hub({
    env,
    deckStore,
    settingsStore,
    bridge,
    dispatcher,
    buildId: await readBuildId(env.webDist),
    info: () => ({ version, hostname: os.hostname(), urls: reachableUrls(env.publicPort) }),
    log: createLogger('hub'),
  });
  const http = await createHttpServer({ env, hub, bridge, settingsStore, log });
  await http.listen({ host: env.host, port: env.port });
  const address = http.server.address();
  const port = typeof address === 'object' && address ? address.port : env.port;
  bridge.start();

  return {
    http,
    hub,
    bridge,
    deckStore,
    settingsStore,
    port,
    async close() {
      hub.close();
      await bridge.stop();
      await http.close();
    },
  };
}
