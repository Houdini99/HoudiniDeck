// App-wide state: what the server pushed (deck, OBS and other state) plus this device's UI state.
import { emptyExtState, type ExtState } from '$shared/ext-types.ts';
import type { VisualCtx } from '$shared/feedback.ts';
import type { ObsState } from '$shared/obs-types.ts';
import type { ServerInfo, ServerMsg, ToastLevel } from '$shared/protocol.ts';
import type { Deck, DeckOp, Page } from '$shared/schema.ts';
import { clearKey, getKey, setKey } from './key.ts';
import { prefs } from './prefs.svelte.ts';
import { DeckSocket, type RequestMsg } from './socket.ts';

export type PairingReason = 'needed' | 'bad-key' | 'key-rotated';

export interface Toast {
  id: number;
  level: ToastLevel;
  text: string;
}

let toastId = 0;

class Store {
  conn = $state<'connecting' | 'open' | 'closed'>('connecting');
  /** Set while this device has to be paired before it can connect. */
  pairing = $state<PairingReason | null>(null);
  deck = $state.raw<Deck | null>(null);
  obs = $state.raw<ObsState | null>(null);
  /** Media players and other state from outside OBS. */
  ext = $state.raw<ExtState>(emptyExtState());
  info = $state.raw<ServerInfo | null>(null);
  meters = $state.raw<Record<string, number>>({});
  /** Current time on the server's clock; ticks every second for output timers. */
  now = $state(Date.now());
  toasts = $state<Toast[]>([]);
  /** buttonId → time of the last failed press (the button flashes red). */
  flashes = $state<Record<string, number>>({});

  pageId = $state('');
  backStack = $state<string[]>([]);
  editMode = $state(false);
  settingsOpen = $state(false);
  pagesOpen = $state(false);
  editing = $state<{ pageId: string; slot: string } | null>(null);
  dragOverPage = $state<string | null>(null);

  /** Everything a button needs to work out how it looks (only valid once deck and obs are set). */
  visualCtx: VisualCtx = $derived({ obs: this.obs!, deck: this.deck!, ext: this.ext, now: this.now });

  currentPage: Page | undefined = $derived.by(() => {
    const deck = this.deck;
    if (!deck) return undefined;
    const byId = (id: string) => (id ? deck.pages.find((p) => p.id === id) : undefined);
    return byId(this.pageId) ?? byId(deck.homePageId) ?? deck.pages[0];
  });

  private readonly socket = new DeckSocket(getKey);
  private clockOffset = 0;
  private buildId: string | null = null;
  private meterRefs = new Map<string, number>();
  private meterTimer?: ReturnType<typeof setTimeout>;
  private tick?: ReturnType<typeof setInterval>;

  start(): void {
    this.socket.onMessage = (msg) => this.handle(msg);
    this.socket.onStatus = (status) => (this.conn = status);
    this.socket.onNeedsKey = () => (this.pairing = 'needed');
    this.socket.connect();
    this.tick = setInterval(() => (this.now = Date.now() + this.clockOffset), 1000);
  }

  stop(): void {
    clearInterval(this.tick);
    this.socket.close();
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'init':
        // A tablet left open across a server update reloads to pick up the new UI.
        if (this.buildId && msg.buildId !== this.buildId && msg.buildId !== 'dev') {
          location.reload();
          return;
        }
        this.buildId = msg.buildId;
        this.syncClock(msg.serverTime);
        this.deck = msg.deck;
        this.obs = msg.obs;
        this.ext = msg.ext;
        this.info = msg.info;
        this.pairing = null;
        if (!this.pageId) this.pageId = prefs.startPage || prefs.lastPage;
        this.flushMeters();
        break;
      case 'deck':
        this.deck = msg.deck;
        break;
      case 'obs':
        this.syncClock(msg.serverTime);
        this.obs = msg.obs;
        break;
      case 'ext':
        this.ext = msg.ext;
        break;
      case 'meters':
        this.meters = msg.levels;
        break;
      case 'toast':
        this.toast(msg.text, msg.level);
        if (msg.buttonId) this.flashes[msg.buttonId] = Date.now();
        break;
      case 'authError':
        if (msg.reason !== 'timeout') clearKey();
        this.pairing = msg.reason === 'timeout' ? 'needed' : msg.reason;
        break;
    }
  }

  private syncClock(serverTime: number): void {
    this.clockOffset = serverTime - Date.now();
    this.now = serverTime;
  }

  // ---- talking to the server --------------------------------------------------------------

  press(pageId: string, buttonId: string, which: 'tap' | 'longPress'): void {
    if (!this.socket.send({ t: 'press', pageId, buttonId, which })) this.toast('Not connected to the deck server', 'error');
  }

  hold(pageId: string, buttonId: string, down: boolean): void {
    this.socket.send({ t: 'hold', pageId, buttonId, down });
  }

  fader(pageId: string, buttonId: string, pos: number): void {
    this.socket.send({ t: 'fader', pageId, buttonId, pos });
  }

  request<T = unknown>(msg: RequestMsg): Promise<T> {
    return this.socket.request<T>(msg);
  }

  /** Apply a deck edit. Errors are shown as a toast and re-thrown. */
  async op<T = Record<string, unknown> | undefined>(op: DeckOp): Promise<T> {
    try {
      return await this.socket.request<T>({ t: 'op', op });
    } catch (err) {
      this.toast((err as Error).message, 'error');
      throw err;
    }
  }

  pairWith(key: string): void {
    setKey(key);
    this.pairing = null;
    this.socket.reconnect();
  }

  // ---- meters: faders on screen subscribe to their input's level ---------------------------

  subscribeMeter(input: string): () => void {
    this.meterRefs.set(input, (this.meterRefs.get(input) ?? 0) + 1);
    this.scheduleMeters();
    return () => {
      const n = (this.meterRefs.get(input) ?? 1) - 1;
      if (n <= 0) this.meterRefs.delete(input);
      else this.meterRefs.set(input, n);
      this.scheduleMeters();
    };
  }

  private scheduleMeters(): void {
    clearTimeout(this.meterTimer);
    this.meterTimer = setTimeout(() => this.flushMeters(), 50);
  }

  private flushMeters(): void {
    this.socket.send({ t: 'meters', inputs: [...this.meterRefs.keys()] });
  }

  // ---- navigation (per device) ---------------------------------------------------------------

  /** Open a page from a folder button; Back returns here. */
  goTo(pageId: string): void {
    const current = this.currentPage?.id;
    if (current && current !== pageId) this.backStack.push(current);
    this.show(pageId);
  }

  /** Switch pages from the tab bar (resets the Back history). */
  selectPage(pageId: string): void {
    this.backStack = [];
    this.show(pageId);
  }

  back(): void {
    const target = this.backStack.pop() ?? this.deck?.homePageId;
    if (target) this.show(target);
  }

  private show(pageId: string): void {
    this.pageId = pageId;
    prefs.lastPage = pageId;
  }

  // ---- toasts -------------------------------------------------------------------------------

  toast(text: string, level: ToastLevel = 'info'): void {
    const id = ++toastId;
    this.toasts.push({ id, level, text });
    setTimeout(() => this.dismiss(id), level === 'error' ? 5000 : 3000);
  }

  dismiss(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }
}

export const store = new Store();
