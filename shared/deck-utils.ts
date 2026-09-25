// Small deck helpers shared by server and browser. No runtime dependencies (zod stays server-side).
import type { Action, Button, Deck, Page } from './schema.ts';

export const LIMITS = { maxRows: 8, maxCols: 12, maxPages: 64 } as const;
export const DEFAULT_OBS_URL = 'ws://127.0.0.1:4455';
export const DEFAULT_PAGE_SIZE = { rows: 3, cols: 5 } as const;

/** Uploaded images are stored under a content hash: 16 hex chars + extension. */
export const UPLOAD_NAME_RE = /^[a-f0-9]{16}\.(png|jpg|webp|gif|svg)$/;
export const ICON_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ICON_SETS = ['mdi', 'simple-icons'] as const;
export type IconSet = (typeof ICON_SETS)[number];

export const slotKey = (row: number, col: number): string => `${row}-${col}`;

export function parseSlot(key: string): [row: number, col: number] {
  const [row, col] = key.split('-').map(Number);
  return [row, col];
}

export function slotInBounds(page: Pick<Page, 'rows' | 'cols'>, key: string): boolean {
  const [row, col] = parseSlot(key);
  return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0 && row < page.rows && col < page.cols;
}

/** First free slot in row-major order, or undefined when the page is full. */
export function firstEmptySlot(page: Page): string | undefined {
  for (let row = 0; row < page.rows; row++) {
    for (let col = 0; col < page.cols; col++) {
      const key = slotKey(row, col);
      if (!page.buttons[key]) return key;
    }
  }
  return undefined;
}

export function findPage(deck: Deck, pageId: string): Page | undefined {
  return deck.pages.find((p) => p.id === pageId);
}

export function findButton(
  deck: Deck,
  pageId: string,
  buttonId: string,
): { page: Page; slot: string; button: Button } | undefined {
  const page = findPage(deck, pageId);
  if (!page) return undefined;
  for (const [slot, button] of Object.entries(page.buttons)) {
    if (button.id === buttonId) return { page, slot, button };
  }
  return undefined;
}

/** Slots that would fall outside the grid if the page were resized to rows×cols. */
export function slotsOutside(page: Page, rows: number, cols: number): string[] {
  return Object.keys(page.buttons).filter((key) => !slotInBounds({ rows, cols }, key));
}

/** Every action on the deck: taps, long presses and the steps of macros. */
export function deckActions(deck: Deck): Action[] {
  const actions: Action[] = [];
  for (const page of deck.pages) {
    for (const button of Object.values(page.buttons)) {
      for (const action of [button.tap, button.longPress]) {
        if (!action) continue;
        actions.push(action);
        if (action.type === 'macro') for (const step of action.steps) if ('action' in step) actions.push(step.action);
      }
    }
  }
  return actions;
}
