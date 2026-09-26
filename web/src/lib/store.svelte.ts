// App-wide state: what the server pushed (deck, OBS and other state) plus this device's UI state.
import { emptyExtState, type ExtState, type StatMetric } from '$shared/ext-types.ts';
import type { VisualCtx } from '$shared/feedback.ts';
import type { ObsState } from '$shared/obs-types.ts';
import type { HistoryInfo, ServerInfo, ServerMsg, ToastLevel } from '$shared/protocol.ts';
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

/** Reference-counted interest in data the server only sends while something on screen needs it. */
class Interest<K> {
  private readonly refs = new Map<K, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly send: (keys: K[]) => void;

  constructor(send: (keys: K[]) => void) {
    this.send = send;
  }

  /** Returns the matching unsubscribe. */
  add(key: K): () => void {
    this.refs.set(key, (this.refs.get(key) ?? 0) + 1);
    this.schedule();
    return () => {
      const n = (this.refs.get(key) ?? 1) - 1;
      if (n <= 0) this.refs.delete(key);
      else this.refs.set(key, n);
      this.schedule();
    };
  }

  /** Send the current set now (e.g. after reconnecting). */
  flush(): void {
    clearTimeout(this.timer);
    this.send([...this.refs.keys()]);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 50);
  }
}

class Store {
  conn = $state<'connecting' | 'open' | 'closed'>('connecting');
  /** Set while this device has to be paired before it can connect. */
  pairing = $state<PairingReason | null>(null);
  deck = $state.raw<Deck | null>(null);
  /** What Undo/Redo would take back or bring back. */
  history = $state.raw<HistoryInfo>({});
  obs = $state.raw<ObsState | null>(null);
  /** Media players and other state from outside OBS. */
  ext = $state.raw<ExtState>(emptyExtState());
  info = $state.raw<ServerInfo | null>(null);
  meters = $state.raw<Record<string, number>>({});
  /** Live pictures of the scenes that scene buttons on screen show (data: URLs by scene name). */
  thumbs = $state.raw<Record<string, string>>({});
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
  visualCtx: VisualCtx = $derived({
    obs: this.obs!,
    deck: this.deck!,
    ext: this.ext,
    now: this.now,
    commands: this.info?.commands,
    platform: this.info?.platform,
    thumbs: this.thumbs,
  });

  currentPage: Page | undefined = $derived.by(() => {
    const deck = this.deck;
    if (!deck) return undefined;
    const byId = (id: string) => (id ? deck.pages.find((p) => p.id === id) : undefined);
    return byId(this.pageId) ?? byId(deck.homePageId) ?? deck.pages[0];
  });

  private readonly socket = new DeckSocket(getKey);
  private clockOffset = 0;
  private buildId: string | null = null;
  private readonly meterInterest = new Interest<string>((inputs) => this.socket.send({ t: 'meters', inputs }));
  private readonly statInterest = new Interest<StatMetric>((metrics) => this.socket.send({ t: 'stats', metrics }));
  // The server takes up to 32 scenes; more live pictures than that on one screen would be unusual.
  private readonly thumbInterest = new Interest<string>((scenes) => this.socket.send({ t: 'thumbs', scenes: scenes.slice(0, 32) }));
  private tick?: ReturnType<typeof setTimeout>;

  start(): void {
    this.socket.onMessage = (msg) => this.handle(msg);
    this.socket.onStatus = (status) => (this.conn = status);
    this.socket.onNeedsKey = () => (this.pairing = 'needed');
    this.socket.connect();
    this.ticking();
  }

  /** Ticks just after each full second of the server's clock, so clocks and timers change in step. */
  private ticking(): void {
    const now = Date.now() + this.clockOffset;
    this.now = now;
    this.tick = setTimeout(() => this.ticking(), 1000 - (now % 1000) + 5);
  }

  stop(): void {
    clearTimeout(this.tick);
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
        this.history = msg.history;
        this.obs = msg.obs;
        this.ext = msg.ext;
        this.info = msg.info;
        this.pairing = null;
        if (!this.pageId) this.pageId = prefs.startPage || prefs.lastPage;
        this.meterInterest.flush();
        this.statInterest.flush();
        this.thumbInterest.flush();
        break;
      case 'deck':
        this.deck = msg.deck;
        this.history = msg.history;
        break;
      case 'info':
        this.info = msg.info;
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
      case 'thumbs':
        this.thumbs = { ...this.thumbs, ...msg.images };
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

  // ---- what's on screen: faders subscribe to their input's level, stats tiles to their metric,
  // scene buttons with a live picture to their scene ----

  subscribeMeter(input: string): () => void {
    return this.meterInterest.add(input);
  }

  subscribeStat(metric: StatMetric): () => void {
    return this.statInterest.add(metric);
  }

  subscribeThumb(scene: string): () => void {
    return this.thumbInterest.add(scene);
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

  /** The next or previous page in tab order, wrapping around (Back returns from there). */
  stepPage(direction: 'next' | 'previous'): void {
    const pages = this.deck?.pages ?? [];
    const index = pages.findIndex((p) => p.id === this.currentPage?.id);
    if (pages.length < 2 || index < 0) return;
    this.goTo(pages[(index + (direction === 'next' ? 1 : -1) + pages.length) % pages.length].id);
  }

  /** Undo or redo the last deck edit (anyone's). */
  async undo(redo = false): Promise<void> {
    const label = redo ? this.history.redo : this.history.undo;
    if (!label) return;
    try {
      await this.op({ op: redo ? 'deck.redo' : 'deck.undo' });
      this.toast(`${redo ? 'Redone' : 'Undone'}: ${label}`);
    } catch {
      // shown as a toast
    }
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
