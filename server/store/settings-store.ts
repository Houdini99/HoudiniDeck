import { randomBytes } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SettingsSchema, type Settings } from '../../shared/schema.ts';
import type { Env } from '../env.ts';
import { errorMessage, type Logger } from '../log.ts';
import { quarantine, readJsonFile, writeJsonAtomic } from './files.ts';

export function newAccessKey(): string {
  return randomBytes(32).toString('base64url');
}

export interface ObsConnectionConfig {
  url: string;
  password: string;
  /** True when OBS_URL / OBS_PASSWORD override the saved settings. */
  fromEnv: boolean;
}

/** data/settings.json: OBS connection and the access key. Holds secrets, so it's written 0600. */
export class SettingsStore {
  readonly path: string;
  settings: Settings;

  private constructor(path: string, settings: Settings) {
    this.path = path;
    this.settings = settings;
  }

  static async load(dataDir: string, log: Logger): Promise<SettingsStore> {
    const path = join(dataDir, 'settings.json');
    let raw: unknown;
    try {
      raw = await readJsonFile(path);
    } catch (err) {
      const moved = await quarantine(path);
      log.warn(`settings.json could not be read (${errorMessage(err)}); moved it to ${moved} and started fresh`);
    }

    const input = { ...(raw && typeof raw === 'object' ? raw : {}) } as Record<string, unknown>;
    if (typeof input.accessKey !== 'string' || input.accessKey.length < 16) input.accessKey = newAccessKey();
    const parsed = SettingsSchema.safeParse(input);
    if (!parsed.success) {
      log.warn(`settings.json has invalid values, using defaults where needed:\n${z.prettifyError(parsed.error)}`);
    }
    const store = new SettingsStore(path, parsed.success ? parsed.data : SettingsSchema.parse({ accessKey: input.accessKey }));
    await store.save();
    return store;
  }

  async save(): Promise<void> {
    await writeJsonAtomic(this.path, this.settings, 0o600);
    await chmod(this.path, 0o600);
  }

  async update(mutate: (s: Settings) => void): Promise<void> {
    mutate(this.settings);
    await this.save();
  }

  obsConfig(env: Pick<Env, 'obsUrl' | 'obsPassword'>): ObsConnectionConfig {
    return {
      url: env.obsUrl ?? this.settings.obs.url,
      password: env.obsPassword ?? this.settings.obs.password,
      fromEnv: env.obsUrl !== undefined || env.obsPassword !== undefined,
    };
  }
}
