// Plays Play Sound buttons' clips on the PC's default speakers: on Linux with pw-play (PipeWire), or
// paplay or ffplay if it's missing; on Windows through the helper (winmm). Keeps track of what plays,
// so a second press can stop it and buttons light up while their sound plays.
import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { SOUND_NAME_RE } from '../../shared/deck-utils.ts';
import { soundKey } from '../../shared/ext-types.ts';
import type { ActionOf } from '../../shared/schema.ts';
import { ActionError } from '../actions/executor.ts';
import type { ExtStore } from '../ext-store.ts';
import type { Logger } from '../log.ts';
import { outputTail } from './command.ts';
import type { WinRequester } from './windows/helper.ts';

/** A player that exits with an error within this time couldn't play the file (the press reports why). */
const EARLY_EXIT_MS = 400;

/** One sound while it plays. */
export interface Playback {
  stop(): void;
}

/** Starts sounds. `onEnd` is called once when the sound stops, by itself or through stop(). */
export interface SoundBackend {
  start(file: string, volume: number, onEnd: () => void): Promise<Playback>;
}

export interface SoundProgram {
  cmd: string;
  /** volume: 0..1 */
  args: (file: string, volume: number) => string[];
}

/** Tried in this order; the first one that's installed is used from then on. */
export const LINUX_SOUND_PROGRAMS: SoundProgram[] = [
  { cmd: 'pw-play', args: (file, volume) => [`--volume=${volume.toFixed(2)}`, file] },
  { cmd: 'paplay', args: (file, volume) => [`--volume=${Math.round(volume * 65536)}`, file] },
  { cmd: 'ffplay', args: (file, volume) => ['-nodisp', '-autoexit', '-loglevel', 'error', '-volume', String(Math.round(volume * 100)), file] },
];

type SpawnFn = (cmd: string, args: string[]) => ChildProcess;

const spawnPlayer: SpawnFn = (cmd, args) => spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });

/** Linux: one player process per sound; stopping it ends the sound. */
export function programSoundBackend(programs: SoundProgram[] = LINUX_SOUND_PROGRAMS, spawnFn: SpawnFn = spawnPlayer): SoundBackend {
  let found: SoundProgram | undefined;

  const attempt = (program: SoundProgram, file: string, volume: number, onEnd: () => void) =>
    new Promise<Playback>((resolve, reject) => {
      const child = spawnFn(program.cmd, program.args(file, volume));
      let stderr = '';
      let settled = false;
      child.stderr?.on('data', (chunk: Buffer) => (stderr = (stderr + chunk).slice(-4000)));
      const playback: Playback = { stop: () => void child.kill() };
      const timer = setTimeout(() => {
        settled = true;
        resolve(playback);
      }, EARLY_EXIT_MS);
      let failed = false;
      child.on('error', (err) => {
        clearTimeout(timer);
        if (settled) return; // trouble while it plays (e.g. with kill()); 'close' still ends it
        settled = true;
        failed = true; // it didn't start: the 'close' that follows means nothing
        reject(err);
      });
      // 'close' rather than 'exit': by then everything the player wrote to stderr has arrived.
      child.on('close', (code, signal) => {
        if (failed) return;
        if (settled) return onEnd();
        clearTimeout(timer);
        settled = true;
        if (code === 0 || signal) {
          resolve(playback); // a very short sound, already done
          onEnd();
        } else {
          reject(new ActionError(`${program.cmd} couldn’t play it: ${outputTail(stderr, 2) || `exit code ${code}`}`));
        }
      });
    });

  return {
    async start(file, volume, onEnd) {
      for (const program of found ? [found] : programs) {
        try {
          const playback = await attempt(program, file, volume, onEnd);
          found = program;
          return playback;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      found = undefined;
      throw new ActionError('No sound player found on the PC: install pipewire (pw-play), pulseaudio-utils (paplay) or ffmpeg (ffplay)');
    },
  };
}

/**
 * Windows: the helper opens each sound under its own name with winmm (MCI) and plays it. MCI doesn't
 * say when a sound ends, so the deck closes it after its length (or asks now and then if that's unknown).
 */
export function windowsSoundBackend(helper: WinRequester, pollMs = 1000): SoundBackend {
  let next = 1;
  return {
    async start(file, volume, onEnd) {
      const alias = `hd${next++}`;
      const { lengthMs } = await helper.request<{ lengthMs: number }>('sound.play', { alias, path: file, volume: Math.round(volume * 1000) });
      let ended = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        helper.request('sound.close', { alias }).catch(() => {});
        onEnd();
      };
      const poll = () => {
        timer = setTimeout(async () => {
          const playing = await helper.request<boolean>('sound.playing', { alias }).catch(() => false);
          if (playing) poll();
          else finish();
        }, pollMs);
      };
      if (lengthMs > 0) timer = setTimeout(finish, lengthMs + 250);
      else poll();
      return { stop: finish };
    },
  };
}

export interface SoundPlayerDeps {
  store: ExtStore;
  backend: SoundBackend;
  /** Where uploaded sounds are (data/uploads). */
  dir: string;
  log: Logger;
}

interface Playing {
  playback?: Playback;
  ended: boolean;
}

export class SoundPlayer {
  /** What plays, by soundKey (button + file); "overlap" buttons can play one sound several times at once. */
  private readonly playing = new Map<string, Set<Playing>>();
  private readonly deps: SoundPlayerDeps;

  constructor(deps: SoundPlayerDeps) {
    this.deps = deps;
  }

  async play(buttonId: string, action: ActionOf<'sound.play'>): Promise<void> {
    const key = soundKey(buttonId, action.sound);
    if (this.playing.get(key)?.size) {
      if (action.mode === 'toggle') return this.stopKey(key);
      if (action.mode === 'restart') this.stopKey(key);
    }
    if (!SOUND_NAME_RE.test(action.sound)) throw new ActionError('Choose a sound for this button');
    const file = join(this.deps.dir, action.sound);
    try {
      await access(file);
    } catch {
      throw new ActionError('This button’s sound file is gone; upload it again');
    }
    const entry: Playing = { ended: false };
    const set = this.playing.get(key) ?? new Set<Playing>();
    this.playing.set(key, set);
    set.add(entry);
    this.publish();
    try {
      entry.playback = await this.deps.backend.start(file, (action.volume ?? 100) / 100, () => this.ended(key, entry));
    } catch (err) {
      this.ended(key, entry);
      throw err;
    }
    // Stopped (or done) while it was starting.
    if (entry.ended) return entry.playback.stop();
    this.deps.log.debug(`Playing ${action.name ?? action.sound}`);
  }

  stopAll(): void {
    for (const key of [...this.playing.keys()]) this.stopKey(key);
  }

  private stopKey(key: string): void {
    for (const entry of this.playing.get(key) ?? []) {
      entry.playback?.stop();
      this.ended(key, entry);
    }
  }

  private ended(key: string, entry: Playing): void {
    if (entry.ended) return;
    entry.ended = true;
    const set = this.playing.get(key);
    set?.delete(entry);
    if (set?.size === 0) this.playing.delete(key);
    this.publish();
  }

  /** Which buttons' sounds play, for the browsers. */
  private publish(): void {
    const keys = [...this.playing.keys()];
    const state = this.deps.store.state;
    if (keys.length === state.sounds.length && keys.every((k) => state.sounds.includes(k))) return;
    state.sounds = keys;
    this.deps.store.changed();
  }
}
