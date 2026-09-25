import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { LabelCtx } from '../shared/actions-meta.ts';
import type { Deck } from '../shared/schema.ts';
import type { Dispatcher } from './actions/dispatch.ts';
import { registerButtonApi } from './api.ts';
import type { Env } from './env.ts';
import type { Hub } from './hub.ts';
import { registerIconRoutes } from './icons.ts';
import type { Logger } from './log.ts';
import type { ObsBridge } from './obs/bridge.ts';
import type { SettingsStore } from './store/settings-store.ts';
import { registerMediaRoutes, type MediaSource } from './system/media.ts';
import { MAX_UPLOAD_BYTES, registerUploadRoutes } from './uploads.ts';

export interface HttpDeps {
  env: Env;
  hub: Hub;
  bridge: ObsBridge;
  media: MediaSource;
  settingsStore: SettingsStore;
  /** For pressing buttons through the HTTP API. */
  dispatcher: Pick<Dispatcher, 'press'>;
  getDeck: () => Deck;
  labelCtx: () => LabelCtx;
  log: Logger;
}

const API_PREFIXES = ['/api/', '/icons/', '/uploads/', '/ws'];

export async function createHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  const { env, hub, bridge, media, settingsStore, log } = deps;
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) log.error(`${req.method} ${req.url} failed:`, err);
    reply.code(status).send({ error: status >= 500 ? 'Internal error' : err.message });
  });

  // A deck import can be a few MB of JSON.
  await app.register(fastifyWebsocket, { options: { maxPayload: 8 * 1024 * 1024 } });
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 } });

  hub.register(app);
  registerIconRoutes(app);
  registerUploadRoutes(app, { dataDir: env.dataDir, settingsStore });
  registerMediaRoutes(app, media);
  await registerButtonApi(app, { getDeck: deps.getDeck, dispatcher: deps.dispatcher, settingsStore, labelCtx: deps.labelCtx, log });
  app.get('/api/health', async () => ({ ok: true, obs: bridge.state.connection, clients: hub.connectedCount }));

  if (existsSync(join(env.webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: env.webDist,
      cacheControl: false,
      setHeaders(res, path) {
        // Vite fingerprints everything under assets/, so those can be cached forever.
        res.header('cache-control', path.includes(join('dist', 'assets')) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !API_PREFIXES.some((p) => req.url.startsWith(p))) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html')
        .send(
          '<!doctype html><meta charset="utf-8"><title>Virtual Stream Deck</title><body style="font:16px system-ui;padding:2rem">' +
            '<h1>Virtual Stream Deck</h1><p>The web UI has not been built yet. Run <code>npm run build</code>, ' +
            'or use <code>npm run dev</code> and open port 5173.</p>',
        ),
    );
  }

  return app;
}
