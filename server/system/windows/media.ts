// Media Keys on Windows: the media sessions Windows shows next to its volume slider (Spotify, browsers,
// …). The helper reads them about once a second while a browser is connected and the deck has Media
// Keys buttons; on Linux, ../media.ts does this with playerctl.
import type { PlayerInfo, PlayerStatus } from '../../../shared/ext-types.ts';
import type { ActionOf, Deck } from '../../../shared/schema.ts';
import { ActionError } from '../../actions/executor.ts';
import type { ExtStore } from '../../ext-store.ts';
import type { Logger } from '../../log.ts';
import { ArtFiles, mediaSelectors, type ArtSlot, type MediaSource } from '../media.ts';
import type { WinMediaSession, WinMediaState, WinRequester } from './helper.ts';

/** Players whose app id doesn't say what they are (Firefox's is a hash of its install folder). */
const KNOWN_APPS: Record<string, string> = { '308046b0af4a39cb': 'firefox' };

const STATUS: Record<string, PlayerStatus> = { Playing: 'Playing', Changing: 'Playing', Paused: 'Paused' };

/** A short name for a player's app id, like playerctl's: "Spotify.exe" → "spotify", "Chrome" → "chrome". */
export function playerName(appId: string): string {
  const app = appId.split('!').pop()!.split('\\').pop()!.replace(/\.exe$/i, '').toLowerCase();
  return KNOWN_APPS[app] ?? app;
}

/**
 * The session a button means: a named player ("spotify" also matches "spotify.2"), preferring one that
 * plays; without a name, the one Windows shows as current.
 */
export function pickSession(state: WinMediaState, selector: string): WinMediaSession | undefined {
  const { sessions } = state;
  if (!selector) return sessions.find((s) => s.id === state.current) ?? sessions.find((s) => s.status === 'Playing') ?? sessions[0];
  const wanted = selector.toLowerCase();
  const matching = sessions.filter((s) => {
    const name = playerName(s.id);
    return name === wanted || name.startsWith(`${wanted}.`) || s.id.toLowerCase() === wanted;
  });
  return matching.find((s) => s.status === 'Playing') ?? matching[0];
}

function hasMediaButtons(deck: Deck): boolean {
  return deck.pages.some((page) =>
    Object.values(page.buttons).some((b) => b.tap?.type === 'media.player' || b.longPress?.type === 'media.player'),
  );
}

/** What the watcher needs from the helper (WinHelper; tests pass a fake). */
export interface MediaHelper extends WinRequester {
  setMediaWatch(on: boolean): void;
  on(event: 'media', listener: (state: WinMediaState) => void): unknown;
}

export interface WindowsMediaDeps {
  store: ExtStore;
  helper: MediaHelper;
  log: Logger;
}

export class WindowsMediaWatcher implements MediaSource {
  private active = false;
  private hasButtons = false;
  private selectors: string[] = [''];
  /** The latest reading while watching. */
  private state?: WinMediaState;
  private readonly art = new ArtFiles();
  private readonly slots = new Map<string, ArtSlot>();
  private readonly deps: WindowsMediaDeps;

  constructor(deps: WindowsMediaDeps) {
    this.deps = deps;
    deps.helper.on('media', (state) => this.onState(state));
  }

  private get media() {
    return this.deps.store.state.media;
  }

  /** Only then is the helper asked for updates (it's a PowerShell process, so not for decks without media buttons). */
  private get watching(): boolean {
    return this.active && this.hasButtons && this.media.available;
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active && !this.media.available) {
      this.media.available = true; // try again: whatever failed may work now
      this.deps.store.changed();
    }
    this.sync();
  }

  setDeck(deck: Deck): void {
    this.hasButtons = hasMediaButtons(deck);
    this.selectors = ['', ...mediaSelectors(deck)];
    this.sync();
  }

  currentInstance(): string | undefined {
    return this.media.players['']?.instance;
  }

  artFile(token: string): string | undefined {
    return this.art.file(token);
  }

  async listPlayers(): Promise<string[]> {
    try {
      const state = await this.deps.helper.request<WinMediaState>('media.state');
      return [...new Set(state.sessions.map((s) => playerName(s.id)))];
    } catch {
      return [];
    }
  }

  /** A Media Keys press: the player is looked up fresh, so the press goes where the music is now. */
  async command(action: ActionOf<'media.player'>): Promise<void> {
    const state = await this.deps.helper.request<WinMediaState>('media.state');
    const session = pickSession(state, action.player ?? '');
    if (!session) throw new ActionError(action.player ? `“${action.player}” is not running` : 'No media player is running');
    const { accepted } = await this.deps.helper.request<{ accepted: boolean }>('media.control', { id: session.id, command: action.command });
    if (!accepted) throw new ActionError(`${playerName(session.id)} can’t do that right now`);
  }

  stop(): void {
    this.active = false;
    this.sync();
  }

  private sync(): void {
    this.deps.helper.setMediaWatch(this.watching);
    if (this.watching) return this.publish();
    this.state = undefined;
    for (const slot of this.slots.values()) this.art.release(slot);
    this.slots.clear();
    if (Object.keys(this.media.players).length === 0) return;
    this.media.players = {};
    this.deps.store.changed();
  }

  private onState(state: WinMediaState): void {
    if (!this.watching) return;
    if (state.error) {
      this.deps.log.warn(`Windows’ media controls can’t be read (${state.error}), so media buttons won’t work`);
      this.media.available = false;
      this.sync();
      this.deps.store.changed();
      return;
    }
    this.state = state;
    this.publish();
  }

  /** What each followed player does, from the latest reading. */
  private publish(): void {
    if (!this.state) return; // not read yet
    const players: Record<string, PlayerInfo | null> = {};
    for (const selector of this.selectors) {
      const slot = this.slots.get(selector) ?? {};
      this.slots.set(selector, slot);
      const session = pickSession(this.state, selector);
      if (session) players[selector] = this.info(slot, session);
      else {
        players[selector] = null;
        this.art.release(slot);
      }
    }
    for (const [selector, slot] of this.slots) {
      if (this.selectors.includes(selector)) continue;
      this.art.release(slot);
      this.slots.delete(selector);
    }
    if (JSON.stringify(players) === JSON.stringify(this.media.players)) return;
    this.media.players = players;
    this.deps.store.changed();
  }

  private info(slot: ArtSlot, session: WinMediaSession): PlayerInfo {
    const { art, artHash, artist, title } = session;
    const info: PlayerInfo = { instance: playerName(session.id), status: STATUS[session.status] ?? 'Stopped', artist, title };
    // The file is reused for the player's next cover, so the picture's hash is part of the key.
    if (art) info.art = this.art.url(slot, `${art}\n${artHash}\n${artist}\n${title}`, () => art);
    else this.art.release(slot);
    return info;
  }
}
