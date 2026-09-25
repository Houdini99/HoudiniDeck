import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_PAGE_SIZE } from '../../shared/deck-utils.ts';
import { DeckSchema, type Deck } from '../../shared/schema.ts';
import { errorMessage, type Logger } from '../log.ts';
import { quarantine, readJsonFile, writeJsonAtomic } from './files.ts';

const BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const BACKUPS_KEPT = 20;

export function newId(): string {
  return randomBytes(6).toString('base64url');
}

export function defaultDeck(): Deck {
  const id = newId();
  return {
    version: 1,
    revision: 0,
    homePageId: id,
    pages: [{ id, name: 'Main', ...DEFAULT_PAGE_SIZE, buttons: {} }],
  };
}

/**
 * data/deck.json: pages and buttons. Every save is atomic; older versions rotate into data/backups/.
 * Emits 'change' after each save.
 */
export class DeckStore extends EventEmitter<{ change: [deck: Deck] }> {
  private lastBackupAt = 0;
  private readonly dir: string;
  private readonly log: Logger;
  deck: Deck;

  private constructor(dir: string, deck: Deck, log: Logger) {
    super();
    this.dir = dir;
    this.deck = deck;
    this.log = log;
  }

  get path(): string {
    return join(this.dir, 'deck.json');
  }

  static async load(dataDir: string, log: Logger): Promise<DeckStore> {
    const path = join(dataDir, 'deck.json');
    let raw: unknown;
    try {
      raw = await readJsonFile(path);
    } catch (err) {
      const moved = await quarantine(path);
      log.error(`deck.json is not valid JSON (${errorMessage(err)}). Moved it to ${moved}; starting with an empty deck.`);
    }

    if (raw === undefined) {
      const store = new DeckStore(dataDir, defaultDeck(), log);
      await writeJsonAtomic(path, store.deck);
      return store;
    }

    const parsed = DeckSchema.safeParse(raw);
    if (parsed.success) return new DeckStore(dataDir, parsed.data, log);

    const moved = await quarantine(path);
    log.error(`deck.json failed validation. Moved it to ${moved}; starting with an empty deck.\n${z.prettifyError(parsed.error)}`);
    const store = new DeckStore(dataDir, defaultDeck(), log);
    await writeJsonAtomic(path, store.deck);
    return store;
  }

  /** Persist a new deck version. Callers must serialize calls (the hub runs ops one at a time). */
  async replace(next: Deck, opts: { backupReason?: string } = {}): Promise<Deck> {
    const now = Date.now();
    if (opts.backupReason || now - this.lastBackupAt > BACKUP_INTERVAL_MS) {
      await this.backup(opts.backupReason ?? 'auto');
      this.lastBackupAt = now;
    }
    const saved = { ...next, revision: this.deck.revision + 1 };
    await writeJsonAtomic(this.path, saved);
    this.deck = saved;
    this.emit('change', saved);
    return saved;
  }

  private async backup(reason: string): Promise<void> {
    const dir = join(this.dir, 'backups');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      await writeJsonAtomic(join(dir, `deck-${stamp}-${reason}.json`), this.deck);
      const files = (await readdir(dir)).filter((f) => f.startsWith('deck-') && f.endsWith('.json')).sort();
      for (const old of files.slice(0, Math.max(0, files.length - BACKUPS_KEPT))) {
        await rm(join(dir, old), { force: true });
      }
    } catch (err) {
      this.log.warn(`Could not write a deck backup: ${errorMessage(err)}`);
    }
  }
}
