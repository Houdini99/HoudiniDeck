// One persistent connection to obs-websocket v5, shared by every browser.
import { EventEmitter } from 'node:events';
import OBSWebSocket, { EventSubscription, OBSWebSocketError } from 'obs-websocket-js/json';
import type { ObsState } from '../../shared/obs-types.ts';
import { errorMessage, type Logger } from '../log.ts';
import { MIRRORED_EVENTS, ObsStateStore } from './state.ts';

const RETRY_DELAYS_MS = [1000, 2000, 3000, 5000];
const AUTH_RETRY_MS = 30_000;
const POLL_MS = 2000;
const METER_INTERVAL_MS = 66;

const CLOSE_AUTH_FAILED = 4009;
const CLOSE_UNSUPPORTED_RPC = 4010;

export interface BridgeOptions {
  url: string;
  password: string;
  log: Logger;
}

type MeterEvent = { inputs: { inputName: string; inputLevelsMul: number[][] }[] };

export class ObsBridge extends EventEmitter<{ meters: [levels: Record<string, number>] }> {
  readonly store = new ObsStateStore();
  readonly client = new OBSWebSocket();
  private url: string;
  private password: string;
  private readonly log: Logger;
  private running = false;
  private connecting = false;
  private closingOnPurpose = false;
  private attempt = 0;
  private lastError?: string;
  private retryTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private clientCount = 0;
  private metersWanted = false;
  private lastMeterAt = 0;

  constructor(opts: BridgeOptions) {
    super();
    this.url = opts.url;
    this.password = opts.password;
    this.log = opts.log;
    for (const type of MIRRORED_EVENTS) {
      this.client.on(type, ((data: Record<string, unknown>) => {
        this.store.handleEvent(this.client, type, data).catch((err) => this.log.debug(`Refresh after ${type} failed: ${errorMessage(err)}`));
      }) as never);
    }
    this.client.on('ConnectionClosed', (err) => this.onClosed(err));
    this.client.on('ExitStarted', () => this.log.info('OBS is shutting down'));
    this.client.on('InputVolumeMeters', (data) => this.onMeters(data as unknown as MeterEvent));
  }

  get state(): ObsState {
    return this.store.state;
  }

  get connected(): boolean {
    return this.store.state.connection === 'connected';
  }

  start(): void {
    this.running = true;
    this.store.reset('connecting', { url: this.url });
    void this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.retryTimer);
    this.stopPolling();
    this.closingOnPurpose = true;
    await this.client.disconnect().catch(() => {});
    this.closingOnPurpose = false;
  }

  /** Apply new connection settings and reconnect right away. */
  async configure(url: string, password: string): Promise<void> {
    this.url = url;
    this.password = password;
    await this.reconnectNow();
  }

  async reconnectNow(): Promise<void> {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.attempt = 0;
    this.lastError = undefined;
    this.stopPolling();
    this.closingOnPurpose = true;
    await this.client.disconnect().catch(() => {});
    this.closingOnPurpose = false;
    if (!this.running) return;
    this.store.reset('connecting', { url: this.url });
    void this.connect();
  }

  /** Polling (stats, output timers) only runs while at least one browser is connected. */
  setClientCount(count: number): void {
    this.clientCount = count;
    this.updatePolling();
  }

  /** Audio level meters are a high-volume event; subscribe only while a fader is on screen. */
  setMetersWanted(wanted: boolean): void {
    if (wanted === this.metersWanted) return;
    this.metersWanted = wanted;
    if (this.connected) {
      this.client.reidentify({ eventSubscriptions: this.subscriptions() }).catch((err) => {
        this.log.debug(`Could not update event subscriptions: ${errorMessage(err)}`);
      });
    }
  }

  private subscriptions(): number {
    return EventSubscription.All | (this.metersWanted ? EventSubscription.InputVolumeMeters : 0);
  }

  private async connect(): Promise<void> {
    if (!this.running || this.connecting) return;
    this.connecting = true;
    try {
      const hello = await this.client.connect(this.url, this.password || undefined, {
        rpcVersion: 1,
        eventSubscriptions: this.subscriptions(),
      });
      await this.store.resync(this.client);
      this.store.setConnection('connected');
      this.attempt = 0;
      this.lastError = undefined;
      const s = this.store.state;
      const audio = Object.values(s.inputs).filter((i) => i.audio).map((i) => i.name);
      this.log.info(`Connected to OBS ${s.version?.obs ?? '?'} (obs-websocket ${hello.obsWebSocketVersion}) at ${this.url}`);
      this.log.info(`Scenes: ${s.scenes.map((x) => x.name).join(', ') || '(none)'}`);
      this.log.info(`Audio inputs: ${audio.join(', ') || '(none)'}`);
      this.updatePolling();
    } catch (err) {
      this.onConnectFailed(err);
    } finally {
      this.connecting = false;
    }
  }

  private onConnectFailed(err: unknown): void {
    const code = err instanceof OBSWebSocketError ? err.code : undefined;
    // Leave the socket closed before retrying (a failed resync can leave it open).
    this.closingOnPurpose = true;
    void this.client.disconnect().catch(() => {}).finally(() => (this.closingOnPurpose = false));
    if (code === CLOSE_AUTH_FAILED) {
      const message = 'OBS rejected the password. Copy it from OBS (Tools → WebSocket Server Settings → Show Connect Info) into Settings.';
      this.report(message, 'warn');
      this.setDown('auth-failed', message);
      this.scheduleRetry(AUTH_RETRY_MS);
      return;
    }
    // 4000–4999 are obs-websocket's own close codes; anything else is a network-level failure.
    const obsClosed = code !== undefined && code >= 4000 && code < 5000;
    const message =
      code === CLOSE_UNSUPPORTED_RPC
        ? 'This OBS version is too old; obs-websocket 5 (OBS 28+) is required.'
        : obsClosed
          ? `OBS closed the connection: ${errorMessage(err) || `code ${code}`}`
          : `Can't reach OBS at ${this.url}. Is OBS running with its WebSocket server enabled?`;
    this.report(message, 'info');
    this.setDown('disconnected', message);
    this.scheduleRetry(RETRY_DELAYS_MS[Math.min(this.attempt, RETRY_DELAYS_MS.length - 1)]);
    this.attempt++;
  }

  private onClosed(err: OBSWebSocketError): void {
    if (this.connecting || this.closingOnPurpose || !this.running) return; // connect() handles its own failures
    if (this.store.state.connection !== 'connected') return;
    this.stopPolling();
    const message = `Lost connection to OBS${err.message ? ` (${err.message})` : ''}. Reconnecting…`;
    this.log.warn(message);
    this.lastError = message;
    this.store.reset('disconnected', { url: this.url, error: message });
    this.attempt = 0;
    this.scheduleRetry(RETRY_DELAYS_MS[0]);
  }

  /** Mark OBS as unavailable; skips the broadcast when nothing changed since the last retry. */
  private setDown(connection: 'disconnected' | 'auth-failed', error: string): void {
    const s = this.store.state;
    if (s.connection === connection && s.error === error && s.url === this.url) return;
    this.store.reset(connection, { url: this.url, error });
  }

  /** Log connection problems once, not on every retry. */
  private report(message: string, level: 'info' | 'warn'): void {
    if (message === this.lastError) return;
    this.lastError = message;
    this.log[level](message);
  }

  private scheduleRetry(delay: number): void {
    if (!this.running || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, delay);
  }

  private updatePolling(): void {
    const shouldPoll = this.connected && this.clientCount > 0;
    if (shouldPoll && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        this.store.poll(this.client).catch((err) => this.log.debug(`Poll failed: ${errorMessage(err)}`));
      }, POLL_MS);
    } else if (!shouldPoll) {
      this.stopPolling();
    }
  }

  private stopPolling(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private onMeters(data: MeterEvent): void {
    const now = Date.now();
    if (now - this.lastMeterAt < METER_INTERVAL_MS) return;
    this.lastMeterAt = now;
    const levels: Record<string, number> = {};
    for (const input of data.inputs ?? []) {
      // Each channel is [magnitude, peak, inputPeak]; show the loudest channel's peak.
      levels[input.inputName] = Math.max(0, ...(input.inputLevelsMul ?? []).map((ch) => ch[1] ?? 0));
    }
    this.emit('meters', levels);
  }
}
