// Live pictures for scene buttons that ask for one (Switch Scene with "Show a live picture"): a small
// GetSourceScreenshot every couple of seconds, one scene after the other, and only for the scenes some
// browser shows right now. OBS renders each picture, so this costs it a little GPU and CPU.
import { EventEmitter } from 'node:events';
import type { OBSWebSocket } from 'obs-websocket-js/json';
import { errorMessage, type Logger } from '../log.ts';

const INTERVAL_MS = 2000;
const WIDTH = 256;
export const MAX_THUMBNAIL_SCENES = 32;

export interface ThumbnailDeps {
  obs: { readonly connected: boolean; readonly client: Pick<OBSWebSocket, 'call'> };
  log: Logger;
  intervalMs?: number;
}

export class SceneThumbnails extends EventEmitter<{ images: [changed: Record<string, string>] }> {
  /** The latest picture of each wanted scene, as a data: URL. */
  readonly images: Record<string, string> = {};
  private wanted: string[] = [];
  private timer?: NodeJS.Timeout;
  private busy = false;
  private readonly deps: ThumbnailDeps;

  constructor(deps: ThumbnailDeps) {
    super();
    this.deps = deps;
  }

  setWanted(scenes: string[]): void {
    this.wanted = [...new Set(scenes)].slice(0, MAX_THUMBNAIL_SCENES);
    for (const scene of Object.keys(this.images)) if (!this.wanted.includes(scene)) delete this.images[scene];
    if (this.wanted.length === 0) {
      clearTimeout(this.timer);
      this.timer = undefined;
    } else if (!this.timer && !this.busy) {
      this.schedule(0);
    }
  }

  stop(): void {
    this.setWanted([]);
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => void this.round(), ms);
  }

  private async round(): Promise<void> {
    this.timer = undefined;
    this.busy = true;
    const changed: Record<string, string> = {};
    try {
      for (const scene of this.deps.obs.connected ? this.wanted : []) {
        const image = await this.picture(scene);
        if (image && this.wanted.includes(scene) && this.images[scene] !== image) {
          this.images[scene] = image;
          changed[scene] = image;
        }
      }
    } finally {
      this.busy = false;
    }
    if (Object.keys(changed).length) this.emit('images', changed);
    if (this.wanted.length && !this.timer) this.schedule(this.deps.intervalMs ?? INTERVAL_MS);
  }

  private async picture(scene: string): Promise<string | undefined> {
    try {
      const { imageData } = await this.deps.obs.client.call('GetSourceScreenshot', {
        sourceName: scene,
        imageFormat: 'jpg',
        imageWidth: WIDTH,
        imageCompressionQuality: 70,
      });
      // OBS labels JPEGs "image/jpg", which isn't a registered type.
      return imageData.replace(/^data:image\/jpg;/, 'data:image/jpeg;');
    } catch (err) {
      this.deps.log.debug(`No picture of “${scene}”: ${errorMessage(err)}`);
      return undefined;
    }
  }
}
