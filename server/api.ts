// Pressing deck buttons from other programs (Streamer.bot, Home Assistant, a script, a hotkey tool):
// POST /api/buttons/<id>/press with the access key as a Bearer token. It works like a tap on a paired
// device: only buttons that are on the deck, never raw actions.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { actionAutoLabel, actionBehavior, type LabelCtx } from '../shared/actions-meta.ts';
import type { Deck } from '../shared/schema.ts';
import type { Dispatcher } from './actions/dispatch.ts';
import { ActionError } from './actions/executor.ts';
import { bearerKey, isTrustedLocal, keyMatches, originAllowed } from './auth.ts';
import type { Logger } from './log.ts';
import type { SettingsStore } from './store/settings-store.ts';

export interface ButtonApiDeps {
  getDeck: () => Deck;
  dispatcher: Pick<Dispatcher, 'press'>;
  settingsStore: Pick<SettingsStore, 'settings'>;
  /** For the buttons' automatic labels in the list. */
  labelCtx: () => LabelCtx;
  log: Logger;
}

/** One entry of GET /api/buttons. */
export interface ApiButton {
  id: string;
  page: string;
  pageId: string;
  slot: string;
  label: string;
  /** The tap and long-press action types, e.g. "obs.scene". */
  tap?: string;
  longPress?: string;
}

/** Like the WebSocket: other websites are refused, and anything but this PC's own browser needs the key. */
function refuse(req: FastifyRequest, reply: FastifyReply, key: string): FastifyReply | undefined {
  const { host, origin, authorization } = req.headers;
  if (!originAllowed(origin, host)) return reply.code(403).send({ error: 'Other websites may not press buttons' });
  if (!isTrustedLocal(req.socket.remoteAddress, host) && !keyMatches(bearerKey(authorization), key)) {
    return reply.code(401).send({ error: 'Send the access key as the header "Authorization: Bearer <key>" (Settings → Pair a phone or tablet)' });
  }
  return undefined;
}

export async function registerButtonApi(root: FastifyInstance, deps: ButtonApiDeps): Promise<void> {
  await root.register(async (app) => routes(app, deps));
}

function routes(app: FastifyInstance, deps: ButtonApiDeps): void {
  // Other programs may send any body (or an empty one labelled JSON); a press doesn't read it.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, _payload, done) => done(null, undefined));

  app.get('/api/buttons', async (req, reply) => {
    if (refuse(req, reply, deps.settingsStore.settings.accessKey)) return reply;
    const ctx = deps.labelCtx();
    const buttons: ApiButton[] = deps.getDeck().pages.flatMap((page) =>
      Object.entries(page.buttons).map(([slot, b]) => {
        const shown = b.tap ?? b.longPress;
        return {
          id: b.id,
          page: page.name,
          pageId: page.id,
          slot,
          label: b.label || (shown ? actionAutoLabel(shown, ctx) : ''),
          tap: b.tap?.type,
          longPress: b.longPress?.type,
        };
      }),
    );
    return { buttons };
  });

  app.post<{ Params: { id: string }; Querystring: { which?: string } }>('/api/buttons/:id/press', async (req, reply) => {
    if (refuse(req, reply, deps.settingsStore.settings.accessKey)) return reply;
    const which = req.query.which ?? 'tap';
    if (which !== 'tap' && which !== 'longPress') return reply.code(400).send({ error: 'which must be tap or longPress' });
    const page = deps.getDeck().pages.find((p) => Object.values(p.buttons).some((b) => b.id === req.params.id));
    const button = page && Object.values(page.buttons).find((b) => b.id === req.params.id);
    if (!page || !button) return reply.code(404).send({ error: 'There is no button with that id' });
    const action = button[which];
    if (!action) return reply.code(400).send({ error: `That button has no ${which === 'tap' ? '' : 'long-press '}action` });
    const behavior = actionBehavior(action);
    if (behavior !== 'press') {
      const why = { hold: 'it has to be held', fader: 'it is a fader', nav: 'page navigation happens on each device', display: 'it only shows something' };
      return reply.code(400).send({ error: `That button can’t be pressed from another app: ${why[behavior]}` });
    }
    try {
      await deps.dispatcher.press(page.id, button.id, which);
    } catch (err) {
      if (err instanceof ActionError) return reply.code(422).send({ error: err.message });
      deps.log.error('Button press through the API failed:', err);
      return reply.code(500).send({ error: 'Something went wrong (the deck’s log says what)' });
    }
    return { ok: true };
  });
}
