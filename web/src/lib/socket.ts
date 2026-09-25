import { CLOSE, type ClientMsg, type ServerMsg } from '$shared/protocol.ts';

type Status = 'connecting' | 'open' | 'closed';
type WithoutReqId<T> = T extends unknown ? Omit<T, 'reqId'> : never;
export type RequestMsg = WithoutReqId<Extract<ClientMsg, { reqId: number }>>;
export type FireMsg = Exclude<ClientMsg, { reqId: number }>;

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_MS = [500, 1000, 2000, 3000, 5000];

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** WebSocket to the deck server with auth, request/response matching and automatic reconnects. */
export class DeckSocket {
  onMessage: (msg: ServerMsg) => void = () => {};
  onStatus: (status: Status) => void = () => {};
  /** The server wants a key and this device doesn't have one. */
  onNeedsKey: () => void = () => {};

  private ws?: WebSocket;
  private reqId = 0;
  private pending = new Map<number, Pending>();
  private attempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private authed = false;
  private readonly getKey: () => string | null;

  constructor(getKey: () => string | null) {
    this.getKey = getKey;
  }

  connect(): void {
    this.stopped = false;
    clearTimeout(this.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    this.authed = false;
    this.onStatus('connecting');

    ws.onmessage = (event) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (msg.t === 'hello' && msg.needsAuth) {
        const key = this.getKey();
        if (!key) {
          this.stopped = true;
          ws.close();
          this.onNeedsKey();
          return;
        }
        this.sendRaw({ t: 'auth', key });
      } else if (msg.t === 'init') {
        this.authed = true;
        this.attempt = 0;
        this.onStatus('open');
      } else if (msg.t === 'result') {
        const p = this.pending.get(msg.reqId);
        if (p) {
          this.pending.delete(msg.reqId);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.data);
          else p.reject(new Error(msg.error));
        }
      }
      this.onMessage(msg);
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.authed = false;
      this.onStatus('closed');
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Connection lost'));
        this.pending.delete(id);
      }
      if (this.stopped || event.code === CLOSE.authFailed) return;
      const delay = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)];
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  reconnect(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = undefined;
    this.attempt = 0;
    this.connect();
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  get isOpen(): boolean {
    return this.authed && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Fire-and-forget. Returns false when not connected (nothing is queued). */
  send(msg: FireMsg): boolean {
    if (!this.isOpen) return false;
    this.sendRaw(msg);
    return true;
  }

  request<T = unknown>(msg: RequestMsg): Promise<T> {
    if (!this.isOpen) return Promise.reject(new Error('Not connected to the deck server'));
    const reqId = ++this.reqId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('The server did not answer in time'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve: resolve as (d: unknown) => void, reject, timer });
      this.sendRaw({ ...msg, reqId } as ClientMsg);
    });
  }

  private sendRaw(msg: ClientMsg): void {
    this.ws?.send(JSON.stringify(msg));
  }
}
