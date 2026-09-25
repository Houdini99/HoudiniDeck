// Reads the default speaker and microphone volume with `wpctl get-volume` (PipeWire), or on Windows
// through the helper (windows/volume.ts), every few seconds while a browser is connected and the deck
// has System Volume buttons.
import type { AudioDevice, AudioTarget } from '../../shared/ext-types.ts';
import type { Deck } from '../../shared/schema.ts';
import type { ExtStore } from '../ext-store.ts';
import { errorMessage, type Logger } from '../log.ts';
import type { Runner } from './process.ts';
import { HelperUnavailableError, type WinRequester } from './windows/helper.ts';
import { readWindowsVolume } from './windows/volume.ts';

const POLL_MS = 2000;

/** wpctl's names for the default devices. */
export const AUDIO_DEVICE_IDS: Record<AudioTarget, string> = {
  output: '@DEFAULT_AUDIO_SINK@',
  input: '@DEFAULT_AUDIO_SOURCE@',
};

/** `wpctl get-volume` prints e.g. "Volume: 0.45" or "Volume: 0.45 [MUTED]". */
export function parseVolume(stdout: string): AudioDevice | null {
  const match = /Volume:\s*(\d+(?:\.\d+)?)(\s*\[MUTED\])?/.exec(stdout);
  return match ? { volume: Number(match[1]), muted: !!match[2] } : null;
}

const same = (a: AudioDevice | null | undefined, b: AudioDevice | null) =>
  a === b || (!!a && !!b && a.volume === b.volume && a.muted === b.muted);

/** Devices that System Volume buttons on the deck use. */
export function audioTargets(deck: Deck): AudioTarget[] {
  const targets = new Set<AudioTarget>();
  for (const page of deck.pages) {
    for (const button of Object.values(page.buttons)) {
      for (const action of [button.tap, button.longPress]) {
        if (action?.type === 'system.volume') targets.add(action.target);
      }
    }
  }
  return [...targets];
}

export interface AudioWatcherDeps {
  store: ExtStore;
  run: Runner;
  /** On Windows: the helper, which reads the volumes instead of wpctl. */
  windows?: WinRequester;
  log: Logger;
  pollMs?: number;
}

export class AudioWatcher {
  private active = false;
  private targets: AudioTarget[] = [];
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private pollAgain = false;
  private readonly deps: AudioWatcherDeps;

  constructor(deps: AudioWatcherDeps) {
    this.deps = deps;
  }

  private get audio() {
    return this.deps.store.state.audio;
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active && !this.audio.available) {
      this.audio.available = true; // wpctl may have been installed meanwhile
      this.deps.store.changed();
    }
    this.sync();
  }

  setDeck(deck: Deck): void {
    this.targets = audioTargets(deck);
    this.sync();
  }

  /** Read the volumes now, e.g. right after a button changed one. */
  refresh(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.polling) {
      this.pollAgain = true; // the change may have landed after that read started
      return this.polling;
    }
    this.polling = this.poll().finally(() => (this.polling = undefined));
    return this.polling;
  }

  stop(): void {
    this.active = false;
    this.sync();
  }

  private get running(): boolean {
    return this.active && this.audio.available && this.targets.length > 0;
  }

  private sync(): void {
    let changed = false;
    for (const target of ['output', 'input'] as const) {
      if ((!this.running || !this.targets.includes(target)) && this.audio[target] !== undefined) {
        delete this.audio[target];
        changed = true;
      }
    }
    if (changed) this.deps.store.changed();
    if (!this.running) {
      clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), this.deps.pollMs ?? POLL_MS);
      void this.refresh();
    }
  }

  private async poll(): Promise<void> {
    do {
      this.pollAgain = false;
      for (const target of this.targets) {
        if (!this.running) return;
        await this.read(target);
      }
    } while (this.pollAgain);
  }

  /** Never throws: a device that can't be read shows as missing (null). */
  private async read(target: AudioTarget): Promise<void> {
    let device: AudioDevice | null = null;
    try {
      device = this.deps.windows ? await readWindowsVolume(this.deps.windows, target) : await this.readWpctl(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof HelperUnavailableError) {
        const why = this.deps.windows ? errorMessage(err) : 'wpctl is not installed';
        this.deps.log.warn(`${why}, so System Volume buttons won’t work`);
        this.audio.available = false;
        this.sync();
        this.deps.store.changed();
        return;
      }
      this.deps.log.debug(`Could not read the ${target} volume: ${errorMessage(err)}`);
    }
    if (!this.running || !this.targets.includes(target)) return; // stopped while reading
    if (same(this.audio[target], device)) return;
    this.audio[target] = device;
    this.deps.store.changed();
  }

  private async readWpctl(target: AudioTarget): Promise<AudioDevice | null> {
    const res = await this.deps.run('wpctl', ['get-volume', AUDIO_DEVICE_IDS[target]]);
    if (res.code === 0) return parseVolume(res.stdout);
    this.deps.log.debug(`wpctl get-volume ${target} failed: ${res.stderr.trim() || `exit code ${res.code}`}`);
    return null;
  }
}
