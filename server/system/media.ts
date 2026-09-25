// Follows media players (MPRIS) with `playerctl --follow` while at least one browser is connected:
// one process for whichever player was active last, plus one per player a button names.
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { PlayerInfo, PlayerStatus } from '../../shared/ext-types.ts';
import type { Deck } from '../../shared/schema.ts';
import type { ExtStore } from '../ext-store.ts';
import type { Logger } from '../log.ts';
import { IMAGE_MIME, sniffImage } from '../uploads.ts';
import type { LineProcess, Runner, Spawner } from './process.ts';

const FORMAT = ['{{playerInstance}}', '{{status}}', '{{artist}}', '{{title}}', '{{mpris:artUrl}}'].join('\t');
const RESTART_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000];
const MAX_ART_BYTES = 10 * 1024 * 1024;
const ART_TOKEN_RE = /^[a-f0-9]{32}$/;
const STATUSES: readonly string[] = ['Playing', 'Paused', 'Stopped'] satisfies PlayerStatus[];

export interface PlayerLine {
  instance: string;
  status: PlayerStatus;
  artist: string;
  title: string;
  artUrl: string;
}

/** One line of `playerctl --follow` output; an empty line means the player went away. */
export function parsePlayerLine(line: string): PlayerLine | null {
  const parts = line.split('\t');
  if (parts.length < 5 || !parts[0]) return null;
  const [instance, status, artist, ...rest] = parts;
  const artUrl = rest.pop()!;
  return {
    instance,
    status: (STATUSES.includes(status) ? status : 'Stopped') as PlayerStatus,
    artist,
    title: rest.join('\t'), // a title may itself contain a tab
    artUrl,
  };
}

/** Players that buttons on the deck name explicitly (each gets its own follower). */
export function mediaSelectors(deck: Deck): string[] {
  const names = new Set<string>();
  for (const page of deck.pages) {
    for (const button of Object.values(page.buttons)) {
      for (const action of [button.tap, button.longPress]) {
        if (action?.type === 'media.player' && action.player) names.add(action.player);
      }
    }
  }
  return [...names];
}

export interface MediaWatcherDeps {
  store: ExtStore;
  spawn: Spawner;
  run: Runner;
  log: Logger;
  restartDelaysMs?: number[];
}

interface Follower {
  proc?: LineProcess;
  timer?: NodeJS.Timeout;
  failures: number;
  /** Art currently served for this player: which track it belongs to and under which token. */
  art?: { key: string; token: string };
}

export class MediaWatcher {
  private active = false;
  private selectors = new Set<string>(['']);
  private readonly followers = new Map<string, Follower>();
  /** token → local file, for cover art the players give as file:// URLs. */
  private readonly artFiles = new Map<string, string>();
  private warnedMissing = false;
  private readonly deps: MediaWatcherDeps;

  constructor(deps: MediaWatcherDeps) {
    this.deps = deps;
  }

  private get media() {
    return this.deps.store.state.media;
  }

  /** Follow players only while a browser is connected. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active && !this.media.available) {
      this.media.available = true; // playerctl may have been installed meanwhile
      this.deps.store.changed();
    }
    this.sync();
  }

  /** Buttons may name players; those are followed as well. */
  setDeck(deck: Deck): void {
    this.selectors = new Set(['', ...mediaSelectors(deck)]);
    this.sync();
  }

  /** The player the buttons show, for commands that don't name one. */
  currentInstance(): string | undefined {
    return this.media.players['']?.instance;
  }

  artFile(token: string): string | undefined {
    return ART_TOKEN_RE.test(token) ? this.artFiles.get(token) : undefined;
  }

  /** Names of the running players (without the instance suffix), for the editor. */
  async listPlayers(): Promise<string[]> {
    try {
      const res = await this.deps.run('playerctl', ['--list-all']);
      const names = res.stdout.split('\n').map((l) => l.trim().split('.')[0]);
      return [...new Set(names.filter(Boolean))];
    } catch {
      return [];
    }
  }

  stop(): void {
    this.active = false;
    this.sync();
  }

  private sync(): void {
    const wanted = this.active && this.media.available ? this.selectors : new Set<string>();
    let changed = false;
    for (const [selector, follower] of this.followers) {
      if (wanted.has(selector)) continue;
      this.drop(selector, follower);
      changed = true;
    }
    for (const selector of wanted) {
      if (!this.followers.has(selector)) this.start(selector, { failures: 0 });
    }
    if (changed) this.deps.store.changed();
  }

  private start(selector: string, follower: Follower): void {
    this.followers.set(selector, follower);
    const args = [...(selector ? [`--player=${selector}`] : []), '--follow', 'metadata', '--format', FORMAT];
    follower.proc = this.deps.spawn('playerctl', args, {
      line: (line) => {
        follower.failures = 0;
        this.update(selector, follower, parsePlayerLine(line));
      },
      exit: (code, error, stderr) => this.onExit(selector, follower, code, error, stderr),
    });
  }

  private onExit(selector: string, follower: Follower, code: number | null, error?: NodeJS.ErrnoException, stderr?: string): void {
    follower.proc = undefined;
    if (this.followers.get(selector) !== follower) return; // dropped meanwhile
    if (error?.code === 'ENOENT') {
      if (!this.warnedMissing) this.deps.log.warn('playerctl is not installed, so media buttons won’t work');
      this.warnedMissing = true;
      this.media.available = false;
      this.sync();
      this.deps.store.changed();
      return;
    }
    const delays = this.deps.restartDelaysMs ?? RESTART_DELAYS_MS;
    const delay = delays[Math.min(follower.failures, delays.length - 1)];
    follower.failures++;
    const why = error?.message ?? (stderr || `exit code ${code}`);
    if (follower.failures === 3) this.deps.log.warn(`playerctl keeps stopping (${why}); media buttons may not update`);
    else this.deps.log.debug(`playerctl stopped (${why}); restarting in ${delay} ms`);
    this.update(selector, follower, null);
    follower.timer = setTimeout(() => {
      follower.timer = undefined;
      if (this.followers.get(selector) === follower) this.start(selector, follower);
    }, delay);
  }

  private drop(selector: string, follower: Follower): void {
    this.followers.delete(selector);
    follower.proc?.kill();
    clearTimeout(follower.timer);
    this.releaseArt(follower);
    delete this.media.players[selector];
  }

  private update(selector: string, follower: Follower, line: PlayerLine | null): void {
    let info: PlayerInfo | null = null;
    if (line) {
      const { artUrl, ...rest } = line;
      info = { ...rest, art: this.artFor(follower, line) };
    } else {
      this.releaseArt(follower);
    }
    this.media.players[selector] = info;
    this.deps.store.changed();
  }

  /** A URL the browser can load for the player's cover art: https as is, local files via /api/media/art. */
  private artFor(follower: Follower, line: PlayerLine): string | undefined {
    const url = line.artUrl;
    if (url.startsWith('https://')) {
      this.releaseArt(follower);
      return url;
    }
    if (!url.startsWith('file://')) {
      this.releaseArt(follower);
      return undefined;
    }
    // A new token for each new track: some players reuse one file name for every cover.
    const key = `${url}\n${line.artist}\n${line.title}`;
    if (follower.art?.key !== key) {
      let path: string;
      try {
        path = fileURLToPath(url);
      } catch {
        this.releaseArt(follower);
        return undefined;
      }
      this.releaseArt(follower);
      const token = randomBytes(16).toString('hex');
      this.artFiles.set(token, path);
      follower.art = { key, token };
    }
    return `/api/media/art/${follower.art!.token}`;
  }

  private releaseArt(follower: Follower): void {
    if (follower.art) this.artFiles.delete(follower.art.token);
    follower.art = undefined;
  }
}

/** Serves local cover art. Only files a player currently reports, and only if they're images. */
export function registerMediaRoutes(app: FastifyInstance, media: Pick<MediaWatcher, 'artFile'>): void {
  app.get<{ Params: { token: string } }>('/api/media/art/:token', async (req, reply) => {
    const path = media.artFile(req.params.token);
    if (!path) return reply.code(404).send({ error: 'Not found' });
    let buf: Buffer;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_ART_BYTES) return reply.code(404).send({ error: 'Not found' });
      buf = await readFile(path);
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
    const ext = sniffImage(buf);
    if (!ext || ext === 'svg') return reply.code(404).send({ error: 'Not found' });
    return reply
      .type(IMAGE_MIME[ext])
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=3600')
      .send(buf);
  });
}
