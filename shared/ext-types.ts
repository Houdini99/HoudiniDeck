// State from outside OBS (media players; later system volume and stats) that the server pushes
// to every browser, next to the OBS mirror. Types and pure helpers only: the browser imports this.

export type PlayerStatus = 'Playing' | 'Paused' | 'Stopped';

export interface PlayerInfo {
  /** playerctl's name for the player, e.g. "spotify" or "firefox.instance_1234". */
  instance: string;
  status: PlayerStatus;
  artist: string;
  title: string;
  /** Cover art the browser can load: an https:// URL or /api/media/art/…, if the player has any. */
  art?: string;
}

export interface MediaState {
  /** false when playerctl isn't installed (or can't reach the session bus). */
  available: boolean;
  /**
   * What each followed player is doing, by the name buttons use: '' is whichever player was active
   * last, 'spotify' is the Spotify player. null means no such player is running.
   */
  players: Record<string, PlayerInfo | null>;
}

export interface ExtState {
  media: MediaState;
}

export function emptyExtState(): ExtState {
  return { media: { available: true, players: {} } };
}

/** The player a media button refers to (its `player` field, or '' for whichever is active). */
export function followedPlayer(ext: ExtState, player: string | undefined): PlayerInfo | null | undefined {
  return ext.media.players[player ?? ''];
}
