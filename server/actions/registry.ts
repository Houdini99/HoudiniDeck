// Builds the executor for every family of actions. New integrations get their own file in this
// folder and one line here.
import type { Logger } from '../log.ts';
import type { ObsBridge } from '../obs/bridge.ts';
import type { AudioWatcher } from '../system/audio.ts';
import type { MediaWatcher } from '../system/media.ts';
import type { Runner } from '../system/process.ts';
import { runAction, type ExecutorRegistry } from './executor.ts';
import { httpExecutor } from './http.ts';
import { kdeExecutor } from './kde.ts';
import { macroExecutor } from './macro.ts';
import { mediaExecutor } from './media.ts';
import { obsExecutor } from './obs.ts';
import { systemExecutor } from './system.ts';

export interface ExecutorDeps {
  bridge: ObsBridge;
  /** Where obs.screenshot saves its PNGs. */
  screenshotDir: string;
  log: Logger;
  /** Runs helper programs (playerctl, …). */
  run: Runner;
  /** Knows which media player the buttons show. */
  media: Pick<MediaWatcher, 'currentInstance'>;
  /** Re-reads the system volume after a change. */
  audio: Pick<AudioWatcher, 'refresh'>;
  /** Run Command buttons work (STREAMDECK_ENABLE_COMMANDS=1). */
  commandsEnabled: boolean;
}

export function createExecutors(deps: ExecutorDeps): ExecutorRegistry {
  const registry: ExecutorRegistry = {
    obs: obsExecutor(deps.bridge, deps.screenshotDir),
    http: httpExecutor(deps.log),
    media: mediaExecutor(deps.run, deps.media),
    system: systemExecutor({ run: deps.run, audio: deps.audio, commandsEnabled: deps.commandsEnabled }),
    kde: kdeExecutor(deps.run),
    // Macro steps run through this same registry.
    macro: macroExecutor({ run: (action, phase) => runAction(registry, action, phase), log: deps.log }),
    // Navigation happens in the browser, which never sends these; a stale client's press is a no-op.
    deck: async () => {},
  };
  return registry;
}
