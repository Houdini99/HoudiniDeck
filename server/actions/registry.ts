// Builds the executor for every family of actions. New integrations get their own file in this
// folder and one line here.
import type { Logger } from '../log.ts';
import type { ObsBridge } from '../obs/bridge.ts';
import type { MediaWatcher } from '../system/media.ts';
import type { Runner } from '../system/process.ts';
import type { ExecutorRegistry } from './executor.ts';
import { httpExecutor } from './http.ts';
import { mediaExecutor } from './media.ts';
import { obsExecutor } from './obs.ts';

export interface ExecutorDeps {
  bridge: ObsBridge;
  /** Where obs.screenshot saves its PNGs. */
  screenshotDir: string;
  log: Logger;
  /** Runs helper programs (playerctl, …). */
  run: Runner;
  /** Knows which media player the buttons show. */
  media: Pick<MediaWatcher, 'currentInstance'>;
}

export function createExecutors(deps: ExecutorDeps): ExecutorRegistry {
  return {
    obs: obsExecutor(deps.bridge, deps.screenshotDir),
    http: httpExecutor(deps.log),
    media: mediaExecutor(deps.run, deps.media),
    // Navigation happens in the browser, which never sends these; a stale client's press is a no-op.
    deck: async () => {},
  };
}
