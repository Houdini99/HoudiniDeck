// Turns button presses into actions. The browser only names a button; the action comes from the
// saved deck, so a client can never run something that isn't on the deck.
import { OBSWebSocketError } from 'obs-websocket-js/json';
import { actionBehavior } from '../../shared/actions-meta.ts';
import { findButton } from '../../shared/deck-utils.ts';
import { resolveInput } from '../../shared/obs-resolve.ts';
import type { Action, Button, Deck } from '../../shared/schema.ts';
import { errorMessage, type Logger } from '../log.ts';
import type { ObsBridge } from '../obs/bridge.ts';
import { ActionError, executeObsAction, type ObsAction, type Phase } from '../obs/execute.ts';

export interface DispatcherDeps {
  bridge: ObsBridge;
  getDeck: () => Deck;
  log: Logger;
  screenshotDir: string;
}

export class Dispatcher {
  /** Buttons currently held down, per client, so they can be released if the client vanishes. */
  private holds = new Map<string, Map<string, Action>>();
  /** Latest fader position per input while a volume change is in flight (older ones are dropped). */
  private faderPending = new Map<string, number>();
  private faderBusy = new Set<string>();

  private readonly deps: DispatcherDeps;

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
  }

  async press(pageId: string, buttonId: string, which: 'tap' | 'longPress'): Promise<void> {
    const action = this.lookup(pageId, buttonId)[which];
    if (!action) throw new ActionError('This button has no action');
    await this.run(action, { kind: 'press' });
  }

  async hold(clientId: string, pageId: string, buttonId: string, down: boolean): Promise<void> {
    if (!down) {
      const action = this.holds.get(clientId)?.get(buttonId);
      if (!action) return;
      this.holds.get(clientId)!.delete(buttonId);
      await this.run(action, { kind: 'hold', down: false });
      return;
    }
    const action = this.lookup(pageId, buttonId).tap;
    if (!action || actionBehavior(action) !== 'hold') throw new ActionError('This button is not a hold button');
    const held = this.holds.get(clientId) ?? new Map<string, Action>();
    this.holds.set(clientId, held);
    if (held.has(buttonId)) return;
    held.set(buttonId, action); // registered first, so a failed press still gets its release
    await this.run(action, { kind: 'hold', down: true });
  }

  /** Release everything a client was holding (it disconnected mid-press, e.g. push-to-talk). */
  async releaseAll(clientId: string): Promise<void> {
    const held = this.holds.get(clientId);
    if (!held) return;
    this.holds.delete(clientId);
    for (const action of held.values()) {
      try {
        await this.run(action, { kind: 'hold', down: false });
      } catch (err) {
        this.deps.log.warn(`Could not release a held button: ${errorMessage(err)}`);
      }
    }
  }

  async fader(pageId: string, buttonId: string, pos: number): Promise<void> {
    const action = this.lookup(pageId, buttonId).tap;
    if (action?.type !== 'obs.volume') throw new ActionError('This button is not a fader');
    const key = resolveInput(this.deps.bridge.state, action.input)?.name ?? action.input.name;
    this.faderPending.set(key, pos);
    if (this.faderBusy.has(key)) return;
    this.faderBusy.add(key);
    try {
      while (this.faderPending.has(key)) {
        const next = this.faderPending.get(key)!;
        this.faderPending.delete(key);
        await this.run(action, { kind: 'fader', pos: next });
      }
    } finally {
      this.faderBusy.delete(key);
    }
  }

  private lookup(pageId: string, buttonId: string): Button {
    const hit = findButton(this.deps.getDeck(), pageId, buttonId);
    if (!hit) throw new ActionError('That button no longer exists. The deck may have been edited elsewhere.');
    return hit.button;
  }

  private async run(action: Action, phase: Phase): Promise<void> {
    if (!action.type.startsWith('obs.')) return; // navigation actions are handled by the browser
    const { bridge, screenshotDir } = this.deps;
    if (!bridge.connected) throw new ActionError('OBS is not connected');
    try {
      await executeObsAction(bridge.client, bridge.state, action as ObsAction, phase, { screenshotDir });
    } catch (err) {
      if (err instanceof OBSWebSocketError) throw new ActionError(`OBS: ${err.message || `error ${err.code}`}`);
      throw err;
    }
  }
}
