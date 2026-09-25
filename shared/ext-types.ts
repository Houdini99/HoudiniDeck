// State from outside OBS (media players, system volume; later stats) that the server pushes to
// every browser, next to the OBS mirror. Types and pure helpers only: the browser imports this.

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

export type AudioTarget = 'output' | 'input';

export interface AudioDevice {
  /** 1 = 100% (as in the desktop's volume slider); above 1 is amplified. */
  volume: number;
  muted: boolean;
}

export interface AudioState {
  /** false when wpctl isn't installed. */
  available: boolean;
  /** The default speakers and microphone. Missing until read; null when there is no such device. */
  output?: AudioDevice | null;
  input?: AudioDevice | null;
}

export interface ExtState {
  media: MediaState;
  audio: AudioState;
}

export function emptyExtState(): ExtState {
  return { media: { available: true, players: {} }, audio: { available: true } };
}

/** The player a media button refers to (its `player` field, or '' for whichever is active). */
export function followedPlayer(ext: ExtState, player: string | undefined): PlayerInfo | null | undefined {
  return ext.media.players[player ?? ''];
}
