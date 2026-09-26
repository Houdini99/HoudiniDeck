// Deck edits as pure functions: (deck, op) → new deck. The hub validates and persists the result.
import { z } from 'zod';
import { LIMITS, firstEmptySlot, slotInBounds, slotKey } from '../../shared/deck-utils.ts';
import type { ObsState } from '../../shared/obs-types.ts';
import { withNested } from '../../shared/deck-utils.ts';
import { DeckSchema, type Deck, type DeckOp, type Page } from '../../shared/schema.ts';
import type { DeckHistory } from './history.ts';
import { buildStarterPage } from './starter.ts';

export class OpError extends Error {}

export interface OpContext {
  obs: ObsState;
  newId: () => string;
  /** Whether Run Command buttons may be added or changed (turned on in Settings). */
  commandsEnabled?: boolean;
  /** For deck.undo and deck.redo. */
  history?: Pick<DeckHistory, 'nextUndo' | 'nextRedo'>;
}

export interface OpResult {
  deck: Deck;
  data?: Record<string, unknown>;
  /** Set when the previous deck should be backed up first (e.g. before an import). */
  backup?: string;
  /** Set for deck.undo and deck.redo: once saved, the history has to move along. */
  history?: 'undo' | 'redo';
}

function mustPage(deck: Deck, pageId: string): Page {
  const page = deck.pages.find((p) => p.id === pageId);
  if (!page) throw new OpError('That page no longer exists');
  return page;
}

function mustSlot(page: Page, slot: string): void {
  if (!slotInBounds(page, slot)) throw new OpError(`Slot ${slot} is outside the ${page.rows}×${page.cols} grid`);
}

function idTaken(deck: Deck, id: string): boolean {
  return deck.pages.some((p) => p.id === id || Object.values(p.buttons).some((b) => b.id === id));
}

function uniquePageName(deck: Deck, base: string): string {
  const names = new Set(deck.pages.map((p) => p.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

function checkPageLimit(deck: Deck): void {
  if (deck.pages.length >= LIMITS.maxPages) throw new OpError(`A deck can have at most ${LIMITS.maxPages} pages`);
}

/** Every Run Command action in the deck (macro steps and toggle sides too), as JSON. */
function commandActions(deck: Deck): string[] {
  const found: string[] = [];
  for (const page of deck.pages) {
    for (const button of Object.values(page.buttons)) {
      for (const action of [button.tap, button.longPress]) {
        if (!action) continue;
        for (const inner of withNested(action)) if (inner.type === 'system.command') found.push(JSON.stringify(inner));
      }
    }
  }
  return found;
}

/**
 * While commands are off, an edit may keep the command buttons a deck already has (e.g. move
 * them or change their label) but not add, copy, import or change any.
 */
function refuseNewCommands(before: Deck, after: Deck): void {
  const existing = new Map<string, number>();
  for (const command of commandActions(before)) existing.set(command, (existing.get(command) ?? 0) + 1);
  for (const command of commandActions(after)) {
    const left = existing.get(command) ?? 0;
    if (left === 0) {
      throw new OpError('Run Command buttons are turned off. Turn them on in Settings, in the browser on the PC itself.');
    }
    existing.set(command, left - 1);
  }
}

export function applyOp(current: Deck, op: DeckOp, ctx: OpContext): OpResult {
  const result = change(current, op, ctx);
  if (!ctx.commandsEnabled) refuseNewCommands(current, result.deck);
  return result;
}

function change(current: Deck, op: DeckOp, ctx: OpContext): OpResult {
  const deck = structuredClone(current);

  switch (op.op) {
    case 'page.add': {
      checkPageLimit(deck);
      const page: Page = { id: ctx.newId(), name: op.name, rows: op.rows, cols: op.cols, buttons: {} };
      const after = op.afterPageId ? deck.pages.findIndex((p) => p.id === op.afterPageId) : -1;
      deck.pages.splice(after >= 0 ? after + 1 : deck.pages.length, 0, page);
      return { deck, data: { pageId: page.id } };
    }
    case 'page.update': {
      const page = mustPage(deck, op.pageId);
      if (op.name !== undefined) page.name = op.name;
      page.rows = op.rows ?? page.rows;
      page.cols = op.cols ?? page.cols;
      // Shrinking drops buttons that no longer fit (the editor warns before sending this).
      for (const slot of Object.keys(page.buttons)) if (!slotInBounds(page, slot)) delete page.buttons[slot];
      return { deck };
    }
    case 'page.delete': {
      if (deck.pages.length <= 1) throw new OpError('The last page cannot be deleted');
      const index = deck.pages.findIndex((p) => p.id === op.pageId);
      if (index < 0) throw new OpError('That page no longer exists');
      deck.pages.splice(index, 1);
      if (deck.homePageId === op.pageId) deck.homePageId = deck.pages[0].id;
      return { deck };
    }
    case 'page.move': {
      const index = deck.pages.findIndex((p) => p.id === op.pageId);
      if (index < 0) throw new OpError('That page no longer exists');
      const [page] = deck.pages.splice(index, 1);
      deck.pages.splice(Math.min(op.toIndex, deck.pages.length), 0, page);
      return { deck };
    }
    case 'page.duplicate': {
      checkPageLimit(deck);
      const source = mustPage(deck, op.pageId);
      const copy: Page = { ...structuredClone(source), id: ctx.newId(), name: uniquePageName(deck, `${source.name} copy`) };
      const ids = new Map(Object.values(copy.buttons).map((b) => [b.id, ctx.newId()]));
      for (const button of Object.values(copy.buttons)) {
        button.id = ids.get(button.id)!;
        // Counters and timers that point at a button on this page now point at its copy.
        for (const action of [button.tap, button.longPress]) {
          for (const inner of action ? withNested(action) : []) {
            if ((inner.type === 'counter' || inner.type === 'timer') && inner.target && ids.has(inner.target)) inner.target = ids.get(inner.target);
          }
        }
      }
      deck.pages.splice(deck.pages.indexOf(source) + 1, 0, copy);
      return { deck, data: { pageId: copy.id } };
    }
    case 'button.set': {
      const page = mustPage(deck, op.pageId);
      mustSlot(page, op.slot);
      if (op.button === null) {
        delete page.buttons[op.slot];
        return { deck };
      }
      const existing = page.buttons[op.slot];
      let id = op.button.id;
      // Keep the id when re-saving the same button; mint one for new buttons or clashing ids.
      if (!id || (existing?.id !== id && idTaken(deck, id))) id = ctx.newId();
      page.buttons[op.slot] = { ...op.button, id };
      return { deck, data: { buttonId: id } };
    }
    case 'button.move': {
      const from = mustPage(deck, op.from.pageId);
      const to = mustPage(deck, op.to.pageId);
      const button = from.buttons[op.from.slot];
      if (!button) throw new OpError('There is no button to move');
      const target = op.to.slot ?? firstEmptySlot(to);
      if (!target) throw new OpError(`“${to.name}” is full`);
      mustSlot(to, target);
      if (from === to && op.from.slot === target) return { deck };
      const displaced = to.buttons[target];
      to.buttons[target] = button;
      if (displaced) from.buttons[op.from.slot] = displaced;
      else delete from.buttons[op.from.slot];
      return { deck, data: { slot: target } };
    }
    case 'button.duplicate': {
      const page = mustPage(deck, op.pageId);
      const button = page.buttons[op.slot];
      if (!button) throw new OpError('There is no button to duplicate');
      const target = op.toPageId ? mustPage(deck, op.toPageId) : page;
      const slot = firstEmptySlot(target);
      if (!slot) throw new OpError(target === page ? 'This page is full' : `“${target.name}” is full`);
      target.buttons[slot] = { ...structuredClone(button), id: ctx.newId() };
      return { deck, data: { slot, pageId: target.id } };
    }
    case 'folder.create': {
      checkPageLimit(deck);
      const parent = mustPage(deck, op.pageId);
      mustSlot(parent, op.slot);
      if (parent.buttons[op.slot]) throw new OpError('That slot is not empty');
      const folder: Page = {
        id: ctx.newId(),
        name: op.name,
        rows: parent.rows,
        cols: parent.cols,
        buttons: { [slotKey(0, 0)]: { id: ctx.newId(), tap: { type: 'deck.back' } } },
      };
      deck.pages.splice(deck.pages.indexOf(parent) + 1, 0, folder);
      parent.buttons[op.slot] = { id: ctx.newId(), tap: { type: 'deck.page', pageId: folder.id } };
      return { deck, data: { pageId: folder.id } };
    }
    case 'deck.setHome':
      mustPage(deck, op.pageId);
      deck.homePageId = op.pageId;
      return { deck };
    case 'deck.import': {
      const parsed = DeckSchema.safeParse(op.deck);
      if (!parsed.success) throw new OpError(`That file is not a valid deck:\n${z.prettifyError(parsed.error)}`);
      return { deck: parsed.data, backup: 'import' };
    }
    case 'deck.generateStarter': {
      if (ctx.obs.connection !== 'connected') throw new OpError('Connect to OBS first so the buttons can be generated');
      const onlyPage = deck.pages.length === 1 ? deck.pages[0] : undefined;
      if (onlyPage && Object.keys(onlyPage.buttons).length === 0) {
        // Fresh deck: fill the empty home page instead of adding a second one.
        deck.pages[0] = buildStarterPage(ctx.obs, ctx.newId, op.name ?? 'OBS', onlyPage.id);
        return { deck, data: { pageId: onlyPage.id } };
      }
      checkPageLimit(deck);
      const page = buildStarterPage(ctx.obs, ctx.newId, op.name ?? uniquePageName(deck, 'OBS'));
      deck.pages.push(page);
      return { deck, data: { pageId: page.id } };
    }
    case 'deck.undo': {
      const previous = ctx.history?.nextUndo() ?? fail('There is nothing to undo');
      return { deck: structuredClone(previous), history: 'undo' };
    }
    case 'deck.redo': {
      const next = ctx.history?.nextRedo() ?? fail('There is nothing to redo');
      return { deck: structuredClone(next), history: 'redo' };
    }
  }
}

function fail(message: string): never {
  throw new OpError(message);
}
