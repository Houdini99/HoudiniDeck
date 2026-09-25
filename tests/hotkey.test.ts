// Keyboard Shortcut buttons: key codes, the ydotool commands, holding, and failures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dispatcher } from '../server/actions/dispatch.ts';
import { ActionError, type ExecutorRegistry } from '../server/actions/executor.ts';
import { systemExecutor } from '../server/actions/system.ts';
import { silentLogger } from '../server/log.ts';
import type { RunResult, Runner } from '../server/system/process.ts';
import { pasteText } from '../server/system/text.ts';
import { actionAutoLabel } from '../shared/actions-meta.ts';
import { KEYS, keyFromDom, shortcutLabel, ydotoolKeyArgs } from '../shared/keys.ts';
import { ActionSchema, type ActionOf, type Deck } from '../shared/schema.ts';

type Hotkey = ActionOf<'system.hotkey'>;
const ctrlM: Hotkey = { type: 'system.hotkey', keys: ['KEY_LEFTCTRL', 'KEY_M'] };

test('key names, labels and codes (as in linux/input-event-codes.h)', () => {
  assert.equal(KEYS.KEY_LEFTCTRL.code, 29);
  assert.equal(KEYS.KEY_M.code, 50);
  assert.equal(KEYS.KEY_Z.code, 44);
  assert.equal(KEYS.KEY_0.code, 11);
  assert.equal(KEYS.KEY_F13.code, 183);
  assert.equal(KEYS.KEY_KP7.code, 71);
  assert.equal(shortcutLabel(['KEY_LEFTCTRL', 'KEY_LEFTSHIFT', 'KEY_F13']), 'Ctrl+Shift+F13');
  assert.equal(keyFromDom('KeyM'), 'KEY_M');
  assert.equal(keyFromDom('ControlLeft'), 'KEY_LEFTCTRL');
  assert.equal(keyFromDom('OSLeft'), 'KEY_LEFTMETA');
  assert.equal(keyFromDom('NumpadEnter'), 'KEY_KPENTER');
  assert.equal(keyFromDom('Fn'), undefined);
  assert.equal(actionAutoLabel(ctrlM, {}), 'Ctrl+M');
});

test('keys are pressed in order and released in reverse', () => {
  assert.deepEqual(ydotoolKeyArgs(ctrlM.keys), ['29:1', '50:1', '50:0', '29:0']);
  assert.deepEqual(ydotoolKeyArgs(ctrlM.keys, 'down'), ['29:1', '50:1']);
  assert.deepEqual(ydotoolKeyArgs(ctrlM.keys, 'up'), ['50:0', '29:0']);
});

function setup(answer: RunResult | 'missing' = { code: 0, stdout: '', stderr: '' }) {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (answer === 'missing') throw Object.assign(new Error('spawn ydotool ENOENT'), { code: 'ENOENT' });
    return answer;
  };
  const execute = systemExecutor({ run, audio: { refresh: async () => {} }, commandsEnabled: false });
  return { calls, execute };
}

test('a tap sends the whole shortcut; a hold button presses on down and releases on up', async () => {
  const { calls, execute } = setup();
  await execute(ctrlM, { kind: 'press' });
  await execute({ ...ctrlM, hold: true }, { kind: 'hold', down: true });
  await execute({ ...ctrlM, hold: true }, { kind: 'hold', down: false });
  assert.deepEqual(calls, [
    ['ydotool', 'key', '29:1', '50:1', '50:0', '29:0'],
    ['ydotool', 'key', '29:1', '50:1'],
    ['ydotool', 'key', '50:0', '29:0'],
  ]);
});

test('held keys are released when the device that holds them disconnects', async () => {
  const { calls, execute } = setup();
  const deck: Deck = {
    version: 1,
    revision: 0,
    homePageId: 'p',
    pages: [{ id: 'p', name: 'P', rows: 1, cols: 1, buttons: { '0-0': { id: 'ptt', tap: { ...ctrlM, hold: true } } } }],
  };
  const unused = async () => {};
  const executors = {
    system: execute,
    obs: unused,
    http: unused,
    media: unused,
    sound: unused,
    kde: unused,
    macro: unused,
    toggle: unused,
    counter: unused,
    timer: unused,
    clock: unused,
    deck: unused,
  } as ExecutorRegistry;
  const dispatcher = new Dispatcher({ executors, getDeck: () => deck, log: silentLogger });
  await dispatcher.hold('tablet', 'p', 'ptt', true);
  await dispatcher.releaseAll('tablet');
  assert.deepEqual(
    calls.map((c) => c.slice(2)),
    [
      ['29:1', '50:1'],
      ['50:0', '29:0'],
    ],
  );
});

test('failures explain what to do', async () => {
  await assert.rejects(setup('missing').execute(ctrlM, { kind: 'press' }), /ydotool is not installed/);
  const noDaemon = setup({
    code: 2,
    stdout: "failed to connect socket `/run/user/1000/.ydotool_socket': No such file or directory\nPlease check if ydotoold is running.\n",
    stderr: '',
  });
  await assert.rejects(
    noDaemon.execute(ctrlM, { kind: 'press' }),
    (err: Error) => err instanceof ActionError && /systemctl --user enable --now ydotool/.test(err.message),
  );
  await assert.rejects(setup({ code: 1, stdout: '', stderr: 'something odd\n' }).execute(ctrlM, { kind: 'press' }), /ydotool: something odd/);
});

test('the schema knows the keys, and held shortcuts can’t be macro steps', () => {
  assert.equal(ActionSchema.safeParse(ctrlM).success, true);
  assert.equal(ActionSchema.safeParse({ type: 'system.hotkey', keys: [] }).success, false);
  assert.equal(ActionSchema.safeParse({ type: 'system.hotkey', keys: ['KEY_NOPE'] }).success, false);
  assert.equal(ActionSchema.safeParse({ type: 'macro', steps: [{ action: ctrlM }] }).success, true);
  assert.equal(ActionSchema.safeParse({ type: 'macro', steps: [{ action: { ...ctrlM, hold: true } }] }).success, false);
});

test('Type Text on Linux: the text goes on the clipboard, then Ctrl+V (and Enter) through ydotool', async () => {
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: '', stderr: '' };
  };
  const launched: string[][] = [];
  const launch = async (cmd: string, args: string[]) => {
    launched.push([cmd, ...args]);
    return 0;
  };
  const sleep = async () => {};
  await pasteText('Grüße -- “hi” 🎉', true, { run, launch, sleep });
  assert.deepEqual(launched, [['wl-copy', '--', 'Grüße -- “hi” 🎉']], 'the text is one argument, after --');
  assert.deepEqual(calls, [['ydotool', 'key', '29:1', '47:1', '47:0', '29:0', '28:1', '28:0']]);

  // Without wl-clipboard, KDE's clipboard (Klipper) takes the text over D-Bus.
  calls.length = 0;
  const enoent = Object.assign(new Error('spawn wl-copy ENOENT'), { code: 'ENOENT' });
  await pasteText('x', false, { run, launch: async () => Promise.reject(enoent), sleep });
  assert.deepEqual(calls[0], ['busctl', '--user', 'call', 'org.kde.klipper', '/klipper', 'org.kde.klipper.klipper', 'setClipboardContents', 's', 'x']);
  assert.deepEqual(calls[1], ['ydotool', 'key', '29:1', '47:1', '47:0', '29:0']);

  const noClipboard = async (cmd: string) => (cmd === 'busctl' ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) : { code: 0, stdout: '', stderr: '' });
  await assert.rejects(pasteText('x', false, { run: noClipboard, launch: async () => 1, sleep }), /Install wl-clipboard/);
});

test('Type Text on Windows goes to the helper as text', async () => {
  const requests: { op: string; args: Record<string, unknown> }[] = [];
  const helper = {
    async request<T>(op: string, args: Record<string, unknown> = {}) {
      requests.push({ op, args });
      return null as T;
    },
  };
  const execute = systemExecutor({ run: async () => assert.fail('no Linux programs'), audio: { refresh: async () => {} }, commandsEnabled: false, windows: helper });
  await execute({ type: 'system.text', text: 'GG ✌️', enter: true }, { kind: 'press' });
  assert.deepEqual(requests, [{ op: 'text', args: { text: 'GG ✌️', enter: true } }]);
});
