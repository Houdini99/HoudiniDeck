// Builds the executor for every family of actions. New integrations get their own file in this
// folder and one line here.
import type { ObsBridge } from '../obs/bridge.ts';
import type { ExecutorRegistry } from './executor.ts';
import { obsExecutor } from './obs.ts';

export interface ExecutorDeps {
  bridge: ObsBridge;
  /** Where obs.screenshot saves its PNGs. */
  screenshotDir: string;
}

export function createExecutors(deps: ExecutorDeps): ExecutorRegistry {
  return {
    obs: obsExecutor(deps.bridge, deps.screenshotDir),
    // Navigation happens in the browser, which never sends these; a stale client's press is a no-op.
    deck: async () => {},
  };
}
