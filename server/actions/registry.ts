// Builds the executor for every family of actions. New integrations get their own file in this
// folder and one line here.
import type { Action, Deck } from '../../shared/schema.ts';
import type { ButtonStateAccess } from '../button-state.ts';
import type { Logger } from '../log.ts';
import type { ObsBridge } from '../obs/bridge.ts';
import type { AudioWatcher } from '../system/audio.ts';
import type { MediaSource } from '../system/media.ts';
import type { Runner } from '../system/process.ts';
import type { SoundPlayer } from '../system/sound.ts';
import type { WinRequester } from '../system/windows/helper.ts';
import type { WindowsMediaWatcher } from '../system/windows/media.ts';
import { counterExecutor } from './counter.ts';
import { runAction, type ActionCtx, type ExecutorRegistry, type Phase } from './executor.ts';
import { httpExecutor } from './http.ts';
import { kdeExecutor } from './kde.ts';
import { macroExecutor } from './macro.ts';
import { mediaExecutor, windowsMediaExecutor } from './media.ts';
import { obsExecutor, obsTextSetter } from './obs.ts';
import { soundExecutor } from './sound.ts';
import { systemExecutor } from './system.ts';
import { timerExecutor, type TimerTexts } from './timer.ts';
import { toggleExecutor } from './toggle.ts';

export interface ExecutorDeps {
  bridge: ObsBridge;
  /** Where obs.screenshot saves its PNGs. */
  screenshotDir: string;
  log: Logger;
  /** Runs helper programs (playerctl, …). */
  run: Runner;
  /** Knows which media player the buttons show. */
  media: Pick<MediaSource, 'currentInstance'>;
  /** Re-reads the system volume after a change. */
  audio: Pick<AudioWatcher, 'refresh'>;
  /** Run Command buttons work (STREAMDECK_ENABLE_COMMANDS=1). */
  commandsEnabled: boolean;
  /** On Windows: the helper and media watcher, used instead of the Linux programs. */
  windows?: { helper: WinRequester; media: Pick<WindowsMediaWatcher, 'command'> };
  /** Counter, Toggle and Timer buttons' state. */
  states: ButtonStateAccess;
  getDeck: () => Deck;
  /** Keeps timers' OBS text sources up to date. */
  timerTexts: Pick<TimerTexts, 'update'>;
  sounds: Pick<SoundPlayer, 'play' | 'stopAll'>;
}

export function createExecutors(deps: ExecutorDeps): ExecutorRegistry {
  const runInRegistry = (action: Action, phase: Phase, ctx?: ActionCtx) => runAction(registry, action, phase, ctx);
  const setText = obsTextSetter(deps.bridge);
  const registry: ExecutorRegistry = {
    obs: obsExecutor(deps.bridge, deps.screenshotDir),
    http: httpExecutor(deps.log),
    media: deps.windows ? windowsMediaExecutor(deps.windows.media) : mediaExecutor(deps.run, deps.media),
    system: systemExecutor({ run: deps.run, audio: deps.audio, commandsEnabled: deps.commandsEnabled, windows: deps.windows?.helper }),
    kde: kdeExecutor(deps.run),
    sound: soundExecutor(deps.sounds),
    // Macro steps and toggle sides run through this same registry.
    macro: macroExecutor({ run: runInRegistry, log: deps.log }),
    toggle: toggleExecutor({ run: runInRegistry, states: deps.states }),
    counter: counterExecutor({ states: deps.states, getDeck: deps.getDeck, setText }),
    timer: timerExecutor({ states: deps.states, getDeck: deps.getDeck, texts: deps.timerTexts }),
    clock: async () => {}, // a display: tapping it does nothing
    // Navigation happens in the browser, which never sends these; a stale client's press is a no-op.
    deck: async () => {},
  };
  return registry;
}
