// WebSocket hub: authenticates browsers, fans out deck/OBS state, and routes their requests.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { CLOSE, PROTOCOL_VERSION, type ServerInfo, type ServerMsg, type SettingsView } from '../shared/protocol.ts';
import { ClientMsgSchema, DeckSchema, type DeckOp } from '../shared/schema.ts';
import type { Dispatcher } from './actions/dispatch.ts';
import { isTrustedLocal, keyMatches, originAllowed } from './auth.ts';
import { OpError, applyOp } from './deck/ops.ts';
import type { Env } from './env.ts';
import { errorMessage, type Logger } from './log.ts';
import { pairingUrl } from './network.ts';
import type { ObsBridge } from './obs/bridge.ts';
import { ActionError } from './obs/execute.ts';
import { newId, type DeckStore } from './store/deck-store.ts';
import { newAccessKey, type SettingsStore } from './store/settings-store.ts';

const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 15_000;
const OBS_BROADCAST_DEBOUNCE_MS = 30;

interface Client {
  id: string;
  ws: WebSocket;
  authed: boolean;
  trustedLocal: boolean;
  alive: boolean;
  meters: Set<string>;
  authTimer?: NodeJS.Timeout;
}

export interface HubDeps {
  env: Env;
  deckStore: DeckStore;
  settingsStore: SettingsStore;
  bridge: ObsBridge;
  dispatcher: Dispatcher;
  buildId: string;
  info: () => ServerInfo;
  log: Logger;
}

/** Errors whose message is safe and useful to show in the browser. */
const isUserError = (err: unknown) => err instanceof ActionError || err instanceof OpError;

export class Hub {
  private readonly clients = new Map<string, Client>();
  private opQueue: Promise<void> = Promise.resolve();
  private obsTimer?: NodeJS.Timeout;
  private readonly pingTimer: NodeJS.Timeout;
  private readonly deps: HubDeps;

  constructor(deps: HubDeps) {
    this.deps = deps;
    deps.bridge.store.on('change', () => this.scheduleObsBroadcast());
    deps.bridge.on('meters', (levels) => this.sendMeters(levels));
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
  }

  register(app: FastifyInstance): void {
    app.get(
      '/ws',
      {
        websocket: true,
        preValidation: async (req, reply) => {
          if (!originAllowed(req.headers.origin, req.headers.host)) {
            this.deps.log.warn(`Rejected WebSocket from origin ${req.headers.origin} (host ${req.headers.host})`);
            return reply.code(403).send({ error: 'Origin not allowed' });
          }
        },
      },
      (socket, req) => this.accept(socket, req.socket.remoteAddress, req.headers.host),
    );
  }

  get connectedCount(): number {
    return [...this.clients.values()].filter((c) => c.authed).length;
  }

  private accept(ws: WebSocket, remoteAddress: string | undefined, host: string | undefined): void {
    const client: Client = {
      id: randomUUID(),
      ws,
      authed: false,
      trustedLocal: isTrustedLocal(remoteAddress, host),
      alive: true,
      meters: new Set(),
    };
    this.clients.set(client.id, client);
    ws.on('pong', () => (client.alive = true));
    ws.on('message', (raw, isBinary) => {
      if (!isBinary) void this.onMessage(client, raw.toString());
    });
    ws.on('close', () => this.onClose(client));
    ws.on('error', (err) => this.deps.log.debug(`WebSocket error: ${err.message}`));

    this.send(client, { t: 'hello', protocol: PROTOCOL_VERSION, needsAuth: !client.trustedLocal });
    if (client.trustedLocal) {
      this.authenticate(client);
    } else {
      client.authTimer = setTimeout(() => {
        if (client.authed) return;
        this.send(client, { t: 'authError', reason: 'timeout' });
        ws.close(CLOSE.authFailed, 'auth timeout');
      }, AUTH_TIMEOUT_MS);
    }
  }

  private authenticate(client: Client): void {
    client.authed = true;
    clearTimeout(client.authTimer);
    const { deckStore, bridge, buildId, info } = this.deps;
    this.send(client, {
      t: 'init',
      buildId,
      serverTime: Date.now(),
      deck: deckStore.deck,
      obs: bridge.state,
      info: info(),
    });
    this.updateBridgeInterest();
  }

  private async onMessage(client: Client, text: string): Promise<void> {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = ClientMsgSchema.safeParse(data);
    if (!parsed.success) {
      const reqId = (data as { reqId?: unknown } | null)?.reqId;
      if (client.authed && typeof reqId === 'number') {
        this.send(client, { t: 'result', reqId, ok: false, error: `Invalid request:\n${z.prettifyError(parsed.error)}` });
      }
      return;
    }
    const msg = parsed.data;

    if (!client.authed) {
      if (msg.t !== 'auth') return;
      if (keyMatches(msg.key, this.deps.settingsStore.settings.accessKey)) {
        this.authenticate(client);
      } else {
        this.send(client, { t: 'authError', reason: 'bad-key' });
        client.ws.close(CLOSE.authFailed, 'bad key');
      }
      return;
    }

    const { dispatcher } = this.deps;
    switch (msg.t) {
      case 'auth':
        return;
      case 'press':
        return this.runAction(client, msg.buttonId, () => dispatcher.press(msg.pageId, msg.buttonId, msg.which));
      case 'hold':
        return this.runAction(client, msg.buttonId, () => dispatcher.hold(client.id, msg.pageId, msg.buttonId, msg.down));
      case 'fader':
        return this.runAction(client, msg.buttonId, () => dispatcher.fader(msg.pageId, msg.buttonId, msg.pos));
      case 'op':
        return this.handleOp(client, msg.reqId, msg.op);
      case 'query':
        return this.reply(client, msg.reqId, () => this.query(msg.q));
      case 'settings':
        return this.reply(client, msg.reqId, () => this.settingsAction(client, msg.action));
      case 'settings.obs':
        return this.reply(client, msg.reqId, () => this.setObs(client, msg.url, msg.password));
      case 'meters':
        client.meters = new Set(msg.inputs);
        this.updateBridgeInterest();
        return;
    }
  }

  private async runAction(client: Client, buttonId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (!isUserError(err)) this.deps.log.error('Action failed:', err);
      this.send(client, { t: 'toast', level: 'error', text: isUserError(err) ? errorMessage(err) : 'Something went wrong', buttonId });
    }
  }

  private async reply(client: Client, reqId: number, fn: () => Promise<unknown>): Promise<void> {
    try {
      const data = await fn();
      this.send(client, { t: 'result', reqId, ok: true, data });
    } catch (err) {
      if (!isUserError(err)) this.deps.log.error('Request failed:', err);
      this.send(client, { t: 'result', reqId, ok: false, error: isUserError(err) ? errorMessage(err) : 'Something went wrong' });
    }
  }

  /** Deck edits run strictly one after another, each validated and saved before the next. */
  private handleOp(client: Client, reqId: number, op: DeckOp): Promise<void> {
    const run = async () => {
      const { deckStore, bridge } = this.deps;
      const result = applyOp(deckStore.deck, op, { obs: bridge.state, newId });
      const valid = DeckSchema.safeParse(result.deck);
      if (!valid.success) throw new OpError(`That change would make the deck invalid:\n${z.prettifyError(valid.error)}`);
      await deckStore.replace(valid.data, { backupReason: result.backup });
      this.broadcast({ t: 'deck', deck: deckStore.deck });
      return result.data;
    };
    const next = this.opQueue.then(() => this.reply(client, reqId, run));
    this.opQueue = next;
    return next;
  }

  private async query(q: 'hotkeys'): Promise<unknown> {
    const { bridge } = this.deps;
    if (!bridge.connected) throw new ActionError('OBS is not connected');
    switch (q) {
      case 'hotkeys': {
        const { hotkeys } = await bridge.client.call('GetHotkeyList');
        return { hotkeys };
      }
    }
  }

  private async settingsView(): Promise<SettingsView> {
    const { settingsStore, env } = this.deps;
    const obs = settingsStore.obsConfig(env);
    const url = pairingUrl(env.publicPort, settingsStore.settings.accessKey);
    return {
      obs: { url: obs.url, hasPassword: obs.password !== '', fromEnv: obs.fromEnv },
      pairing: { url, qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1 }) },
    };
  }

  private async settingsAction(client: Client, action: 'get' | 'rotateKey' | 'reconnectObs'): Promise<unknown> {
    const { settingsStore, bridge, log } = this.deps;
    switch (action) {
      case 'get':
        return this.settingsView();
      case 'reconnectObs':
        await bridge.reconnectNow();
        return {};
      case 'rotateKey': {
        const key = newAccessKey();
        await settingsStore.update((s) => (s.accessKey = key));
        log.warn('Access key rotated; other paired devices must pair again');
        for (const other of this.clients.values()) {
          if (other === client || other.trustedLocal || !other.authed) continue;
          this.send(other, { t: 'authError', reason: 'key-rotated' });
          other.ws.close(CLOSE.authFailed, 'key rotated');
        }
        return { key, ...(await this.settingsView()) };
      }
    }
  }

  private async setObs(client: Client, url: string, password: string | undefined): Promise<SettingsView> {
    const { settingsStore, bridge, env, log } = this.deps;
    if (settingsStore.obsConfig(env).fromEnv) {
      throw new OpError('The OBS connection is set by OBS_URL/OBS_PASSWORD on the server. Change it there (e.g. in .env).');
    }
    await settingsStore.update((s) => {
      // Never answer a different host's auth challenge with the saved password: a new address
      // needs the password entered again.
      if (password !== undefined) s.obs.password = password;
      else if (url !== s.obs.url) s.obs.password = '';
      s.obs.url = url;
    });
    log.info(`OBS connection changed to ${url} (from ${client.trustedLocal ? 'this PC' : 'a paired device'})`);
    const obs = settingsStore.obsConfig(env);
    await bridge.configure(obs.url, obs.password);
    return this.settingsView();
  }

  private send(client: Client, msg: ServerMsg): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMsg): void {
    const text = JSON.stringify(msg);
    for (const client of this.clients.values()) {
      if (client.authed && client.ws.readyState === client.ws.OPEN) client.ws.send(text);
    }
  }

  private scheduleObsBroadcast(): void {
    if (this.obsTimer) return;
    this.obsTimer = setTimeout(() => {
      this.obsTimer = undefined;
      this.broadcast({ t: 'obs', obs: this.deps.bridge.state, serverTime: Date.now() });
    }, OBS_BROADCAST_DEBOUNCE_MS);
  }

  private sendMeters(levels: Record<string, number>): void {
    for (const client of this.clients.values()) {
      if (!client.authed || client.meters.size === 0) continue;
      const subset: Record<string, number> = {};
      for (const name of client.meters) if (name in levels) subset[name] = levels[name];
      this.send(client, { t: 'meters', levels: subset });
    }
  }

  private updateBridgeInterest(): void {
    const authed = [...this.clients.values()].filter((c) => c.authed);
    this.deps.bridge.setClientCount(authed.length);
    this.deps.bridge.setMetersWanted(authed.some((c) => c.meters.size > 0));
  }

  private onClose(client: Client): void {
    clearTimeout(client.authTimer);
    this.clients.delete(client.id);
    void this.deps.dispatcher.releaseAll(client.id);
    this.updateBridgeInterest();
  }

  private pingAll(): void {
    for (const client of this.clients.values()) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }

  close(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.obsTimer);
    for (const client of this.clients.values()) client.ws.close(CLOSE.serverRestart, 'server restarting');
  }
}
