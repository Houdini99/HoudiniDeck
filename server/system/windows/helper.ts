// The deck's helper on Windows (helper.ps1): one long-running Windows PowerShell process for System
// Volume, Keyboard Shortcut and Media Keys buttons, which Linux handles with wpctl, ydotool and
// playerctl. Requests and answers are JSON lines. It starts when first needed and again after it stops.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ActionError } from '../../actions/executor.ts';
import { windowsPowerShell } from '../../env.ts';
import { errorMessage, type Logger } from '../../log.ts';

export const HELPER_SCRIPT = fileURLToPath(new URL('./helper.ps1', import.meta.url));

/** Compiling the helper's C# part takes a few seconds on its first start. */
const START_TIMEOUT_MS = 30_000;
const TIMEOUT_MS = 10_000;
/** After failed starts, wait this long before trying again (so a broken PowerShell isn't started every 2 s). */
const COOLDOWN_MS = [2000, 10_000, 30_000, 60_000];

/** The helper can't run at all (e.g. PowerShell is blocked); callers treat it like a missing program. */
export class HelperUnavailableError extends ActionError {}

/** What callers need from the helper; tests pass fakes. */
export interface WinRequester {
  /** Resolves with the answer's data; rejects with an ActionError whose message can be shown. */
  request<T = unknown>(op: string, args?: Record<string, unknown>): Promise<T>;
}

/** A media session as the helper reports it ("Spotify.exe", "Chrome", …). */
export interface WinMediaSession {
  /** Windows' app id for the player (AppUserModelId). */
  id: string;
  /** Playing, Paused, Stopped, Changing, Opened or Closed. */
  status: string;
  artist: string;
  title: string;
  /** Cover art saved to a temp file, and a short hash of it (so a new picture gets a new URL). */
  art?: string | null;
  artHash?: string | null;
}

export interface WinMediaState {
  /** The session Windows shows as current, if any. */
  current: string | null;
  sessions: WinMediaSession[];
  /** Set when the media API failed (e.g. on a Windows too old for it). */
  error?: string;
}

export interface WinHelperDeps {
  log: Logger;
  /** For tests: starts a stand-in that speaks the same protocol. */
  spawn?: () => ChildProcessWithoutNullStreams;
  timeoutMs?: number;
  startTimeoutMs?: number;
  cooldownMs?: number[];
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function spawnHelper(): ChildProcessWithoutNullStreams {
  // -ExecutionPolicy Bypass applies to this process only; Windows blocks .ps1 files by default.
  return spawn(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_SCRIPT], {
    stdio: 'pipe',
    windowsHide: true,
  });
}

/** JSON with non-ASCII characters escaped, so the pipe's encoding can't matter. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export class WinHelper extends EventEmitter<{ media: [state: WinMediaState] }> implements WinRequester {
  private child?: ChildProcessWithoutNullStreams;
  private ready = false;
  private startedAt = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private failures = 0;
  private blockedUntil = 0;
  private lastFailure = '';
  private restartTimer?: NodeJS.Timeout;
  private watchingMedia = false;
  private stopped = false;
  private readonly deps: WinHelperDeps;

  constructor(deps: WinHelperDeps) {
    super();
    this.deps = deps;
  }

  /** Start the helper now (e.g. so the first key press doesn't wait for it). Returns false if it's already running or can't start yet. */
  start(): boolean {
    if (this.child || this.stopped || Date.now() < this.blockedUntil) return false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.deps.spawn ?? spawnHelper)();
    } catch (err) {
      this.failed(errorMessage(err));
      return false;
    }
    this.child = child;
    this.ready = false;
    this.startedAt = Date.now();
    let stderr = '';
    createInterface({ input: child.stdout }).on('line', (line) => this.child === child && this.onLine(line));
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk).slice(-2000)));
    child.stdin.on('error', () => {}); // it went away; 'close' reports why
    child.on('error', (err) => this.onExit(child, err.message));
    child.on('close', (code) => this.onExit(child, stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `exit code ${code}`));
    if (this.watchingMedia) this.write({ id: 0, op: 'media.watch', on: true });
    return true;
  }

  request<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.stopped) return Promise.reject(new ActionError('The server is shutting down'));
    this.start();
    if (!this.child) return Promise.reject(new HelperUnavailableError(this.unavailableMessage()));
    const id = this.nextId++;
    const timeoutMs = this.ready ? (this.deps.timeoutMs ?? TIMEOUT_MS) : (this.deps.startTimeoutMs ?? START_TIMEOUT_MS);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ActionError('The Windows helper didn’t answer in time'));
        // Something in it hangs: let it go now (the next request starts a fresh one).
        const child = this.child;
        if (!child) return;
        child.kill();
        this.onExit(child, `it didn’t answer “${op}” within ${timeoutMs / 1000} s`);
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
      this.write({ ...args, id, op });
    });
  }

  /** Media updates (the 'media' event) while on; the helper polls the players about once a second. */
  setMediaWatch(on: boolean): void {
    if (on === this.watchingMedia) return;
    this.watchingMedia = on;
    if (on) {
      if (!this.start()) this.write({ id: 0, op: 'media.watch', on: true });
    } else {
      this.write({ id: 0, op: 'media.watch', on: false });
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = undefined;
    child?.kill();
    this.rejectAll(new ActionError('The server is shutting down'));
  }

  private write(msg: Record<string, unknown>): void {
    if (this.child?.stdin.writable) this.child.stdin.write(`${asciiJson(msg)}\n`);
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; ok?: boolean; data?: unknown; error?: string; event?: string; state?: WinMediaState };
    try {
      msg = JSON.parse(line);
    } catch {
      if (line.trim()) this.deps.log.debug(`Windows helper: ${line.trim()}`);
      return;
    }
    if (msg.event === 'ready') {
      this.ready = true;
      this.failures = 0;
      this.deps.log.debug(`Windows helper started in ${Date.now() - this.startedAt} ms`);
      return;
    }
    if (msg.event === 'media' && msg.state) {
      this.emit('media', msg.state);
      return;
    }
    const pending = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!pending) return;
    this.pending.delete(msg.id as number);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.data ?? null);
    else pending.reject(new ActionError(msg.error || 'The Windows helper failed'));
  }

  private onExit(child: ChildProcessWithoutNullStreams, why: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    const wasReady = this.ready;
    this.ready = false;
    if (wasReady) {
      if (!this.stopped) this.deps.log.warn(`The Windows helper stopped (${why}); it starts again when needed`);
      this.rejectAll(new ActionError(`The Windows helper stopped (${why})`));
    } else {
      this.failed(why);
    }
    // Media updates should keep coming without waiting for someone to press a button.
    if (this.watchingMedia && !this.stopped) {
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.start(), Math.max(1000, this.blockedUntil - Date.now()));
    }
  }

  /** It couldn't start: wait a while before the next attempt. */
  private failed(why: string): void {
    this.failures++;
    const cooldowns = this.deps.cooldownMs ?? COOLDOWN_MS;
    this.blockedUntil = Date.now() + cooldowns[Math.min(this.failures, cooldowns.length) - 1];
    this.lastFailure = why;
    if (this.failures === 1) this.deps.log.warn(this.unavailableMessage());
    this.rejectAll(new HelperUnavailableError(this.unavailableMessage()));
  }

  private unavailableMessage(): string {
    return `Windows PowerShell couldn’t start the deck’s helper${this.lastFailure ? ` (${this.lastFailure})` : ''}`;
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
