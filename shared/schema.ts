// Single source of truth for persisted data (deck, settings) and client→server messages.
// The server validates with these zod schemas; the browser only imports the inferred types.
import { z } from 'zod';
import { actionBehavior } from './actions-meta.ts';
import { DEFAULT_OBS_URL, ICON_NAME_RE, ICON_SETS, LIMITS, UPLOAD_NAME_RE, parseSlot } from './deck-utils.ts';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Invalid id');
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colors must look like #rrggbb');
const ObsName = z.string().trim().min(1).max(200);
const Label = z.string().max(80);
const PageName = z.string().trim().min(1).max(40);
const Rows = z.number().int().min(1).max(LIMITS.maxRows);
const Cols = z.number().int().min(1).max(LIMITS.maxCols);

/** Reference to an OBS scene/source/input. The uuid survives renames; the name is the fallback. */
export const ObsRefSchema = z.object({
  name: ObsName,
  uuid: z.string().max(64).optional(),
});

const Toggle3 = z.enum(['toggle', 'start', 'stop']);

// Header names are HTTP tokens; values must be one line of Latin-1 text (what fetch accepts).
const HeaderName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/, 'Header names are letters, digits and - (e.g. Authorization)');
const HeaderValue = z
  .string()
  .max(4000)
  .regex(/^[\t\x20-\x7e\x80-\xff]*$/, 'Header values must be one line of plain text');

/** Everything a button can do except macros and page navigation; these can also be macro steps. */
const StepActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('obs.scene'),
    scene: ObsRefSchema,
    target: z.enum(['auto', 'program', 'preview']).default('auto'),
  }),
  z.object({
    type: z.literal('obs.sceneItem'),
    scene: ObsRefSchema,
    source: ObsRefSchema,
    mode: z.enum(['toggle', 'show', 'hide']).default('toggle'),
  }),
  z.object({
    type: z.literal('obs.mute'),
    input: ObsRefSchema,
    mode: z.enum(['toggle', 'mute', 'unmute', 'pushToTalk', 'pushToMute']).default('toggle'),
  }),
  z.object({ type: z.literal('obs.volume'), input: ObsRefSchema }),
  z.object({ type: z.literal('obs.volumeStep'), input: ObsRefSchema, db: z.number().min(-30).max(30) }),
  z.object({ type: z.literal('obs.stream'), mode: Toggle3.default('toggle') }),
  z.object({
    type: z.literal('obs.record'),
    mode: z.enum(['toggle', 'start', 'stop', 'pause', 'split', 'chapter']).default('toggle'),
  }),
  z.object({ type: z.literal('obs.replay'), mode: z.enum(['toggle', 'start', 'stop', 'save']).default('toggle') }),
  z.object({ type: z.literal('obs.virtualCam'), mode: Toggle3.default('toggle') }),
  z.object({ type: z.literal('obs.studioMode'), mode: z.enum(['toggle', 'on', 'off']).default('toggle') }),
  z.object({
    type: z.literal('obs.transition'),
    transition: z.string().max(200).optional(),
    durationMs: z.number().int().min(0).max(20000).optional(),
  }),
  z.object({
    type: z.literal('obs.filter'),
    source: ObsRefSchema,
    filter: ObsName,
    mode: z.enum(['toggle', 'enable', 'disable']).default('toggle'),
  }),
  z.object({ type: z.literal('obs.screenshot'), source: ObsRefSchema.optional() }),
  z.object({ type: z.literal('obs.collection'), name: ObsName }),
  z.object({ type: z.literal('obs.profile'), name: ObsName }),
  z.object({ type: z.literal('obs.hotkey'), name: ObsName }),
  z.object({
    type: z.literal('obs.media'),
    input: ObsRefSchema,
    action: z.enum(['playPause', 'play', 'pause', 'restart', 'stop', 'next', 'previous']),
  }),
  z.object({
    type: z.literal('http.request'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    url: z.url({ protocol: /^https?$/, message: 'Use an http:// or https:// URL' }).max(2000),
    headers: z
      .record(HeaderName, HeaderValue)
      .refine((h) => Object.keys(h).length <= 20, 'At most 20 headers')
      .optional(),
    body: z.string().max(20_000).optional(),
    timeoutMs: z.number().int().min(500).max(60_000).optional(),
  }),
  z.object({
    type: z.literal('media.player'),
    command: z.enum(['playPause', 'next', 'previous', 'stop']).default('playPause'),
    /** playerctl player name (e.g. "spotify"); empty = whichever player was active last. */
    player: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/, 'Player names are letters, digits, dots, - and _ (e.g. spotify)')
      .optional(),
    /** Show the song's title and cover art on the button. */
    nowPlaying: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('system.volume'),
    target: z.enum(['output', 'input']).default('output'),
    mode: z.enum(['toggleMute', 'mute', 'unmute', 'step', 'fader']).default('toggleMute'),
    /** Percentage points per press in step mode (negative lowers the volume). */
    step: z.number().int().min(-50).max(50).optional(),
  }),
  z.object({
    type: z.literal('system.command'),
    /** Run with `sh -c` in the home folder. */
    command: z.string().trim().min(1).max(4000),
    /** Start it and don't wait (for apps that keep running). */
    detached: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  }),
]);

export const MAX_MACRO_STEPS = 20;

const MacroStepSchema = z.union([
  z.object({ action: StepActionSchema }),
  z.object({ delayMs: z.number().int().min(0).max(60_000) }),
]);

export const ActionSchema = z.discriminatedUnion('type', [
  ...StepActionSchema.options,
  z.object({
    type: z.literal('macro'),
    steps: z
      .array(MacroStepSchema)
      .min(1, 'Add at least one step')
      .max(MAX_MACRO_STEPS)
      .superRefine((steps, ctx) => {
        steps.forEach((step, i) => {
          if ('action' in step && actionBehavior(step.action) !== 'press') {
            ctx.addIssue({ code: 'custom', message: `Step ${i + 1}: push-to-talk and faders can’t be macro steps`, path: [i] });
          }
        });
      }),
    /** Skip the remaining steps after one fails (otherwise keep going and report at the end). */
    stopOnError: z.boolean().default(true),
  }),
  // Navigation actions never reach the server's executors; the browser handles them.
  z.object({ type: z.literal('deck.page'), pageId: Id }),
  z.object({ type: z.literal('deck.back') }),
]);

export const IconRefSchema = z.union([
  z.object({ set: z.enum(ICON_SETS), name: z.string().regex(ICON_NAME_RE).max(80) }),
  z.object({ upload: z.string().regex(UPLOAD_NAME_RE) }),
  z.object({ emoji: z.string().min(1).max(16) }),
]);

export const AppearanceSchema = z.object({
  label: Label.optional(),
  icon: IconRefSchema.optional(),
  bg: Color.optional(),
  fg: Color.optional(),
});

export const ButtonSchema = z.object({
  id: Id,
  label: Label.optional(),
  icon: IconRefSchema.optional(),
  bg: Color.optional(),
  fg: Color.optional(),
  hideLabel: z.boolean().optional(),
  /** Overrides used while the button's state is "active" (live, muted, visible, …). */
  active: AppearanceSchema.optional(),
  tap: ActionSchema.optional(),
  longPress: ActionSchema.optional(),
  /** Require a second tap within a short window before firing. */
  confirm: z.boolean().optional(),
});

export const SlotKeySchema = z.string().regex(/^\d{1,2}-\d{1,2}$/, 'Invalid slot');

export const PageSchema = z.object({
  id: Id,
  name: PageName,
  rows: Rows,
  cols: Cols,
  buttons: z.record(SlotKeySchema, ButtonSchema).default({}),
});

export const DeckSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().min(0).default(0),
    homePageId: Id,
    pages: z.array(PageSchema).min(1).max(LIMITS.maxPages),
  })
  .superRefine((deck, ctx) => {
    const pageIds = new Set<string>();
    const buttonIds = new Set<string>();
    deck.pages.forEach((page, pi) => {
      if (pageIds.has(page.id)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate page id "${page.id}"`, path: ['pages', pi, 'id'] });
      }
      pageIds.add(page.id);
      for (const [slot, button] of Object.entries(page.buttons)) {
        const [row, col] = parseSlot(slot);
        if (row >= page.rows || col >= page.cols) {
          ctx.addIssue({
            code: 'custom',
            message: `Button at ${slot} is outside the ${page.rows}×${page.cols} grid of "${page.name}"`,
            path: ['pages', pi, 'buttons', slot],
          });
        }
        if (buttonIds.has(button.id)) {
          ctx.addIssue({ code: 'custom', message: `Duplicate button id "${button.id}"`, path: ['pages', pi, 'buttons', slot, 'id'] });
        }
        buttonIds.add(button.id);
      }
    });
    if (!pageIds.has(deck.homePageId)) {
      ctx.addIssue({ code: 'custom', message: 'homePageId does not match any page', path: ['homePageId'] });
    }
  });

export const SettingsSchema = z.object({
  obs: z
    .object({
      url: z.string().default(DEFAULT_OBS_URL),
      password: z.string().default(''),
    })
    .default({ url: DEFAULT_OBS_URL, password: '' }),
  accessKey: z.string().min(16),
});

// ---- client → server messages -------------------------------------------------------------

const Slot = SlotKeySchema;
const ReqId = z.number().int().min(0);
const NewButtonSchema = ButtonSchema.extend({ id: Id.optional() });
export const ObsUrlSchema = z.string().trim().regex(/^wss?:\/\/[^\s/]+/, 'Use a ws:// or wss:// URL').max(300);

export const DeckOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('page.add'), name: PageName, rows: Rows, cols: Cols, afterPageId: Id.optional() }),
  z.object({ op: z.literal('page.update'), pageId: Id, name: PageName.optional(), rows: Rows.optional(), cols: Cols.optional() }),
  z.object({ op: z.literal('page.delete'), pageId: Id }),
  z.object({ op: z.literal('page.move'), pageId: Id, toIndex: z.number().int().min(0) }),
  z.object({ op: z.literal('button.set'), pageId: Id, slot: Slot, button: NewButtonSchema.nullable() }),
  z.object({
    op: z.literal('button.move'),
    from: z.object({ pageId: Id, slot: Slot }),
    to: z.object({ pageId: Id, slot: Slot.optional() }),
  }),
  z.object({ op: z.literal('button.duplicate'), pageId: Id, slot: Slot }),
  z.object({ op: z.literal('folder.create'), pageId: Id, slot: Slot, name: PageName }),
  z.object({ op: z.literal('deck.setHome'), pageId: Id }),
  z.object({ op: z.literal('deck.import'), deck: z.unknown() }),
  z.object({ op: z.literal('deck.generateStarter'), name: PageName.optional() }),
]);

export const ClientMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), key: z.string().max(200) }),
  z.object({ t: z.literal('press'), pageId: Id, buttonId: Id, which: z.enum(['tap', 'longPress']) }),
  z.object({ t: z.literal('hold'), pageId: Id, buttonId: Id, down: z.boolean() }),
  z.object({ t: z.literal('fader'), pageId: Id, buttonId: Id, pos: z.number().min(0).max(1) }),
  z.object({ t: z.literal('op'), reqId: ReqId, op: DeckOpSchema }),
  z.object({ t: z.literal('query'), reqId: ReqId, q: z.enum(['hotkeys', 'mediaPlayers']) }),
  z.object({ t: z.literal('settings'), reqId: ReqId, action: z.enum(['get', 'rotateKey', 'reconnectObs']) }),
  z.object({ t: z.literal('settings.obs'), reqId: ReqId, url: ObsUrlSchema, password: z.string().max(200).optional() }),
  z.object({ t: z.literal('meters'), inputs: z.array(z.string().max(200)).max(64) }),
]);

export type ObsRef = z.infer<typeof ObsRefSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type StepAction = z.infer<typeof StepActionSchema>;
export type MacroStep = z.infer<typeof MacroStepSchema>;
export type ActionType = Action['type'];
export type ActionOf<T extends ActionType> = Extract<Action, { type: T }>;
export type IconRef = z.infer<typeof IconRefSchema>;
export type Appearance = z.infer<typeof AppearanceSchema>;
export type Button = z.infer<typeof ButtonSchema>;
export type NewButton = z.infer<typeof NewButtonSchema>;
export type Page = z.infer<typeof PageSchema>;
export type Deck = z.infer<typeof DeckSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type DeckOp = z.infer<typeof DeckOpSchema>;
export type ClientMsg = z.infer<typeof ClientMsgSchema>;
