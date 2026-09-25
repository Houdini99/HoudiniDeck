// Undo and redo for deck edits (anyone's): the decks before the most recent edits, kept in memory.
import type { HistoryInfo } from '../../shared/protocol.ts';
import type { Deck, DeckOp } from '../../shared/schema.ts';

const KEPT = 30;

interface Entry {
  deck: Deck;
  /** What the edit did, e.g. "delete button". */
  label: string;
}

/** What Undo would take back, in a few words. */
export function opLabel(op: DeckOp): string {
  switch (op.op) {
    case 'page.add':
      return 'new page';
    case 'page.update':
      return 'page change';
    case 'page.delete':
      return 'deleted page';
    case 'page.move':
      return 'page move';
    case 'page.duplicate':
      return 'page copy';
    case 'button.set':
      return op.button ? 'button change' : 'deleted button';
    case 'button.move':
      return 'button move';
    case 'button.duplicate':
      return 'button copy';
    case 'folder.create':
      return 'new folder';
    case 'deck.setHome':
      return 'home page change';
    case 'deck.import':
      return 'deck import';
    case 'deck.generateStarter':
      return 'generated page';
    case 'deck.undo':
    case 'deck.redo':
      return '';
  }
}

const sameDeck = (a: Deck, b: Deck) => a.homePageId === b.homePageId && JSON.stringify(a.pages) === JSON.stringify(b.pages);

export class DeckHistory {
  private readonly undos: Entry[] = [];
  private readonly redos: Entry[] = [];

  /** An edit was saved; `before` is the deck it replaced. Edits that changed nothing aren't kept. */
  record(before: Deck, after: Deck, label: string): void {
    if (sameDeck(before, after)) return;
    this.undos.push({ deck: before, label });
    if (this.undos.length > KEPT) this.undos.shift();
    this.redos.length = 0;
  }

  /** The deck Undo goes back to (it stays until undone() says the undo was saved). */
  nextUndo(): Deck | undefined {
    return this.undos.at(-1)?.deck;
  }

  nextRedo(): Deck | undefined {
    return this.redos.at(-1)?.deck;
  }

  /** The undo was saved; `replaced` is the deck it replaced, which Redo brings back. */
  undone(replaced: Deck): void {
    const entry = this.undos.pop();
    if (entry) this.redos.push({ deck: replaced, label: entry.label });
  }

  redone(replaced: Deck): void {
    const entry = this.redos.pop();
    if (entry) this.undos.push({ deck: replaced, label: entry.label });
  }

  get info(): HistoryInfo {
    return { undo: this.undos.at(-1)?.label, redo: this.redos.at(-1)?.label };
  }
}
